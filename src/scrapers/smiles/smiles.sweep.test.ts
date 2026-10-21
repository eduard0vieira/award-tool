import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import type { Page } from "playwright";
import { FIXTURES_DIR } from "../../core/paths.ts";

process.env.SMILES_SEARCH_INTERVAL_MS = "1";
process.env.SMILES_PARALLEL = "1";
process.env.SMILES_BLOCK_RECHECK_MS = "30";
process.env.SMILES_MAX_BLOCK_WAIT_MS = "200";
process.env.SMILES_SEARCH_TIMEOUT_MS = "20";
process.env.SMILES_TRANSIENT_RETRY_MS = "1";
const { searchSmilesYear } = await import("./smiles.scraper.ts");

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
const partnerDay = { status: 200, text: fixture("smiles-real-congener.json") };
const blocked = { status: 406, text: fixture("smiles-406-budget.json") };
const serverError = { status: 500, text: "{}" };
const backendCrash = { status: 452, text: fixture("smiles-452-flightlist.json") };

type Reply = { status: number; text: string } | "hang";

// Answers each search call from `script(callNumber, date)`.
function fakePage(script: (call: number, date: string) => Reply) {
  let calls = 0;
  const asked: string[] = [];
  const page = {
    evaluate: async (_fn: unknown, { url }: { url: string }) => {
      const date = new URL(url).searchParams.get("departureDate")!;
      asked.push(date);
      const reply = script(++calls, date);
      return reply === "hang" ? new Promise(() => {}) : reply;
    },
    goto: async () => ({ status: () => 403 }),
    waitForTimeout: async () => {},
    context: () => ({ clearCookies: async () => {} }),
  };
  return { page: page as unknown as Page, asked };
}

function tomorrowPlus(days: number): string {
  const date = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1 + days);
  return date.toISOString().slice(0, 10);
}

const tenDays = { from: tomorrowPlus(0), until: tomorrowPlus(9) };

describe("Smiles sweep on a route without calendar", () => {
  test("waits out a 406 and resumes on the same day", async () => {
    const { page, asked } = fakePage((call) => (call === 4 || call === 5 ? blocked : partnerDay));
    const logs: string[] = [];

    const result = await searchSmilesYear(page, { origin: "AAA", destination: "BBB" }, {}, (m) => logs.push(m), () => {}, () => false, tenDays);

    assert.equal(result.days.length, 10);
    assert.deepEqual(result.failedDays, []);
    assert.deepEqual(result.gaps, []);
    assert.equal(asked[3], asked[4]);
    assert.equal(asked[4], asked[5]);
    assert.ok(logs.some((m) => m.includes("(406). Esperando")));
  });

  test("retries a day their backend crashed on", async () => {
    const { page, asked } = fakePage((call) => (call === 3 || call === 4 ? backendCrash : partnerDay));

    const result = await searchSmilesYear(page, { origin: "KKK", destination: "LLL" }, {}, () => {}, () => {}, () => false, tenDays);

    assert.equal(result.days.length, 10);
    assert.deepEqual(result.failedDays, []);
    assert.equal(asked[2], asked[4]);
  });

  test("stops the day-by-day fill after consecutive failures", async () => {
    const { page, asked } = fakePage((call) => (call <= 2 ? partnerDay : serverError));

    const result = await searchSmilesYear(page, { origin: "CCC", destination: "DDD" }, {}, () => {}, () => {}, () => false, tenDays);

    assert.equal(result.failedDays.length, 3);
    assert.equal(asked.length, 5);
    assert.ok(result.gaps.some((gap) => gap.includes("parou cedo: 5 dia(s)")));
  });

  test("turns a call that never answers into a failed day", async () => {
    const { page } = fakePage((call) => (call <= 2 ? partnerDay : "hang"));

    const result = await searchSmilesYear(page, { origin: "III", destination: "JJJ" }, {}, () => {}, () => {}, () => false, tenDays);

    assert.equal(result.failedDays.length, 3);
    assert.match(result.failedDays[0]!.error, /não respondeu/);
  });

  test("reports a cancel during the block wait as a cancel", async () => {
    let stop = false;
    const { page } = fakePage((call) => {
      if (call >= 3) {
        stop = true;
        return blocked;
      }
      return partnerDay;
    });

    const result = await searchSmilesYear(page, { origin: "EEE", destination: "FFF" }, {}, () => {}, () => {}, () => stop, tenDays);

    assert.equal(result.gaps.length, 1);
    assert.match(result.gaps[0]!, /cancelada durante a espera do bloqueio/);
  });

  test("gives up on a block that outlasts the wait limit", async () => {
    const { page } = fakePage((call) => (call <= 2 ? partnerDay : blocked));

    const result = await searchSmilesYear(page, { origin: "GGG", destination: "HHH" }, {}, () => {}, () => {}, () => false, tenDays);

    assert.equal(result.days.length, 2);
    assert.deepEqual(result.failedDays, []);
    assert.equal(result.gaps.length, 1);
    assert.match(result.gaps[0]!, /bloqueio por IP do Smiles não passou/);
  });
});

describe("Smiles sweep with two calls in flight", () => {
  // Answers after a few ms, counting how many calls are open at once.
  function slowPage(script: (call: number) => { status: number; text: string }) {
    let calls = 0;
    let open = 0;
    let mostOpen = 0;
    const asked: string[] = [];
    const page = {
      evaluate: async (_fn: unknown, { url }: { url: string }) => {
        asked.push(new URL(url).searchParams.get("departureDate")!);
        const reply = script(++calls);
        mostOpen = Math.max(mostOpen, ++open);
        await new Promise((resolve) => setTimeout(resolve, 15));
        open--;
        return reply;
      },
      goto: async () => ({ status: () => 403 }),
      waitForTimeout: async () => {},
      context: () => ({ clearCookies: async () => {} }),
    };
    return { page: page as unknown as Page, asked, mostOpen: () => mostOpen };
  }

  test("asks every day once, never more than two at a time", async () => {
    process.env.SMILES_PARALLEL = "2";
    try {
      const { page, asked, mostOpen } = slowPage(() => partnerDay);
      const result = await searchSmilesYear(page, { origin: "MMM", destination: "NNN" }, {}, () => {}, () => {}, () => false, tenDays);
      assert.equal(result.days.length, 10);
      assert.deepEqual(result.failedDays, []);
      assert.equal(new Set(asked).size, 10);
      assert.equal(asked.length, 10);
      assert.equal(mostOpen(), 2);
    } finally {
      process.env.SMILES_PARALLEL = "1";
    }
  });

  test("both calls wait out the same 406 and the sweep resumes", async () => {
    process.env.SMILES_PARALLEL = "2";
    try {
      const { page } = slowPage((call) => (call === 4 || call === 5 ? blocked : partnerDay));
      const result = await searchSmilesYear(page, { origin: "OOO", destination: "PPP" }, {}, () => {}, () => {}, () => false, tenDays);
      assert.equal(result.days.length, 10);
      assert.deepEqual(result.gaps, []);
    } finally {
      process.env.SMILES_PARALLEL = "1";
    }
  });
});

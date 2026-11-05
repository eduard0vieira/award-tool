import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import type { Page } from "playwright";
import { FIXTURES_DIR } from "../../core/paths.ts";

process.env.IBERIA_SEARCH_INTERVAL_MS = "1";
const { detailDays } = await import("./iberia.scraper.ts");

const dayWithFlights = fs.readFileSync(path.join(FIXTURES_DIR, "iberia-availability-ib-direct.json"), "utf8");
const route = { origin: "GRU", destination: "MAD", passengers: 1 };
const dates = Array.from({ length: 30 }, (_, index) => `2027-01-${String(index + 1).padStart(2, "0")}`);

type Load = { blocked?: boolean; ownStatus?: number; refuseAfter?: number };

// The results page as the detail sees it: each real load asks `/availability`
// for the date in its URL with the member token, and the script's own calls
// come back 200 until the load's allowance runs out, then never answer.
function fakeSite(loadAt: (load: number) => Load) {
  let url = "about:blank";
  let loads = 0;
  let scriptCallsThisLoad = 0;
  let current: Load = {};
  const ownAnswers: string[] = [];
  const scriptAsked: string[] = [];
  let onRequest: (request: unknown) => void = () => {};
  let pendingOwn: ((response: unknown) => void) | null = null;

  const page = {
    url: () => url,
    on: (event: string, handler: (request: unknown) => void) => {
      if (event === "request") onRequest = handler;
    },
    waitForTimeout: async () => {},
    bringToFront: async () => {},
    goto: async (target: string) => {
      if (target === "about:blank") {
        url = target;
        return;
      }
      loads++;
      scriptCallsThisLoad = 0;
      current = loadAt(loads);
      const query = new URL(target).searchParams;
      const date = `${query.get("BEGIN_YEAR_01")}-${query.get("BEGIN_MONTH_01")!.slice(4)}-${query.get("BEGIN_DAY_01")}`;
      url = target.replace("#!/availability", current.blocked ? "#!/ibbkerror" : "#!/availability");
      if (current.blocked) return;
      onRequest({
        url: () => "https://ibisservices.iberia.com/api/sse-rpa/rs/v1/availability",
        headers: () => ({ authorization: "Bearer member" }),
      });
      const status = current.ownStatus ?? 200;
      if (status === 200) ownAnswers.push(date);
      pendingOwn?.({
        url: () => "https://ibisservices.iberia.com/api/sse-rpa/rs/v1/availability",
        request: () => ({ method: () => "POST", postData: () => JSON.stringify({ slices: [{ date }] }) }),
        status: () => status,
        text: async () => dayWithFlights,
      });
    },
    waitForResponse: (predicate: (response: unknown) => boolean) =>
      new Promise((resolve, reject) => {
        pendingOwn = (response) => {
          pendingOwn = null;
          if (predicate(response)) resolve(response);
          else reject(new Error("not the page's own call"));
        };
        setTimeout(() => reject(new Error("timeout")), 200);
      }),
    evaluate: async (_fn: unknown, { body }: { body: { slices: { date: string }[] } }) => {
      scriptAsked.push(body.slices[0]!.date);
      scriptCallsThisLoad++;
      if (current.refuseAfter !== undefined && scriptCallsThisLoad > current.refuseAfter) {
        return { status: -1, text: "TypeError: Failed to fetch" };
      }
      return { status: 200, text: dayWithFlights };
    },
  };
  return { page: page as unknown as Page, ownAnswers, scriptAsked, loads: () => loads };
}

describe("Iberia flight detail", () => {
  test("reloads every few calls, uses the page's own call and stops at the first blocked load", async () => {
    const site = fakeSite((load) => (load >= 5 ? { blocked: true } : {}));

    const result = await detailDays(site.page, route, dates);

    // Four loads of one own answer and four script calls: twenty days, then the error screen.
    assert.equal(site.loads(), 5);
    assert.deepEqual(site.ownAnswers, ["2027-01-01", "2027-01-06", "2027-01-11", "2027-01-16"]);
    assert.equal(site.scriptAsked.length, 16);
    assert.ok(result.cut?.includes("tela de erro"));
    assert.deepEqual(
      result.failedDays.map((day) => day.date),
      dates.slice(20),
    );
  });

  test("fifteen days, the most a search may ask, take three loads and never reach the block", async () => {
    const site = fakeSite((load) => (load >= 4 ? { blocked: true } : {}));

    const result = await detailDays(site.page, route, dates.slice(0, 15));

    assert.equal(site.loads(), 3);
    assert.equal(result.cut, null);
    assert.deepEqual(result.failedDays, []);
  });

  test("a call refused mid-load is retried on the next load, losing no day", async () => {
    const site = fakeSite((load) => (load === 1 ? { refuseAfter: 2 } : load >= 4 ? { blocked: true } : {}));

    const result = await detailDays(site.page, route, dates.slice(0, 12));

    // The third script call of the first load fails; the second load opens on that same date.
    assert.deepEqual(site.ownAnswers.slice(0, 2), ["2027-01-01", "2027-01-04"]);
    assert.equal(site.scriptAsked[2], "2027-01-04");
    assert.equal(result.cut, null);
    assert.deepEqual(result.failedDays, []);
  });

  test("a day the page's own call did not bring is asked by the detail itself", async () => {
    const site = fakeSite((load) => (load === 1 ? { ownStatus: 500 } : {}));

    const result = await detailDays(site.page, route, dates.slice(0, 3));

    assert.deepEqual(site.scriptAsked, ["2027-01-01", "2027-01-02", "2027-01-03"]);
    assert.deepEqual(result.failedDays, []);
  });

  test("a load that brings nothing at all ends the detail as a cut", async () => {
    const site = fakeSite(() => ({ ownStatus: 500, refuseAfter: 0 }));

    const result = await detailDays(site.page, route, dates.slice(0, 5));

    assert.equal(site.loads(), 1);
    assert.match(result.cut!, /parou de responder ao detalhe depois de 0 dia/);
    assert.equal(result.failedDays.length, 5);
  });
});

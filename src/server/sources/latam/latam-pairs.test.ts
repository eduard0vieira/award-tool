import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PairConfirmation } from "../../../scrapers/latam/latam.scraper.ts";
import { validateBody } from "../../validation.ts";
import { LatamPairsSearchDto } from "./latam-pairs-search.dto.ts";
import { confirmedSection } from "./latam-pairs.source.ts";

const body = (pairs: unknown) => ({ origin: "gru", destination: "jfk", cabin: "Business", pairs });

describe("LATAM date pairs", () => {
  test("accepts business pairs and refuses a return before the outbound", async () => {
    const request = await validateBody(LatamPairsSearchDto, body([{ outbound: "2026-12-10", return: "2026-12-20" }]));
    assert.equal(request.origin, "GRU");
    await assert.rejects(validateBody(LatamPairsSearchDto, body([{ outbound: "2026-12-20", return: "2026-12-10" }])), /precisa ser depois da ida/);
    await assert.rejects(validateBody(LatamPairsSearchDto, body([{ outbound: "10/12/2026", return: "2026-12-20" }])), /AAAA-MM-DD/);
    const eleven = Array.from({ length: 11 }, () => ({ outbound: "2026-12-10", return: "2026-12-20" }));
    await assert.rejects(validateBody(LatamPairsSearchDto, body(eleven)), /no máximo 10/);
    await assert.rejects(validateBody(LatamPairsSearchDto, { ...body([{ outbound: "2026-12-10", return: "2026-12-20" }]), cabin: "First" }), /Economy ou Business/);
  });

  test("each direction lists its confirmed dates at that leg's points, the lowest when a date repeats", () => {
    const pair = (outboundDate: string, returnDate: string, outboundMiles: number | null, returnMiles: number | null) =>
      ({ outboundDate, returnDate, outboundMiles, returnMiles }) as PairConfirmation;
    const pairs = [pair("2026-12-10", "2026-12-20", 120000, 130000), pair("2026-12-10", "2026-12-22", 110000, null)];
    const outbound = confirmedSection(pairs, "outbound", { origin: "GRU", destination: "JFK" });
    assert.deepEqual(
      outbound.days.map((day) => [day.date, day.valueK]),
      [["2026-12-10", 110]],
    );
    const back = confirmedSection(pairs, "return", { origin: "JFK", destination: "GRU" });
    assert.deepEqual(back.days.map((day) => day.date), ["2026-12-20"]);
    assert.equal(back.text, "Dez 2026: 20");
  });
});

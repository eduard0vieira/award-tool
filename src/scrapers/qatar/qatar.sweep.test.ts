import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import type { Page } from "playwright";
import { FIXTURES_DIR } from "../../core/paths.ts";

process.env.QATAR_SEARCH_INTERVAL_MS = "1";
process.env.QATAR_LOGIN_WAIT_MINUTES = "1";
const { QatarLoginError, searchQatarYear } = await import("./qatar.scraper.ts");

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
const december = fixture("qatar-calendar-GRU-NRT-2026-12.json");
const august = fixture("qatar-calendar-GRU-NRT-2027-08.json");
const refused = fixture("qatar-calendar-400-business.json");
const noToken = fixture("qatar-calendar-401-no-token.json");
const route = { origin: "GRU", destination: "NRT" };

type Answer = { status: number; text: string };
type Site = {
  loggedIn: boolean;
  // How many waits on the login page before the person finishes logging in.
  loginAfterWaits?: number;
  answer: (month: string, call: number) => Answer;
};

// The calendar page as the scraper sees it: a logged-in load fires the page's
// own calendar POST; a logged-out one lands on the home page.
function fakeSite(site: Site) {
  let url = "about:blank";
  let loginWaits = 0;
  const handlers = new Set<(request: unknown) => void>();
  const gotos: string[] = [];
  const asked: { month: string; headers: Record<string, string>; body: { cabinClass: string; itineraries: { departureDate: string }[] } }[] = [];

  const firePageCall = () => {
    const request = {
      url: () => "https://www.qatarairways.com/dapi/public/bff/web/flight-search/award-fare-calendars",
      method: () => "POST",
      postData: () => '{"channel":"WEB_DESKTOP","itineraries":[{"origin":"GRU","destination":"NRT","departureDate":"2026-11-16","isRequested":true}],"cabinClass":"ECONOMY","passengers":[{"type":"ADT","count":1}],"currencyCode":{},"flexibility":15}',
      allHeaders: async () => ({ authorization: "Bearer member", "request-id": "page-id", cookie: "c=1", traceparent: "t", "session-id": "s" }),
    };
    for (const handler of handlers) handler(request);
  };

  const page = {
    url: () => url,
    context: () => ({
      on: (_event: string, handler: (request: unknown) => void) => handlers.add(handler),
      off: (_event: string, handler: (request: unknown) => void) => handlers.delete(handler),
    }),
    goto: async (target: string) => {
      gotos.push(target);
      if (target.includes("loginpage")) {
        url = target;
        return;
      }
      if (!site.loggedIn) {
        url = "https://www.qatarairways.com/en/homepage.html";
        return;
      }
      url = target;
      firePageCall();
    },
    waitForTimeout: async () => {
      if (!url.includes("loginpage")) return;
      loginWaits++;
      if (loginWaits >= (site.loginAfterWaits ?? Infinity)) {
        site.loggedIn = true;
        url = "https://www.qatarairways.com/en/Privilege-Club/postLogin/dashboardqrpcuser.html";
      }
    },
    bringToFront: async () => {},
    evaluate: async (_fn: unknown, args: { headers: Record<string, string>; body: { cabinClass: string; itineraries: { departureDate: string }[] } }) => {
      const month = args.body.itineraries[0]!.departureDate.slice(0, 7);
      asked.push({ month, headers: args.headers, body: args.body });
      return site.answer(month, asked.length);
    },
  };
  return { page: page as unknown as Page, gotos, asked };
}

const calendarFor = (month: string): Answer => ({ status: 200, text: month === "2027-08" ? august : december });

describe("Qatar year sweep", () => {
  beforeEach(() => mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-09T12:00:00") }));
  afterEach(() => mock.timers.reset());

  test("asks each of the next 13 months on the 16th and keeps only that month's days", async () => {
    const site = fakeSite({ loggedIn: true, answer: calendarFor });

    const result = await searchQatarYear(site.page, route);

    assert.deepEqual(
      site.asked.map((call) => call.body.itineraries[0]!.departureDate),
      ["2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11"].map((month) => `${month}-16`),
    );
    assert.deepEqual(result.failedMonths, []);
    assert.equal(result.days.filter((day) => day.date.startsWith("2026-12")).length, 10);
    assert.equal(result.days.filter((day) => day.date.startsWith("2027-08")).length, 31);
    assert.equal(result.days.length, 41);
  });

  test("replays the page's headers without the browser-owned ones and with a fresh request id", async () => {
    const site = fakeSite({ loggedIn: true, answer: calendarFor });

    await searchQatarYear(site.page, route);

    const [first] = site.asked;
    assert.equal(first!.headers.authorization, "Bearer member");
    assert.equal(first!.headers["session-id"], "s");
    assert.equal(first!.headers.cookie, undefined);
    assert.equal(first!.headers.traceparent, undefined);
    assert.notEqual(first!.headers["request-id"], "page-id");
    assert.equal(first!.body.cabinClass, "ECONOMY");
  });

  test("a 401 reopens the calendar and asks the same month again, losing nothing", async () => {
    const site = fakeSite({ loggedIn: true, answer: (month, call) => (call === 3 ? { status: 401, text: noToken } : calendarFor(month)) });

    const result = await searchQatarYear(site.page, route);

    assert.equal(site.gotos.length, 2);
    assert.deepEqual(site.asked.slice(2, 4).map((call) => call.month), ["2027-01", "2027-01"]);
    assert.deepEqual(result.failedMonths, []);
  });

  test("logged out, it opens the login page, tells the person, and goes on once they log in", async () => {
    const notices: string[] = [];
    const site = fakeSite({ loggedIn: false, loginAfterWaits: 3, answer: calendarFor });

    const result = await searchQatarYear(site.page, route, () => {}, () => {}, (message) => notices.push(message));

    assert.match(notices[0]!, /Faça o login no Privilege Club na janela do Chrome do bot/);
    assert.ok(site.gotos.some((target) => target.includes("loginpage")));
    assert.equal(result.days.length, 41);
  });

  test("nobody logging in is an error, never an empty calendar", async () => {
    const site = fakeSite({ loggedIn: false, answer: calendarFor });

    await assert.rejects(searchQatarYear(site.page, route), QatarLoginError);
    assert.equal(site.asked.length, 0);
  });

  test("three refused months in a row stop the sweep and mark the rest as not searched", async () => {
    const site = fakeSite({ loggedIn: true, answer: (month) => (month >= "2027-02" ? { status: 400, text: refused } : calendarFor(month)) });

    const result = await searchQatarYear(site.page, route);

    assert.equal(site.asked.length, 6);
    assert.equal(result.failedMonths.length, 10);
    assert.match(result.failedMonths[0]!.error, /HTTP 400/);
    assert.match(result.failedMonths.at(-1)!.error, /3 meses seguidos/);
    assert.equal(result.days.length, 10);
  });
});

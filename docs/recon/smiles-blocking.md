# Smiles: the two blocks (406 and 403)

Last updated: 2026-10-06.

The Smiles search runs from inside Chrome, with the page sitting on the API's
origin (`api-air-flightsearch-prd.smiles.com.br`). There are two different ways
for the search to die, and they have neither the same cause nor the same wait.

## 406: request budget per IP

- Akamai's edge is what answers, with JSON carrying a `referenceId` and the
  `clientIP` (`fixtures/smiles-406-budget.json`).
- Keyed on the IP alone: see the 2026-10-06 section.
- Hammering burns more budget. The sweep waits instead: one recheck every
  `SMILES_BLOCK_RECHECK_MS` (10 min), resuming on the same date, up to
  `SMILES_MAX_BLOCK_WAIT_MS` (3 h) per block. `SmilesBudgetError` reaches the
  result only when that limit runs out.

## 403: denied at the edge (solved on 2026-09-15)

- Akamai is what answers, with an HTML `Access Denied` page instead of the JSON.
  The body carries a `Reference #…`, the only piece useful for support.
- **Cause: the `channel: APP` header.** Nothing to do with IP, cookie or route.
- In the code: `SmilesAccessDeniedError`, which still applies if it happens again
  for another reason.

### How it was measured

First ruling out what looked obvious:

| test | result |
|---|---|
| browser → root and search, on the 3 environments (prd/green/blue) | 403 HTML on all |
| **outside the browser** (Node `fetch`, same IP) | **406**, which any non-browser gets (see the 2026-10-06 section) |
| `www.smiles.com.br` in the same Chrome | 200 |
| clearing Akamai's 5 cookies and repeating | 403 again |
| going through the site first, so the sensor validates `_abck` | 403 again |

With IP, cookie and route ruled out, what was left is what we send. Same URL,
same cookies, one call after the other:

| headers | result |
|---|---|
| `x-api-key` + `channel: APP` | **403, block HTML** |
| `x-api-key` alone | 200 · 8 flights · **empty calendar** |
| `x-api-key` + `channel: WEB` | 200 · 40 flights · **6 calendar days** |

So the 403 is not a block in the "wait for it to pass" sense. It is a new rule
that refuses whoever claims to be the iOS app coming from a Chrome, an easy
contradiction to detect. And `WEB` is not just what passes, it is the only value
that brings `calendarDayList`, the basis of the sweep in 7-day steps.

The fake iOS `user-agent` went away too: `fetch` ignores that header by
specification, so it never actually left the bot.

### Three refusals that look alike in the log

| response | what it is |
|---|---|
| `406` JSON | request budget per IP |
| `403` **HTML** `Access Denied` | the edge refused this request |
| `403` **JSON** `Missing Authentication Token` | the API Gateway's normal answer for a route that does not exist; the root always returns it, it is not a block |

The number alone says nothing; the body does. `refreshSmilesSession()` keeps the
root's status when opening the session (`rootStatusOnOpen`) and the 403 message
uses it to say whether the whole origin was already denied.

`npx tsx scripts/probe-smiles-block.ts` redoes this measurement in ~4 requests:
it compares the call from outside the browser with the header variants and says
which one still passes.

## A side effect that already fooled the log

Before this fix the 403 fell into the generic status branch and became "day
failed". Consequences, all visible in the 2026-09-15 log:

1. The sweep carried on after the first 403 and spent more requests.
2. Since no day answered, the calendar stayed empty and step 2 concluded "this
   route returns no calendar" and started filling day by day, on false
   evidence. **The route had a calendar; what was missing was access.**
3. The whole HTML block page went into every error message.

Today the 403 stops the sweep immediately, like the 406, and returns the partial
result with the gap explained.

## 452: two meanings, and neither is a block (measured on 2026-09-29)

| body | what it is |
|---|---|
| `{"errorMessage":"data não permitida"}` | date outside the sale window |
| `{"error":"Error: Falha ao obter os dados do aeroporto: XQZ"}` | a code Smiles does not know |

- The sale window goes up to **today + 329 days**. Day 330 already answers "data
  não permitida". The sweep cuts the period there (`SALE_WINDOW_DAYS`) and, if it
  still hits the edge, stops without counting it as a failure.
- Before that every 452 became "check the IATA codes". The default 365-day sweep
  asked for the last samples outside the sale window, got three 452s in a row and
  stopped blaming the airport.
- `npx tsx scripts/recon-smiles-window.ts GRU MRU` redoes the measurement (~10
  requests) and also says whether the route brings the 7-day calendar.

## Partner-only routes have no calendar

GRU→MRU answers `resultType: "congener"`, every flight `AMADEUS`, and
`calendarDayList` comes back empty. `forceCongener=true` changes nothing, and
`flightList` only brings the requested day (`fixtures/smiles-real-congener.json`).
On these routes each day costs one query: ~330 per leg to cover the whole window.

## 452 wrapping a 503: a stuck load-balancer cookie (measured on 2026-10-05)

Every route, GOL domestic included, started answering
`452 {"error":"AxiosError: Request failed with status code 503"}`. It was not an
outage:

| test | result |
|---|---|
| bot profile, `prd` | 452/503 |
| bot profile, `blue` | 452/503 |
| bot profile, `green` | 200 |
| fresh browser, `prd` | 200 |
| bot profile, `prd`, after clearing only `akaalb_prod_flightsearch` | 200 |

`akaalb_*` is the affinity cookie of Akamai's load balancer. It is a session
cookie, and the bot's window stays open for days, so it never expires and kept
pinning every call to an origin that was failing.

In the code: a 503 inside a 452 is `SmilesUpstreamError`. The scraper clears the
`akaalb_*` cookies, replants the session and retries that day once. A second 503
is `SmilesUpstreamDownError`, which stops the sweep like a block.

The same log showed the sweep concluding "this route has no calendar" after no
probe had answered and filling 25 days on that. An empty calendar now only
counts when at least one probe came back.

## 406 is keyed on the IP alone (measured on 2026-10-06)

`scripts/measure-smiles-budget.ts` spent the budget on GRU→CUN and, right after
the first 406, tried every way around it that cheap-flights had used:

| variant | result |
|---|---|
| bot profile, `prd` again | 406 |
| bot profile, `green` | 406 |
| bot profile, `blue` | 406 |
| bot profile, `prd`, `akaalb_*` cleared | 406 |
| fresh browser, `prd` | 406 |

Same `clientIP` in every body. Rotating hosts or sessions does not help; only
time does. The block was still on at +10 min and gone 87 min later (the check
in between hung, so the exact length is unknown).

How much fits: with a fresh budget, 372 calls in a row at the bot's pace (one
every ~7 s, call included) and no 406. That is more than a whole leg of the sale
window. The old "~100–150 per window" figure does not hold at this pace.

A call from outside the browser gets a 406 whether or not the IP is over
budget, so it says nothing about the budget.

## 452 from a crash inside their search service

`{"error":"TypeError: Cannot read properties of undefined (reading 'flightList')"}`
came back on ~10% of the GRU→CUN days, up to 5 in a row. The same dates
answered 200 when asked again later. It is `SmilesTransientError`, and the
scraper retries that day twice before counting it as a failure. In the
2026-10-06 sweep every one of them passed on the first retry, 5 s later.

## A call that never answers

Once a search call hung for over an hour and froze the whole run with no error.
Every call now has a deadline (`SMILES_SEARCH_TIMEOUT_MS`, 60 s) and a hang
becomes a failed day.

## How long a sweep takes (2026-10-06, partial evidence)

- One call takes ~8 s at the bot's pace (372 calls in 51 min, response time
  included). The 4 s limiter barely matters; Smiles answers in 4–8 s.
- A leg of a route without calendar is ~330 calls: ~45–50 min with a fresh
  budget. Not yet confirmed end to end: the only full sweep started right after
  the measurement had spent 372 calls, hit 406 at ~90 calls and was stopped.
- After that 406, a 10 min wait let one call through before the next 406. The
  budget refills slowly while a recent burst is still in the window; how long
  the window is was not measured.
- A round trip (~660 calls) does not fit in the 372 known to pass, so the
  second leg will likely wait out at least one block.

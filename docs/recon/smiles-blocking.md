# Smiles: the two blocks (406 and 403)

Last updated: 2026-09-15.

The Smiles search runs from inside Chrome, with the page sitting on the API's
origin (`api-air-flightsearch-prd.smiles.com.br`). There are two different ways
for the search to die, and they have neither the same cause nor the same wait.

## 406: request budget per IP

- The API is what answers.
- Measured: the block lasts more than 20 min and replanting the cookies does not
  recover it. It is a per-IP budget over a sliding window (the probes spent ~99
  and the next run was blocked at the 40th).
- There is no "try again": insisting only burns what is left of the budget.
- In the code: `SmilesBudgetError`.

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
| **outside the browser** (Node `fetch`, same IP) | **406**: the IP is allowed |
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

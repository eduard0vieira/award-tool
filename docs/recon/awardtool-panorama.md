# AwardTool recon: Panorama and the route calendar (TAP without real-time search)

> Gathered on 2026-10-19 with the agency's Pro account, Playwright headless.

AwardTool dropped TAP Miles&Go from its real-time search (`/flight`) around
August 2026. Its support says TAP is still available in **Panorama**, which reads
from AwardTool's own stored data, refreshed on its side. Each row says when it was
last seen, and support asks to confirm on TAP's site before transferring points.

## Two pages over the same data

| page | URL | what one load returns | Pro limit |
|---|---|---|---|
| Panorama | `/routes?from=GRU_4&to=LIS_4&startDate=<unix s>&endDate=<unix s>&programs=TP&pax=1&children=0` | one call per 2 days (`routes_data_v2-<n>`), every program unless `programs` filters | 90 days |
| Route calendar | `/route-detail?route=GRU-LIS` | **one** call (`routes_calendar_v2`) with every program for the whole year | 365 days |

`_4` is the location type "airport" (1 region, 2 airport group, 3 city, 4
airport, 5 custom code). The limits come from the bundle (`routes_range` 30/90,
`route_calendar_range` 90/365 for free/Pro).

Both read the same rows: a 90-day Panorama search on GRU-LIS returned exactly
the calendar's rows for those dates (83 of 90 identical, and the 7 that differed
had been refreshed between the two reads).

## The API

- Host `https://049atbj9v6.execute-api.us-east-1.amazonaws.com/v1/<function>`.
- **Requests are encrypted** (`{"ciphered_requestV2": ..., "ciphered_requestV5": ...}`),
  built by the site's bundle. Calling the API directly would mean reimplementing
  that, so the way in is to load the page and read its response.
- **Responses are only compressed**: `{"ciphered_data": "<base64 of zlib>"}`.
  `inflateSync(Buffer.from(ciphered_data, "base64"))` gives JSON.
- `user_info` comes along on every page and carries the account's e-mail, user
  id and referral code: never save it.

## A calendar row

```json
{
  "date": "2026-10-20", "route": "GRU-LIS", "program": "TP",
  "points": {
    "ls": 1792324949,
    "y": 44900, "w": null, "j": 135000, "f": null,
    "ss":  { "y": 7, "j": 2 },
    "tax": { "y": 43.33, "w": null, "j": 43.33, "f": null },
    "c_s": { "y": 1, "w": null, "j": 1, "f": null },
    "c_p": { "y": 0, "w": null, "j": 100, "f": null },
    "c_a": { "y": ["TP"], "w": [], "j": ["TP"], "f": [] }
  },
  "points_ns": { "ls": 1792324949, "y": 44900, "w": null, "j": 135000, "f": null },
  "r_ls": 1792324949
}
```

- One row per date, route and program, with the **cheapest** fare per cabin:
  `y` economy, `w` premium economy, `j` business, `f` first. Raw miles, not "K".
- `ls`: last seen, unix seconds. This is the age of the price **and** of the seats.
- `ss`: seats per cabin (9 means 9+).
- `c_s`: segments of that cheapest itinerary (1 = nonstop). `points` is the
  cheapest at any number of stops, like the old Date popover; `points_ns` is the
  cheapest nonstop. On GRU-LIS they differ a lot: business 135k with a
  connection against 345k nonstop on the same day.
- `c_p`: share of the journey in the cabin. Below 100 in business means a
  mixed-cabin itinerary.
- `c_a`: operating carriers.

## Coverage (2026-10-19)

| route | TAP dates | span | last seen, median / oldest |
|---|---|---|---|
| GRU-LIS | 355 | 2026-10-19 to 2027-10-15 | 1.3 / 6.4 days |
| LIS-GRU | 351 | to 2027-10-12 | 3.4 / 3.9 days |
| GIG-LIS | 349 | to 2027-10-15 | 2.4 / 6.4 days |
| GRU-OPO | 325 | to 2027-09-29 | 3.4 / 5.4 days |
| BSB-LIS | 323 | to 2027-09-27 | 6.4 / 6.4 days |
| CNF-LIS | 318 | to 2027-09-23 | 6.5 / 6.5 days |
| REC-LIS | 304 | to 2027-08-28 | 4.0 / 5.3 days |
| SSA-LIS | 255 | to 2027-07-23 | 4.0 / 4.0 days |
| GRU-MAD | 353 | to 2027-10-15 | 4.0 / 6.6 days |
| GRU-FCO | 320 | to 2027-09-30 | 5.5 / 6.3 days |
| FOR-LIS | **0** | AwardTool does not track TAP on this route | - |

- A date with nothing available has **no row** (no row with every cabin null
  was seen). A missing date can be "no award" (SSA-LIS misses every Friday from
  April 2027, a schedule pattern) or "not tracked yet" (dates after the route's
  last one). Neither can turn into an alert, so the risk is a missed date, not a
  wrong one, but the result has to say up to which date the route is covered.
- A route with zero TAP rows is "AwardTool does not track TAP here", never "no
  availability".

## Freshness

- **Request Refresh** on the calendar (`routes_refresh`) only queues the route
  ("we will prioritize this route for data sourcing") and spends a small quota
  (`route_refresh_left: 2` after one use). Nothing changed 90 s later. Do not
  automate it.
- **A Panorama search makes AwardTool refresh part of the dates it covers.**
  A 90-day Panorama search on GIG-LIS (Jan to Mar 2027, 83 TAP dates): 5 minutes
  later the calendar had 30 of those dates seen again, against 12 outside the
  window (all in Sep/Oct 2027, the far end its own crawler was walking). The
  same happened on GRU-LIS (28 dates of the window in 5 minutes). It is partial
  (about a third of the window) and not instant, but it costs no quota.
- Prices really move between refreshes: on GRU-LIS, 2027-02-07 business went
  from 175k to 275k between two reads 5 minutes apart.

## How to regenerate

`npx tsx scripts/recon-awardtool-calendar.ts GRU-LIS fixtures` saves the raw
`routes_calendar_v2` response (still compressed) and prints the TAP summary.

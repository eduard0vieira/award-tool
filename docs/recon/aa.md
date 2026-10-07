# AA recon (step 0): endpoint notes

> Gathered on 2026-08-03 with real Chrome through Playwright.

## How to run AA searches (procedure)

1. `npm run chrome` opens a Chrome window with a separate profile
   (`~/.chrome-bot-aa`). Leave it open; your normal Chrome keeps working next to
   it. It has to be a separate profile: since Chrome 136 the debugging port is
   ignored on the default profile.
2. If you get "Access Denied": close that window, run
   `bash scripts/import-cookies.sh aa.com` and reopen with `npm run chrome`.
3. Search normally from the bot's American tab.

Step 2 is what unlocks it: Akamai blocks any browser without its cookies
(`_abck`, `bm_s`), including a plain Chrome, with no automation, on a new
profile. The script carries ONLY the aa.com cookies from your everyday Chrome to
the bot's profile. Redo it when those cookies expire and the block comes back.

## Anti-bot (Akamai)

- Playwright's bundled Chromium: **immediate 403** on any /booking URL.
- Real Chrome (`channel: "chrome"` + `--disable-blink-features=AutomationControlled`) **passes**, as long as it warms up first: visit `https://www.aa.com/` (~4s) before going to the deep link.
- `page.request.post(...)` (outside the browser, even with cookies): **403**; the TLS is not Chrome's.
- `fetch` from inside the page (`page.evaluate`): **200**; this is the way to call the API.

## Deep link (works cold after warming up)

```
https://www.aa.com/booking/search?locale=en_US&pax=1&adult=1&type=OneWay
  &searchType=Award&cabin=<CABIN>&carriers=ALL
  &slices=[{"orig":"GRU","origNearby":false,"dest":"MIA","destNearby":false,"date":"2026-09-15"}]
```
(`slices` URL-encoded). It redirects to `POST /booking/choose-flights/1?sid=...` (HTML).
`cabin=BUSINESS` in the URL becomes `"BUSINESS,FIRST"` in the internal request
and the carousel starts showing Business prices; the cabin filter is server side.

## Results page

- The full state is embedded in `<script id="ng-state" type="application/json">`:
  `SearchData.itineraryResult.slices[]` (the day's itineraries: `stops`,
  `segments[]`, `pricingDetail[]` with the 4 cabins, `productType`
  COACH/PREMIUM_ECONOMY/BUSINESS/FIRST, `perPassengerAwardPoints`,
  `productAvailable`) and `SearchData.weeklyResult.days[]` (±6-day carousel:
  `date`, `awardPointsTotal`).
- The cookie banner (OneTrust) may cover the page; dismiss it with "Reject All".
- The "CALENDAR" button opens the monthly calendar → fires the XHR below.

## Calendar API (the heart of the bot)

`POST https://www.aa.com/booking/api/search/calendar`, **no session state**
(empty `sessionId`/`solutionSet` work; any `departureDate` will do, the month
returned is the departureDate's). Body:

```json
{
  "metadata": { "selectedProducts": [], "tripType": "OneWay", "udo": {} },
  "passengers": [{ "type": "adult", "count": 1 }],
  "requestHeader": { "clientId": "AAcom" },
  "slices": [{
    "allCarriers": true,
    "cabin": "BUSINESS,FIRST",      // "" = all | "COACH" | "PREMIUM_ECONOMY" | "BUSINESS,FIRST"
    "departureDate": "2026-09-15",
    "destination": "MIA", "destinationNearbyAirports": false,
    "maxStops": null,               // 0 = direct only (to confirm on a route without a direct flight)
    "origin": "GRU", "originNearbyAirports": false
  }],
  "tripOptions": { "corporateBooking": false, "fareType": "Lowest", "locale": "en_US",
    "pointOfSale": null, "searchType": "Award", "enableBenefits": true },
  "loyaltyInfo": null, "version": "",
  "queryParams": { "sliceIndex": 0, "sessionId": "", "solutionSet": "", "solutionId": "" }
}
```

Response: `calendarMonths[0] = { month, year, weeks[] }`; each
`weeks[].days[]` = `{ date, dayOfMonth, validDay, solution }` with
`solution.perPassengerAwardPoints` (the day's lowest value for the requested
cabin; `solution: null` = no availability). `calendarDetails.lowestMonthlyPrice`
= the month's lowest.

## Passengers (validated)

`passengers[0].count` is honored by the calendar: the same route/month/cabin
with count 1, 2, 4 and 9 returns different values per day (GRU–MIA economy,
Oct/2026: day 05 went 48000 → 48500 → 48500 → 49000; day 03, 43500 → 45000 with
9). On a loose route the number of days does not change; on a tight route the
whole day disappears, because AA only quotes when there is an award seat for
everyone on the same flight. **`perPassengerAwardPoints` is per person**, so the
miles ceiling keeps its meaning with more passengers.

Maximum: **9**. With 10 it answers 400 with
`"Total number of passengers must be between 1 and 9."` (reasonCode 27).

## The two meanings of 400

The same status covers two very different things, and the distinction only
exists in the body (`details[].reason`):

- end of the sales calendar → `field: "slices[0].departureDate"`,
  `"Search date is outside of available schedule."` (reasonCode 1356);
- invalid request (e.g. too many passengers) → the offending field in
  `details[].field`.

Mixing them up makes the sweep stop at the first month and return "no
availability" instead of an error, which is why `fetchMonth` classifies by the
reason, not by the status.

## Year sweep (validated)

1. Warm up on the home page → deep link (1 navigation; sets Akamai's cookies).
2. 12 × in-page `fetch` on `/booking/api/search/calendar`, one per month
   (`departureDate` = the 15th of each month), with a pause between them.
3. Parse `calendarMonths`. Total: ~13 requests per direction/year.

## Open points for steps 1/2

- Confirm `maxStops: 0` on a route without a direct flight (in the GRU–MIA test
  the lowest price was already the direct one, so the filter changed nothing;
  inconclusive).
- Confirm the Premium Economy cabin value (`"PREMIUM_ECONOMY"` is the
  productType; the value accepted in the request may be another).
- Error message/format for a nonexistent route and for AA's rate limit.

## Booking link per day (2026-09-17)

Each day of the AA report comes with a deep link to that date's results page,
the same address the site generates for a search made by hand:

```
https://www.aa.com/booking/search?locale=en_US&pax=N&adult=N
  &type=OneWay&searchType=Award&cabin=<CABIN>&carriers=ALL
  &slices=[{"orig":"GRU","origNearby":false,"dest":"MIA","destNearby":false,"date":"2026-11-20"}]
```

The URL's `cabin` **does not take the same values as the request**: in the
calendar body Business is `BUSINESS,FIRST`, but in the URL it is `BUSINESS`.
That is why `AA_LINK_CABINS` exists apart from `AA_REQUEST_CABINS`.

Checked in the user's Chrome on 2026-09-17 (GRU → MIA, 2026-11-20):

- `cabin=BUSINESS` → redirects to `booking/choose-flights/1` with the right date
  and only the Business column. The direct flight AA930 showed up at 171.5K, the
  same number as the day's carousel.
- `cabin=PREMIUM_ECONOMY` → same, with the Main/Premium Economy/Business columns.

Two things worth remembering:

1. The link opens in the **user's** browser, not in the bot's profile. A brand
   new profile gets `Access Denied` from AA; the everyday browser passes
   normally.
2. The search session (`sid`) is created by AA itself in the redirect, so the
   link does not expire; it can be kept and clicked later.

`openResultsPage()` (the step that plants the bot's cookies) uses the same URL
function. There the page only serves to open the session, and the calendar
request is what filters.

## Fresh profile from a Brazilian IP (2026-10-07, Windows notebook)

The notebook's bot profile had no AA cookies (`import-cookies.sh` does not run
on Windows). Measured with a throwaway profile and real Chrome:

- Warm-up on `https://www.aa.com/` goes `301 → homePage.do →
  internationalSplashSubmit.do → aa.com.br/homePage.do?locale=pt_BR`. That page
  loads itself a second time a few seconds later, and that reload aborts the
  deep link: `page.goto: net::ERR_ABORTED`. On the Mac the imported cookies
  already carried the region, so the redirect never happened.
- Warm-up on `https://www.aa.com/homePage.do?locale=en_US` stays on aa.com, and
  the deep link reaches `choose-flights` normally.
- On that fresh profile the results page shows Akamai's captcha
  (`Challenge Validation`, `/challenge-assets/v7/captcha.html`), but the in-page
  calendar `fetch` still answered **200** with real data (GRU–MIA business,
  Nov/2026). The captcha does not block the sweep.

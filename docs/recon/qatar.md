# Qatar Airways (Privilege Club): award calendar recon

Measured on 2026-11-09, first by hand in a separate browser (GRU ⇄ NRT, BKK,
MLE, HKG, about 100 calls in an afternoon without a logout), then with
`scripts/recon-qatar.ts` in the bot's Chrome profile.

## The endpoint

```
POST https://www.qatarairways.com/dapi/public/bff/web/flight-search/award-fare-calendars
{"channel":"WEB_DESKTOP","itineraries":[{"origin":"GRU","destination":"NRT","departureDate":"2027-02-16","isRequested":true}],
 "cabinClass":"ECONOMY","passengers":[{"type":"ADT","count":1}],"currencyCode":{},"flexibility":15}
```

- `flexibility: 15` returns the days within ±15 of `departureDate`. Centered
  on the 16th that is the whole month, and in 30-day months also the 1st to
  3rd of the next (`2027-02-01..2027-03-03`). Each answer must be cut to its
  own month.
- Each day: `date`, `flexiIndicator`, `offPeakIndicator`,
  `privilegePickIndicator` always. A day with an award also has `lowestPrice`,
  `currencyCode: "AVIOS"` and `cabinClass`. A day without `lowestPrice` has no
  award seat.
- Fare bands on GRU→NRT economy: 50K off-peak, 100K flexi, and 60K with no flag
  at all (the same unflagged middle band is 57K to BKK/HKG and 51K to MLE).
- Only flights operated by Qatar appear; partner flights (oneworld) never do.
- The calendar is economy only here: `"cabinClass":"BUSINESS"` answered 400
  `{"code":"0000002","error":"Messaging error."}`. The value the page sends for
  business is not known yet.

## Headers and login

The page's own call carries `authorization: Bearer …` (opaque, 216 chars, not a
JWT), `session-id`, `x-assigneddeviceid`, `nbx_fs_api_key`, `qr-lang`,
`request-id`. Replaying them through `fetch` inside the page, with a new
`request-id`, works month after month.

| without `authorization` | 401 `{"code":"0000004","error":"Security error."}` |
|---|---|

- The calendar deep link (`/app/booking/award-calendar?…&qmilesFlow=true`)
  **bounces to `/en/homepage.html` when not logged in**. That is the signal to
  detect, not an error page.
- Login: `/en/Privilege-Club/loginpage.html`, e-mail + password + a code sent by
  e-mail (reCAPTCHA in the page). The bot cannot do it alone.
- After the login the tab lands on `/en/Privilege-Club/postLogin/dashboardqrpcuser.html`.
- **The login survives closing and reopening Chrome** on the bot's profile: the
  second pass opened the calendar straight away and read the same three months.

## Pace

6 s between calls, ~13 calls per direction for a year. No logout or block was
seen in about 120 calls over the afternoon. The person reports that Qatar logs
out after some limit: not reached here, so not measured.

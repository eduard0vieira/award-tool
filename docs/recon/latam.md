# LATAM recon (step 0): notes

> Gathered on 2026-08-06 in the bot's window (real Chrome through CDP), first
> anonymous and then with the logged-in session inherited through cookie import.

## One-line summary

**Cash**: full monthly calendar, ~6 requests per year, no login. **Miles**:
needs login and only exists day by day, ~365 requests per direction/year.

## 1. Deep link (works)

```
https://www.latamairlines.com/br/pt/oferta-voos?origin=GRU&destination=SCL
  &outbound=2026-10-15T12:00:00.000Z&inbound=2026-10-22T12:00:00.000Z
  &adt=1&chd=0&inf=0&trip=RT&cabin=Economy&redemption=false&sort=RECOMMENDED
```

- `redemption=false` (cash): opens directly, **no login**, no anti-bot challenge.
- `redemption=true` (miles): **anonymous redirects to the login**
  (`auth.latamairlines.com`). With a logged-in session it opens normally.

## 2. Fare calendar: the good endpoint (CASH)

```
GET /bff/web-products-searchbox/v1/calendar
    ?origin=GRU&destination=SCL&month=9&year=2026&isRoundTrip=true&extended=true
```

This is the one that feeds the home page's date strip. **`extended=true` is what
brings the prices.** Careful: there is a similar `/bff/air-offers/v2/calendar`
that **always** returns empty; it is not that one.

One response brings **two months** and **both directions**:

```json
{ "disabledDays": ["2026-08-01", ...],
  "days": [ { "calendar": [
      { "month":"2026-09","direction":"OUTBOUND","minimum":{"amount":912.65,"currency":"BRL"},
        "maximum":{...},
        "detailsCalendar":[
          {"date":"2026-09-06","fare":{"amount":908.6,"roundedAmount":909,"currency":"BRL"},
           "formattedAmount":"909","percentile":0,"enabled":true,"lowPrice":true}, ...]},
      { "...direction":"INBOUND"... } ] }, { "...next month..." } ] }
```

- 30–31 days per month, with a price on ~26+ of them.
- **`lowPrice: true`** is exactly the "Menor tarifa" highlighted in the
  interface; it gives the filter for free, with no need to compare values.
- `enabled: false` / `disabledDays` = days in the past or not on sale.

**Cost of a year: ~6 requests** (2 months each), already covering outbound and
return. Better than AA.

**It only returns BRL.** I tried `redemption=true`, `isRedemption=true`,
`currency=LOYALTY_POINTS` and `cabinType=Economy`: the response is identical,
always in reais. There is no miles version of this endpoint.

## 3. Miles: day by day only, and logged in

```
GET /bff/air-offers/v2/offers/search/redemption?adult=1&outFrom=<date>&...
```

It returns 50 flights for that day, with
`summary.lowestPrice = {"currency":"LOYALTY_POINTS","amount":29307,"display":"29.307 milhas"}`.
It also has `summary.stopOvers` (0 = direct) and `duration`.

**One request = one day.** A year per direction = ~365 calls.

## 4. Required headers (otherwise 400)

```
accept: application/json, text/plain, */*
x-latam-application-country: br     x-latam-application-oc: br
x-latam-application-lang: pt        x-latam-application-name: xp-web-products-searchbox-lib
x-latam-client-name: xp-web-products-searchbox-lib
x-latam-request-id / x-latam-app-session-id / x-latam-track-id: a uuid we generate
```

## 5. Logged-in session without a password

`bash scripts/import-cookies.sh latamairlines.com` copies the domain's cookies
from the user's Chrome into the bot's profile (it merges, it does not replace;
aa.com stays there). That is how the logged-in session reached the bot, with no
credential stored anywhere. Redo it when the session expires.

## 6. Anti-bot

No challenge in this session, in either mode. AA's playbook (bot window +
pacing + cookie import) covers the risk.

## 7. Design decision this forces

- **Cash mode**: a whole year is easy, ~6 requests.
- **Miles mode**: sweeping the year is not viable (365 calls/direction). It needs
  a range chosen by the user, or a two-phase strategy (use the cash calendar to
  pick the candidate days and only then query miles on them).

---

## Round trip: the price of the PAIR (gathered on 2026-08-18)

**Leg by leg gives a wrong number.** Measured on GRU⇄JNB: confirming each
direction alone, 119,560 + 123,975 = **243,535 miles**. The same pair bought
together on the site: **90,302 miles + R$ 255.69**. It is not a different fare;
LATAM prices the pair.

That number **is not** in `/offers/search/redemption`, which is what the bot
used to read. The "Combine suas milhas + dinheiro" screen only shows up after
choosing an outbound **and** a return flight, and the price comes from here:

```
POST https://www.latamairlines.com/bff/air-offers/v2/offers/redemption-options

{
  "tax": { "amount": 255.69, "currency": "BRL" },
  "redemptionOptions": [
    { "id": 1, "totalValueToPay": { "loyalty": { "amount": 90302 }, "money": { "amount": 0 } } },
    { "id": 2, ... 81272 + 469.56 },
    { "id": 3, ... 63212 + 1164.87 },
    { "id": 4, ... 45151 + 1760.89 }
  ]
}
```

**What the screen shows is `money.amount + tax.amount`**, checked on all four
rows: 469.56 + 255.69 = 725.25; 1,164.87 + 255.69 = 1,420.56; 1,760.89 + 255.69
= 2,016.58. And the per-leg rows on the same screen (45,151 + R$ 68.61 and
45,151 + R$ 187.08) add up to option 1: 45,151 × 2 = 90,302, and 68.61 + 187.08
= 255.69. Those two identities are the cheap test that the right row was read.

**There are four options, not one price.** It is a miles ↔ cash ladder, like
Azul's `amountLevel` and Smiles' discount: the module keeps all four and makes
the choice explicit.

Another finding along the way: the return search shows up again as
`/offers/search/redemption?...&outOfferId=<outbound id>`, so the return is
already priced based on the chosen outbound.

**Cost:** each pair is a full flow (deep link → choose outbound → choose
return). `LATAM_PAIRS` controls how many (default 3).

Fixture: `fixtures/latam-redemption-options-real.json`.
Recon: `npm run recon:latam GRU JNB <outbound> <return>` (needs a logged-in
session).

## How the test pair is chosen (2026-09-15)

The miles confirmation runs on 3 date pairs. It is not a sweep: it is a
**simulation of a search from the group**, made to see whether the price in
points changes throughout the year. Hence the rules:

1. **Both dates must be in the result the card shows.** The pair comes from
   `filterByCeilings(days, ceilings)`, the same list that becomes the report.
   It used to come from the raw calendar: a December screenshot showed up in a
   result that only had September, because December passed the margin
   (`lowest + R$ 100`) but not the ceiling, so it was out of the card and inside
   the test.
2. **Stay of 3 to 14 days** (`LATAM_MIN_STAY` / `LATAM_MAX_STAY`). Outbound one
   day and return the next is easy to find and is nobody's trip; above two weeks
   the price is already in another range.
3. **Spread-out dates.** The first pass requires 90 days between outbound dates
   (`LATAM_PAIR_DISTANCE`). When the result does not have that reach, the second
   pass always takes the date furthest from those already chosen instead of the
   cheapest ones; three days in a row would return the same number three times.

If nothing satisfies the rules, the confirmation does not run and the notice
says why. That is better than returning a screenshot that does not match the
result.

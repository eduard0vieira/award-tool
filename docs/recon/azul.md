# Azul / TudoAzul recon (phase 0): notes

> Gathered on 2026-08-18 with `npx tsx scripts/recon-azul.ts VCP REC`, on a
> **brand new** Chrome profile (no cookies, no history, no login).

## One-line summary

Searching in points works **without login and without profile reputation**, but
none of our own calls get through: the site itself has to fire them. What works
is letting the page make its request and **swapping the body on the way**, and
the body accepts **6 dates at once**. The problem is volume: **on the 9th
navigation in a row the search stops firing**, and a year per direction would
need 61. That limit decides whether the module exists.

## 1. Deep link (works, and it is the best finding)

```
https://www.voeazul.com.br/br/pt/home/selecao-voo
  ?c[0].ds=VCP&c[0].std=10/17/2026&c[0].as=REC
  &p[0].t=ADT&p[0].c=1&p[0].cp=false&f.dl=3&f.dr=3&cc=PTS
```

- `cc=PTS` = points; the date goes as **M/D/YYYY**, not ISO.
- It lands straight on the result. **Nothing was clicked**, not even the cookie
  notice.
- A blank profile works: no TudoAzul account or inherited cookie needed.

## 2. The session is created by the page itself

```
POST /authentication/api/authentication/v1/token   → 200, ~300 bytes
```

It goes out with an empty `authorization` and comes back with the token (280
chars) the following calls use. **None of our credentials take part in it.**
That is the difference between this path and the old project's, where the
token was pasted by hand and went stale in hours.

## 3. Availability endpoint: the old code's version is wrong

```
POST https://b2c-api.voeazul.com.br/tudoAzulReservationAvailability
     /api/tudoazul/reservation/availability/v6/availability
```

`endpoints.py` in `cheap-flights` points to **v5**; the site uses **v6**. The
same repo's `azul_headers_generator.py` already pointed to v6, so inside it the
two disagreed with each other.

Headers the application sets (the rest come from the browser):

| header | what it is |
|---|---|
| `authorization` | session token, generated in step 2 |
| `ocp-apim-subscription-key` | the gateway's public key (32 chars, comes in the site's JS) |
| `device` | `novosite` |
| `culture` | `pt-BR` |

Body the site sends:

```json
{"criteria":[{"departureStation":"VCP","arrivalStation":"REC",
              "std":"10/17/2026","departureDate":"2026-10-17"}],
 "passengers":[{"type":"ADT","count":"1","companionPass":false}],
 "flexibleDays":{"daysToLeft":"3","daysToRight":"3"},
 "currencyCode":"BRL"}
```

## 4. None of our calls get through, and the error misleads

I tried four transports, all with the same headers as the good call:

| transport | result |
|---|---|
| `fetch` from inside the page | `Failed to fetch` |
| `XMLHttpRequest` from inside the page | network error |
| `fetch` from a fresh iframe (without the site's anti-bot wrapper) | `Failed to fetch` |
| Playwright request (outside the page's JS) | **403 with an HTML block page** |

The console says *"blocked by CORS policy: No 'Access-Control-Allow-Origin'"*,
which points the wrong way. **It is not CORS.** The fourth row shows what really
happens: the request is stopped by the anti-bot and gets a block page, which, as
an error HTML, carries no CORS header. The browser then reports the symptom, not
the cause.

So here **it is not enough for the call to leave from inside the browser**, as it
was on Smiles. Only the request the site itself built gets through.

## 5. What works: hijacking the body

Intercept the site's request and replace only `postData`:

```ts
await page.route("**/availability/v*/availability", (route) =>
  route.continue({ postData: JSON.stringify(body) }));
await page.goto(deepLink());
```

Result: **200**. The request is still the site's, with everything the anti-bot
expects; only what we ask for changes.

## 6. How many dates fit one call: measured

| `criteria` | result |
|---|---|
| 1 | 200, 1 date, 20 KB |
| 6 | **200, 6 dates, 125 KB** |
| 7, 8, 9, 10, 12 | 400 `{"notifications":["GetTripAvailabilityRequestFailed"]}` |

The first round had a flaw: the bigger lists included a date the smaller ones
did not, so the 400 could come from the date, not the count. I redid it with
**7 dates squeezed inside the same range already tested as good** (days
90–125): **400 all the same**. **Six is the ceiling, and it is about the
count.** The old project's `chunks(…, 6)` was not a guess.

**`flexibleDays` does nothing.** I compared ±3 against 0 on the same 6 dates:
responses of the exact same byte size (125,150) and identical `lowestPoints` on
every date. There is no equivalent of Smiles' `calendarDayList` here: each date
costs what it costs, and a year is ⌈365/6⌉ = **61 calls per direction**.

I did not test whether the SPA can repeat the search without reloading the page.
It stays as a phase 1 optimization, and section 7 shows it stopped being
optional.

## 7. The limit that sinks the plan: 8 navigations in a row

Measuring volume before designing was the expensive lesson from Smiles, so I
tested: 30 navigations in a row, 6 dates each, clean profile.

```
# 1 | 6s  | 200 | 6 trips | 5894ms
...
# 8 | 47s | 200 | 6 trips | 4909ms
# 9 | the search simply stops firing (60s timeout)
```

**It stopped on the 9th, at ~47 seconds.**

A second probe looked at what shows on screen at that moment, instead of
counting timeouts, and the site says it plainly:

```
403 on www.voeazul.com.br/br/pt/home/selecao-voo
"Oops! Just a moment. We detected unusual activity from your IP.
 Access is temporarily limited. Please try disabling VPN, clearing
 cookies, or wait a moment. IP: <the machine's outgoing IP>"
```

Three things become clear:

1. **The block is per IP, and the page itself says so.** It is not the cookie,
   the profile or the session; clearing cookies changes nothing, whatever the
   text suggests.
2. **The whole site goes down, not just the API.** The 403 is on the navigation;
   the search is not even attempted.
3. **It lasts long.** From the first block to the last attempt more than half an
   hour went by, and it was still blocked.

It is the same shape as Smiles' 406, with one important difference: there the
ceiling was ~100–150 requests; here **8 navigations in 47 seconds** were enough.

That sinks the naive design: **61 navigations in a row will not happen.** A year
per direction needs something else:

- **measure whether the interval matters.** 8 navigations in 47s is ~6s apart,
  fast for a human. On Smiles the pace changed nothing (the budget was about
  volume), but there the message talked about requests and here it talks about
  *"unusual activity"*. **It is the first test to run**, and it has to wait for
  the block to pass;
- find out whether the SPA redoes the search without reloading; if the cost is
  in the navigation and not in the query, everything changes;
- or accept smaller windows per search, as Smiles ended up.

**None of this is answered.** Until it is, the module has no known cost, and
promising "a whole year" would be making it up.

## 8. Response shape and its traps

```
data.trips[]                       one per requested date
  .std                             the date
  .fareInformation                 {lowestPoints, highestPoints}  ← cheap summary of the day
  .journeys[]
    .identifier                    {carrierCode, flightNumber, std, sta, duration, connections}
    .fares[]
      .available, .classOfService, .cabin, .productClass {code, category, name}
      .paxPoints[]                 .amountLevel 1..5
        .levels[]                  .points {amount, discount{…}, discountedAmount},
                                   .taxesAndFees, .convenienceFee, .totalMoney
    .segments[].legs[].legInfo     {capacity, lid, sold, remainingSeats}
```

Four things that need an explicit decision in the module, not a default:

1. **`amountLevel` goes from 1 to 5**: the points↔cash ladder. Level 1 is "all
   points"; from 2 on cash comes in (`fareMoney` > 0). Comparing different
   levels is adding different currencies.
2. **`points.discount.applied: true`** with `restriction: "DiscountForContactPax"`:
   the value shown already carries a customer discount. There is `amount`
   **and** `discountedAmount`; both must be kept, otherwise the alert announces
   a price not every passenger gets.
3. **`remainingSeats` is the leg's physical seats** (`capacity - sold`), **not**
   award seats at that points level. Calling it "available seats" in the alert
   would be a lie.
4. **The fee comes split**: `taxesAndFees` + `convenienceFee`. Adding them
   silently, or showing only one, changes the number the client sees.

## 9. `cabin` comes `null` on domestic routes

On VCP→REC every `fares` entry came with `cabin: null` and
`productClass.category: "Regular"`. The cabin distinction probably only shows up
on international routes; **it must be confirmed before the module promises a
cabin filter.**

## Fixtures

- `fixtures/azul-real.json`: one date (the site's original call)
- `fixtures/azul-real-multidata.json`: six dates (hijacked call)

# Iberia recon (phase 0): notes

> Gathered on 2026-08-18 with `npx tsx scripts/recon-iberia.ts GRU MAD`, on a
> new Chrome profile, no login and no inherited cookie.

## One-line summary

**The Avios search needs an Iberia Club account.** Clicking Search with "Pay with
Avios" checked calls no availability at all: it asks for a login, in 2026-08 by
redirecting to `login.iberia.com`, since 2026-09 through a modal on the home page
itself (see 4.1). The rest of the path is clear; that is all that is missing.

## 1. The old project's block is not ours

`cheap-flights` went after the iOS app's API and died because of Akamai:
`_abck`/`bm_sz` cookies pasted by hand and an `X-acf-sensor-data` that only the
native app knows how to sign. None of that hits us, because the site is what
builds the request.

Two signals confirm it:

```
POST https://ibisauth.iberia.com/api/auth/realms/commercial_platform
     /protocol/openid-connect/token          → 200, grant_type=client_credentials
GET  https://ibisservices.iberia.com/api/rdu-loc/rs/loc/v1/location/areas/origin/
```

- The **same token endpoint** the old project called with a pasted cookie is
  called by the home page on its own, anonymously, and gets 200.
- The site uses the **same `ibisservices.iberia.com` host** as the app's API. The
  endpoint map gathered there probably still holds.

No anti-bot challenge showed up in any of the runs.

## 2. Where it stops: login

Form filled (GRU→MAD, date, 1 adult), `paywithAvios` checked, click on
`#buttonSubmit1`:

```
Final URL: https://login.iberia.com/IDY_LoginPage?...&market=BRpt&startURL=...
Title:     Iberia Login
Text:      "Faça o login … E-mail ou Num. Iberia Club … Senha"
```

**No availability call happens before that.** The redirect comes from the Avios
handler itself.

Control run (`WITHOUT_AVIOS=true`): without checking Avios the search does not
leave the home page, but that is **inconclusive**, because it probably hits the
calendar validation (see section 4), not the login. So: I know Avios requires a
login; I do **not** know yet how the cash search behaves.

## 3. The cookie notice blocks everything, and has no reject button

This is what stalled the first attempts, and the symptom misleads: clicks
timing out on visible fields, and forced clicks with no effect.

```js
document.elementFromPoint(630, 232)
// → div.onetrust-pc-dark-filter.ot-fade-in
```

The banner covers the whole page with a filter that intercepts every click. And
the only buttons are **"Aceitar todos os cookies"** and **"Definições de
cookies"**; there is no "Reject all", even though the banner text mentions one.

The script **accepts nothing**: it removes the overlay and moves on. The banner
stays unanswered, which is the closest to "did not consent" possible without
clicking accept.

## 4. Form details (for whoever touches it)

| what | how |
|---|---|
| origin / destination | `#flight_origin1` / `#flight_destiny1`, autocomplete: type, ↓, Enter |
| trip | `#ticketops-seeker`: `Ida e volta`, `Só ida`, `Stopover`, `Múltiplos trajetos` |
| Avios | `#paywithAvios`: a direct click does not take; only `checked = true` + events |
| dates | `#flight_round_date1` / `#flight_return_date1`, DD/MM/YYYY format |
| cabin | `#tarifa1`: `R` (cheapest), `N` (premium economy), `B` (business) |
| search | `#buttonSubmit1` (the visible button is a magnifier; the "Pesquisar" text is internal) |

Two traps: **the profile keeps the form state between runs** (the control run
without Avios ran with Avios on the first time and lied), and **typing in the
date field is not enough**: the value shows, but the calendar keeps its own
internal state.

## 4.1. Behavior change (2026-09-22)

The Avios search **no longer redirects** to `login.iberia.com`: it opens a
**modal on the home page itself** ("Acesso a Iberia Club"), without changing the
URL. A whole run died because of it: the recon only recognized the login by the
URL, concluded nobody had asked for anything and gave up after 25s, with the
modal on screen.

What still holds: no availability call goes out before the login, and no
anti-bot challenge showed up (the anonymous token keeps returning 200).

Today the script recognizes every path (URL, login iframe and modal) and logs
which one it recognized. When it recognizes none, it dumps the diagnosis
(frames, fields of the login box) and saves the HTML to
`fixtures/iberia-login-modal.html`.

## 5. How to log in (ready flow)

```
npm run recon:iberia GRU MAD 2026-11-16
```

The script fills the search and, when Iberia asks for a login, tries to sign in
on its own with what is in `.env` (below). Without a credential there, it
**stops and waits for you**: it brings the bot's Chrome window to the front,
warns in the terminal and checks every 3 seconds. Either way, as soon as the
session opens the recon carries on; if Iberia does not redo the search, it
repeats the form with the session already valid.

- default wait: 10 min (`IBERIA_LOGIN_WAIT_MS` changes it);
- the login stays saved in the bot Chrome's profile (`~/.chrome-bot-aa`), so it is
  **once**, not on every search.

### Automatic filling (optional)

With `IBERIA_EMAIL` and `IBERIA_PASSWORD` in `.env`, the script fills **and
submits** the form, including the two-step flow where the password only shows
up after the e-mail. The search runs with nobody in front of the machine, which
was the goal.

The bot's window still opens: if Iberia asks for 2FA or a captcha, that is where
you finish it. The credentials live only in `.env` (which is in `.gitignore`),
never in the code and never in the log.

```
# in the project's .env (already in .gitignore)
IBERIA_EMAIL=...
IBERIA_PASSWORD=...
```

Without these variables the login is entirely by hand; the script just waits.

Login selectors (Salesforce Identity), in case they change:
`input[name="loginPage:theForm:loginEmailInput"]`, `input[type=password]`,
`input[name="loginPage:theForm:loginSubmit"]`.

If the "profile in use" error shows up, close the bot's Chrome with
`npm run chrome:stop` (or stop `npm run server`, which also holds the profile)
and run it again.

## 6. What is missing, and who it depends on

With a logged-in Iberia Club session, the path from here is the same that worked
on Azul: let the site make the request and swap the body. But the login belongs
to the account owner; **it is not something the bot does on its own**, and the
password does not go through here.

Until that exists, these stay unanswered:

1. which endpoint brings availability in Avios (the old project's candidate:
   `api/sse-rpa/rs/v1/availability`, on the same host the site already uses);
2. how many days come per response, the number that decides the cost of a year;
3. whether there is a price calendar (like LATAM in cash) or only day by day;
4. whether the logged-in session drops on its own, and how often.

## 7. Phase 1 done (2026-09-22): what the real response says

The automatic login from `.env` worked, and this time Iberia **redirected** (it
was not the modal): both paths exist, so the script needs both.

**Endpoint confirmed**, the same one the old project used:

```
POST https://ibisservices.iberia.com/api/sse-rpa/rs/v1/availability   → 200
{"isPetFlight":false,
 "slices":[{"origin":"GRU","destination":"MAD","date":"2026-12-15"}],
 "passengers":[{"passengerType":"ADULT","count":"1"}],
 "marketCode":"BR","preferredCabin":""}
```

Headers the application sends: `authorization` (JWT issued after the login),
`x-request-appversion`, `x-request-device`, `x-request-osversion`,
`x-observations-current-page: availability`.

**One date per response.** Each call returns one `originDestination` with 5–6
`slices` (the flight options of that day), 26–32 `offers` in total. Sweeping a
year is one request per day, unless the calendar (below) works.

**The session holds.** Repeating the same call from inside the page with +1 and
+30 days returned 200 on both (`fixtures/iberia-real-plus1.json`,
`iberia-real-plus30.json`). It confirms the AA/Azul pattern: the browser is what
signs the TLS and sends the cookie.

### The new block: availability carries no price

```json
{"offerId":"AT021420261215E","bookingClass":"ECONOMY","bookingCode":"E",
 "fareFamily":"X","rbd":"E","remainingSeats":4,"fareBasis":"EATFF"}
```

A sweep of the whole file: **no value, Avios, fee or currency field.** The old
project's `models.py` read `offer.totalPrice.fare`, a field that does not exist
in this response. One more case of imagined schema, now measured.

This matters because `FormattedDay.valueK` is a required `number` in
`src/core/common.ts`: **without a value per day there is no legitimate
`ReportSection`**, and inventing a placeholder is exactly the failure this
repository forbids.

Two leads on where the number may be, neither verified:

- the body sent **has no Avios marker** (no `pagoAvios`), although the page URL
  has `pagoAvios=true`; the redemption context might travel in the bearer;
- `POST /api/sse-rpa/rs/v1/calendar` exists and returned **404 with
  `marketCode: BR`**; it was never repeated with another market.

### A trap in the recon itself (fixed)

The response was paired with the request **by URL**, and the page calls
`/availability` twice (marketCode BR and then US). That may have glued one
request's response to the other: `iberia-real.json` says
`contextMetadata.country: "US"` with `marketCode: "BR"` in the body. **Treat that
file as suspect**; the two replay files (`+1`/`+30`) come from isolated calls and
are reliable. Pairing is now by request identity.

## 8. The run that searched the wrong airport (2026-09-22)

A whole run was lost and **almost passed as a valid result**: the destination
autocomplete picked **Madison (MSN)** instead of Madrid (MAD), and the screen
answered "we did not find exclusive Iberia Club seats", the right answer to the
wrong question.

Cause: typing `MAD` lists Madrid **and** Madison, and the script did
`ArrowDown + Enter` blindly, taking the first item of the list. Now the option
is picked by code (`\bMAD\b`, which rejects "Madison (MSN)"), and, what really
matters, **the result URL is checked** against what was asked
(`BEGIN_CITY_01` / `END_CITY_01`). If it differs, the script discards it and says
why.

Three useful things came out of it anyway:

1. **`204` is "no availability", not an error.** The availability call with
   `marketCode: US` returned 204 with an empty body. No data and a failed search
   are different states; the bot will need that distinction.
2. **`/calendar` returns 404 on both markets** (BR and US). *(Two corrections:
   the 404 is semantic, see section 9; and the right route is `/calendar/grid`,
   see section 10, which is the one that brings the price and the date range.)*
3. **The flow IS a redemption.** The message talks about "exclusive Iberia Club
   seats", so the `/availability` that returned 200 in the previous run really is
   award availability, and it still brings no price.

## 9. Clean run (2026-09-22): what closed and what did not

Destination checked through the URL (`END_CITY_01=MAD`), automatic login, three
availability responses paired correctly.

**The price is not in the availability, confirmed on three responses.** Every
offer has exactly these fields:

```
offerId, bookingClass, bookingCode, fareFamily, rbd, remainingSeats, fareBasis
```

No value, Avios, fee or currency field at any level of the JSON.

**The redemption context does not travel in the bearer.** The claims of the
availability call's token are those of a plain web session:

```
azp = iberia_web | scope = profile email | typ = Bearer
exp, iat, jti, iss, sub, sid, acr, realm_access, email_verified, preferred_username
```

Nothing about Avios, redemption or loyalty. The hypothesis that the redemption
went in the token is ruled out.

**The calendar's 404 is semantic, not a missing route.** The body says:

```json
{"errors":[{"code":"SSE_RPA_10402",
            "reason":"Disponibilidade não encontrada para a pesquisa selecionada."}]}
```

Tested with `marketCode` BR, US, ES and GB, all four the same. *(Solved in
section 10: insisting paid off, but the path was another route,
`/calendar/grid`.)*

### Where to look for the Avios number (next run)

The capture filter only looked at `ibisservices` and `ibisauth`. If the price
came from another route of the site it was invisible; the filter now takes any
`*.iberia.com` host, except static files and trackers. Along with that, the
recon now prints **the Avios values rendered on screen**: if the page shows the
number and no captured response contains it, the math happens on the client
(Iberia redeems by distance chart), and then the source needs another path.

## 10. The finding that changes the design: `/calendar/grid` (2026-09-22)

The **"Vista mensal de voos"** link, on the selection screen, fires:

```
POST https://ibisservices.iberia.com/api/sse-rpa/rs/v1/calendar/grid   → 200
```

The response (`fixtures/iberia-monthly-0.json`, 8 KB) brings **191 days in a
single call**, from 2026-09-22 to 2027-03-31, six months, in this shape:

```json
{"contextMetadata":{"language":"pt","country":"US"},
 "outbound":{"slice":{"origin":"GRU","destination":"MAD"},
             "availabilityCalendar":[
               {"date":"2026-09-22","lock":false},
               {"date":"2026-10-18","avios":28150,"lock":false},
               {"date":"2026-10-26","avios":18000,"lock":false}]}}
```

**93 of the 191 days carry `avios`** (18,000 to 50,500 in this search). The field
simply does not exist on days without availability, which matches the house
rule: missing data is missing, not zero.

### Why this solves two problems at once

**The price showed up.** `/availability` has no price at all and neither does
its screen (only the "0 Avios" balance in the header). The Avios number lives
here.

**The cost dropped by an order of magnitude.** The previous reading, "one
request per day, 359 per year", is **wrong**. It takes ~2 calls to cover a year.

### Design this suggests for the source

The same two-layer shape AA already uses in this repository:

1. `/calendar/grid`: which days have awards and for how many Avios (1 call per
   ~6 months). Gives `date` + `valueK`.
2. `/availability`: only on the days that matter, for `remainingSeats` per
   flight.

Still to confirm before writing the source: the request **body** of
`/calendar/grid` (step 8 of the recon only printed URL and size; fixed), whether
it accepts a window longer than 6 months, and whether `lock: true` means a
blocked date.

## 11. The search stopped answering after many runs (2026-09-22)

After ~9 recon runs in about 90 minutes, the search started landing on:

```
URL: ...#!/ibbkerror
"Lamentamos, não podemos mostrar os voos. Por motivos alheios à Iberia,
 é impossível mostrar a disponibilidade de voos neste momento"
```

The search's four calls (`/availability` and `/calendar`, on both markets) were
left with **no status and 0 bytes**: no response arrived, it is not an HTTP
error with a body. Before that, the same calls came back 200 with 27 KB.

**Two explanations fit what was observed, and they were not told apart:** a
frequency cut (the most likely, given the pace) or a session in a bad state after
two logins within a few minutes, a consequence of the modal detector's false
positive, which made the script log in again for no reason.

What it is **not**: anti-bot in the `cheap-flights` sense. No challenge, no
403, in any of the day's runs.

To decide between the two: wait 30+ minutes and run **once**. If it comes back
clean, it is frequency, and then the `RateLimiter` interval needs measuring
before writing the source.

Whatever the cause, one thing is established and applies to the design:

- **A missing `status` with 0 bytes is a third state**, different from 200 (has
  availability) and 204 (has none). Treating it as "no availability" would send
  "found nothing" to the client when the search never went out; it is the same
  mistake as the HTTP 400 with two meanings that AGENTS.md lists. The source's
  `SourceResult` must carry that case.

## 12. Provenance of the fixtures (important)

- `iberia-monthly-0.json`: **reliable**. It came from a clean run; it is the main
  finding (section 10).
- `iberia-real-plus1.json`, `iberia-real-plus30.json`: **reliable**. They come
  from the replay, which fires one isolated call at a time.
- `iberia-real.json`: **use with care**. It was overwritten several times during
  the day; the version on disk (27688 bytes) came from the run that got lost
  going to the US home page after the modal's false positive. The shape matches
  the other two, but if any detail matters, record it again.

## 13. Phase 2: the source works (2026-09-22)

`src/scrapers/iberia/iberia.scraper.ts` + `scripts/search-iberia.ts`
(`npm run iberia GRU MAD 40000`). A real one-year sweep:

```
Calendar from 2026-09-23:  42 days, until 2026-12-31
Calendar from 2027-01-01: 120 days, until 2027-04-30
Calendar from 2027-05-01: 189 days, until 2027-08-31
Calendar from 2027-09-01:  99 days, until 2027-09-30

Window 2026-09-23 → 2027-09-30 · 248 days with awards · 18K to 50.5K Avios
```

**The window moves with the body's `date`**, a question that was open. A year
takes **4 calls**, not 359.

### Three things that only showed up running for real

1. **401 without the bearer.** `ibisservices` requires `authorization: Bearer`,
   which the SPA keeps in memory (it is not a cookie), so a `fetch` from inside
   the page does not inherit it. The source listens to the requests the page
   itself makes and reuses the token from there. Without a token, a named error
   instead of an empty search.
2. **`ERR_ABORTED` on `goto` is normal.** The site rewrites the URL during
   navigation; what decides whether it worked is the final URL, not what `goto`
   returns.
3. **The hash route takes a while to settle.** Checking once 8s after load
   catches an intermediate state; the source waits for the URL to become
   `#!/availability` or `#!/ibbkerror` before judging.

And the earlier `#!/ibbkerror` was **transient**: after the pause, the URL the
source builds reached the results just like the one the site builds (tested side
by side in `scripts/test-iberia-url.ts`).

### `lock: true`: what is known

It showed up on 13 days of the one-year sweep. **None of them had `avios`.** The
source discards a locked day and only declares the result partial when the
discarded day HAD a price; a locked day without an award is no loss and does not
become noise.

### What this source still does not do

**It does not split cabins.** The grid has `preferredCabin: ""` and returns one
number per day, the cheapest, without saying which cabin. AA searches per cabin
and knows what it is looking at; here it does not. Splitting needs the second
layer (`/availability`, which brings `bookingClass` per offer) and a product
decision.

**It does not bring seats**, for the reason documented at the end of
`iberia.scraper.ts`: price and seat come from different calls and there is no
way to link one to the other through the data.

**It is not in the server or the front**; it runs through the script.
Integrating it is phase 2b. *(Done since: the source is in the server and has
its own tab.)*

## 14. Flight layer: what blocks it (2026-09-23)

The second layer (`/availability`, one request per date) is written and typed,
but **does not run end to end**. It ships off (`--days=0`).

What was measured, in order:

1. **`fetch` from the tab, tab on the search** → works (that is how the recon
   did it).
2. **`fetch` from the tab, tab sent to the login** → `TypeError: Failed to
   fetch`. It is not a block: it is cross-origin, because the tab is no longer on
   `www.iberia.com`.
3. **Playwright's `context.request`** (does not depend on the tab) → **401**,
   with the SAME bearer and the SAME headers `/calendar/grid` accepts. Something
   of the session only exists in the tab's context.
4. **Real headers copied from the site** (`x-request-appversion`,
   `x-request-device`, `x-observations-*`) → did not change item 3's 401.

And the underlying cause: **Iberia's session drops within a few minutes.** The
calendar (4 calls, ~1 min) finishes fine; by the time the detail starts, the tab
has already been sent to `login.iberia.com`, and reopening the search goes back
to the login. Logging in again from `.env` (implemented in `ensureLoggedIn`) did
not solve it: the tab is sent to the login again right after.

Paths not tried yet, for whoever picks this up:

- run the detail **together** with the calendar, within the same healthy session
  window, instead of after it;
- find out why `context.request` gets 401: compare the real headers byte by byte
  (including `origin`/`referer`) with the ones it sends;
- accept Salesforce's `RemoteAccessAuthorizationPage` screen once by hand and see
  whether the session drop stops.

## 15. `preferredCabin` is ignored by the calendar (2026-09-23)

Measured with `scripts/probe-iberia-cabin.ts`: same route, same date, same token,
changing only the body field.

```
preferredCabin=(empty):   100 days, 42 with price, 18000 to 35100 Avios
preferredCabin=BUSINESS:  100 days, 42 with price, 18000 to 35100 Avios
preferredCabin=ECONOMY:   same   | TOURIST: same | PREMIUMTOURIST: same | FIRST: same
```

An **identical** response on all six. `/calendar/grid` cannot answer per cabin;
the value is always the day's cheapest, whatever the class.

The consequence for the product is serious: **there are no "business dates" with
a business price on this source.** The front's cabin selector only filters the
flight spreadsheet (through the `bookingClass` of the `/availability` offers).
That is why the job now returns an explicit notice with the result when a cabin
is chosen: an economy number announced as business is an error that reaches the
client.

A possible path, not explored: finding out whether a day has a business award
needs that day's `/availability` (~15s each). It works for a short list of
dates, not for sweeping a year.

## 16. Detail at scale: Iberia cuts off around 40–60 queries (2026-09-28)

An attempt to return to `cheap-flights`' pace (batches of 30 every 7s on
`/availability`), now from inside the tab, which is what gets past the anti-bot.
Measured with `scripts/measure-iberia-batches.ts`, GRU→MAD, ~247 dates,
logged-in session, right after the calendar, with a 10–20 min pause between
runs:

```
30 in parallel:              all "Failed to fetch" in 1.2s (after 15 ok)
batches of 10, 7s pause:     1st batch 10/10; 2nd batch 6/10
batches of 5, 8s apart:      ibbkerror screen on day ~30; final cut at ~40
1 at a time, every 3s:       final cut on day 59 (8.3 min), 9 retries before
```

The cut shows up as `TypeError: Failed to fetch` with the tab still on
`www.iberia.com/flights/`: it is not the session dropping, it is the site
refusing. Reopening the search at that point lands on the "não podemos mostrar
os voos" error screen.

Reading: **the pace changes the total little.** A burst is cut right away;
spacing moves the cut from ~40 to ~60 queries, not to 247. It looks like a quota
per time window (or per session), not a speed limit. Not measured: whether a new
login resets the quota, and how long a pause gives it back.

Consequence: the old bot's "every date detailed" does not fit in a single run.
The detail became sequential (`IBERIA_DETAIL_BATCH`, default 1), which is
lighter than the per-day page load it replaced.

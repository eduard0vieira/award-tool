# Award Tool: project context

Internal tool of a travel agency that issues tickets with miles. It sweeps award
availability across several sources and returns the dates with availability
under a miles/price ceiling, in the format we use to notify the clients' group.

No credentials here: everything related to login lives in `.env` (keys below,
values left out).

---

## 1. What it does today

Each source has its own tab in the front:

| Source | What it is | Login | How it extracts |
|---|---|---|---|
| **AwardTool** (TAP) | paid aggregator | yes (user/password in `.env`) | real navigation of the page |
| **SeatSpy** | paid aggregator, 9 programs (AF, B6, BA, CX, EY, IB, KLM, QF, VIR) | yes | intercepts the network response of the internal API |
| **American** | aa.com, award search | no | `fetch` from inside the page on the calendar endpoint |
| **LATAM** | latamairlines.com | browser session | calendar endpoint (cash) + real search (miles) |
| **Smiles** | smiles.com.br (GOL) | browser session | the site's own search API, one day per request |
| **Iberia** | iberia.com, Avios | yes | monthly calendar + optional flight detail |

Every source has the same output: `min`, `max` and the list of dates grouped by
month, `Ago 2026: 07 (9), 25 (3)` (on SeatSpy the number in parentheses is the
seat count). The format exists because it is exactly what the alert generator
already knows how to read.

**Request volume per search:** ~13 (a 12-month sweep, one month per request),
with a rate limiter between them: 15s on AwardTool, 8s on LATAM, 6s on AA.

---

## 2. How it runs today

**On my machine, by hand.** No VPS, no cron, no deploy.

```
npm run server     # NestJS with --watch → http://localhost:5555
npm test           # server end to end with a fake source, no browser
npm run chrome     # opens a Chrome with a dedicated profile + debugging port
npm run tunnel     # ngrok, when I want to trigger searches from my phone
```

I open the browser on `localhost:5555`, fill origin/destination/cabin/ceiling and
click search. Each search becomes a card in the tab's queue, with a progress bar
fed by SSE. Several can run at once (session pool: 3 AwardTool, 3 SeatSpy, 2 AA,
2 LATAM), and switching tabs does not drop the others' progress.

The server requires a login precisely because, when it is exposed through
ngrok, anyone who found the URL could trigger searches on the paid accounts.
Each person has a user in the database (`SEED_USERS` in `.env` creates the
missing ones on start; `scripts/set-password.ts` changes a password). The page
at `/login` sets a signed, HttpOnly, SameSite=Strict session cookie that lasts
30 days; changing someone's password ends only that person's sessions. The
`BOT_AUTH_USER`/`BOT_AUTH_PASS` pair is the machine credential, accepted only as
Basic in the header, because the alert renderer and `scripts/run-server.ts`
use it. The cookie is signed with `.session-secret` (created on first start,
never committed). `LOGIN_DISABLED=true` turns the login off for local work.

**Stack:** TypeScript + Node, NestJS (on Express) running through the SWC
loader, class-validator on request bodies, Playwright, Prisma 7 on SQLite
(`better-sqlite3` driver adapter). The front is plain HTML + JS, no framework, no bundler:
`public/index.html` + `public/app.js`.

```
src/
  scrapers/                  one folder per program; this is where scraping lives
    tap/tap.scraper.ts         AwardTool/TAP
    seatspy/seatspy.scraper.ts SeatSpy (9 programs)
    aa/aa.scraper.ts           American
    latam/latam.scraper.ts     LATAM (calendar in R$ + confirmation in miles)
    smiles/smiles.scraper.ts   Smiles/GOL
    iberia/iberia.scraper.ts   Iberia (Avios)
  core/                      what every source uses
    common.ts                  rate limiter, date formatting, types
    chrome-session.ts          one Chrome per process (CDP or its own profile)
    session-pool.ts            reuses logged-in sessions across searches
    paths.ts                   every disk path comes from here
  outputs/                   what becomes a deliverable
    alerts.ts                  generates the alert image from the result
    spreadsheet.ts             CSV + Google Sheets (one tab per search)
  server/                    NestJS app
    main.ts                    boots the app; configure-app.ts wires the login, static files, filter and validation
    jobs/                      job state, SSE events, pool queue, cancel/answer
    search/                    POST /api/searches: picks the source in the registry and validates with its DTO
    sources/<source>/          one Nest module per source: session pool, DTO and runner
    alerts/                    POST /api/alerts
  cli.ts                     search from the terminal, no server
public/                      front (plain HTML + JS, no bundler)
docs/                        this document and the recon notes
scripts/                     recon, probes and setup (not part of the server)
fixtures/                    raw API responses, to work on a parser without spending requests
prisma/                      database schema
```

**Why this way:** one source per folder because that is the unit where work
happens. When Smiles changes its schema, everything that has to change is in one
place, and nothing in `core/` should need to know Smiles exists. Dependencies
only point inward: `scrapers/` and `outputs/` use `core/`, `server/` uses all
three, and `core/` imports nothing.

---

## 3. Storage

- **SQLite in `data/bot.db`** (Prisma, schema in `prisma/schema.prisma`). The
  server applies pending migrations on every start, so a pulled migration is in
  place before anything queries it. Backup is copying that file.
  - `User`: one row per person, scrypt password hash.
  - `Search`: every search started, with who started it, its normalized request,
    status (`queued`, `running`, `done`, `partial`, `error`, `cancelled`) and the
    final result. Read through `GET /api/history` and `GET /api/history/:id`.
    Results older than `SEARCH_RESULT_RETENTION_DAYS` (30) lose the payload and
    keep the row.
- **Identical searches.** Each source declares an `identity()`; with the
  source and the day in São Paulo it forms the search key. A request whose key
  is already running joins that job instead of starting another. With
  `reuseRecent: true` in the body, a finished, non-partial identical search from
  the last `SEARCH_REUSE_HOURS` (6) comes back as an already finished job; the
  current front never sends it, so this waits for the front's "search again"
  button.
- **Jobs in memory**: a `Map<jobId, {...}>` in the process. Restart the server
  and everything that was running is gone; the history marks those as errors.
- **The front's own history** still lives in the browser's `localStorage`
  until the front reads `/api/history`.
- **Alert images on disk**, in `./alerts/<timestamp>-<class>/`.
- **Search log** in `./spreadsheets/buscas.csv`, one row per day found, and in
  Google Sheets when configured.
- No record of what was sent, when, at what price. **"Is this route cheaper
  than last month?" cannot be answered**: the data is gone once I close the tab.
  The `Search` table now keeps the results; nothing reads them for that yet.

---

## 4. Where manual work still comes in (this is where it hurts)

End to end, today:

1. **I decide which routes to search** and type them one by one. There is no
   list of monitored routes; it is memory and feeling.
2. **I trigger each search by hand.** One form at a time, per cabin. A
   round-trip sweep of one cabin takes ~2–4 min; a work session is dozens of
   them.
3. **I read the result and decide what becomes an alert.** No criterion in code:
   I look at the lowest value and compare it with what I remember was normal for
   that route.
4. **I click "generate alert"** per cabin, **download the images**, open
   WhatsApp and **forward them to the group** with the caption. That is 100%
   manual.
5. **The LATAM alert takes its price from the miles confirmation**: without a
   confirmed pair there is no button, since a card without the points number
   would carry a blank price.
6. **Session maintenance:** when AA or LATAM start blocking, I run
   `scripts/import-cookies.sh <domain>`, which copies that domain's cookies from
   my everyday Chrome into the bot's profile.
7. **Nothing deduplicates against what was already sent.** If I search and
   alert the same route twice in a week, the group gets it twice.

**Where the biggest gain is, as I read it:** steps 1, 2 and 4. A route list +
scheduled sweep + comparison with the previous round would turn this into "in
the morning there is a folder with the alerts worth sending, I review and
forward".

---

## 5. How the alert is generated (the part already automated)

There is a second repository, `vcc-alertas-portal` (React + Vite), the alert
image generator the team uses by hand. Instead of reimplementing the card layout
in the bot, and ending up with two templates drifting apart, the bot **reuses
the portal**:

- the bot's server serves the portal's `dist/` under `/portal`;
- the portal gained a public `?render` page, which builds the card from a JSON
  serialized in the URL hash (no Supabase, no login);
- `alerts.ts` opens that page in a headless Chromium, screenshots the
  `#render-card-N` elements and reads the ready WhatsApp caption.

```ts
const url = `${baseUrl}/portal/?render#dados=${encodeURIComponent(JSON.stringify(route))}`;
// ... screenshot of #render-card-0, -1 ... + #render-combo (outbound+return combinations)
// file name identical to the portal's manual download: alerta-GRU-MIA.png
```

The `dados` hash key and the fields inside it are the portal's contract and stay
in Portuguese.

Result: the bot's alert comes out identical to the one made by hand, with the
same file name. **Only the forwarding is still manual.**

---

## 6. What breaks, and how I find out

I find out **by looking**: the card turns red or the result looks odd. There is
no structured logging, no metrics, no failure alerting. What exists is
`console.log` in the server terminal and a partial-result notice on the card.

By frequency:

1. **American's anti-bot (Akamai).** The most expensive problem of the project.
   The ladder I worked out empirically: Playwright's Chromium → 403 right away;
   real Chrome with the automation flag hidden + warming up on the home page →
   passes; a request made outside the browser → 403 (the TLS is not Chrome's);
   `fetch` from inside the page → 200. And the final root cause: **Akamai blocks
   any browser that does not have its cookies**, even a clean Chrome with no
   automation at all. Hence the cookie import script.
2. **Session/cookie expiring** (mostly LATAM). Symptom: the miles confirmation
   step fails. Fix: import the cookies again.
3. **LATAM screenshot failing** (the fare panel closes when the page scrolls).
   It used to cost me the whole search; today there is a layered fallback, so
   the screenshot can fail while the dates (the expensive part) survive.
4. **Stale server in memory.** It caught me twice: the front files are read from
   disk on every request, so an interface change shows up immediately, but the
   server and scrapers kept the old code. I would see the new field on screen
   and it silently did nothing. Mitigated with `node --watch` + showing in the
   result the value that was actually applied.
5. **A route that does not exist on the source.** It used to hang until a
   timeout; today it answers right away with an error naming the airline and
   the route.

The class of bug I fear: **a failure that looks like an empty result.** I found
one on AA: status 400 means both "this month is not on sale yet" and "your
request is wrong", and the code handled both the same way. A refused request
would stop the sweep at the first month and come out as "no availability", with
no error at all. Fixed by reading the reason in the response body.

---

## 7. Code that shows the structure

**Common output type** (`src/core/common.ts`): what makes every source fit the
same front and the same alert generator:

```ts
export type ReportSection = {
  min: number | null;
  max: number | null;
  days: FormattedDay[];       // chronological
  text: string;               // "Ago 2026: 07 (9), 25 (3)"
  unit?: "K" | "BRL";         // LATAM in cash; absent = miles
};
```

**AA extraction**: the calendar does not depend on session state, so the year
can be swept by changing only the date:

```ts
const result = await page.evaluate(async (body) => {
  const response = await fetch("/booking/api/search/calendar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}, calendarRequestBody(params, departureDate));
```

**LATAM in two phases**: the cash calendar is cheap (6 requests cover the year,
each response brings 2 months in both directions) and is used to find
candidates; only the best outbound/return pair is confirmed in miles with a real
search, which produces the screenshot. The premise is that a flight cheap in
cash is cheap in miles.

**Session pool**: each source has a pool that reuses the logged-in session
across searches, because logging in again for every search is slow and draws
the anti-bot's attention. An idle session also costs: a SeatSpy one measured
here sits at ~450 MB idle, and the server stays up for days. So a slot closes
its session after `IDLE_MINUTES` without use and recreates it on the next
search; reopening costs ~6s (launch + login), paid once per burst. AA, LATAM and
Smiles share a single Chrome, so for them idleness only closes the tab.

---

## 8. Configuration keys (names only)

See `.env.example` for the full list.

```
LOGIN_URL, EMAIL_ACCOUNT, PASSWORD_ACCOUNT        # AwardTool
SEATSPY_LOGIN_URL, SEATSPY_EMAIL, SEATSPY_PASSWORD
BOT_AUTH_USER, BOT_AUTH_PASS                      # machine credential (alerts, supervisor)
SEED_USERS                                        # people's users, created on start if missing
LOGIN_DISABLED                                    # true turns the login off (local only)
SEARCH_REUSE_HOURS, SEARCH_RESULT_RETENTION_DAYS  # identical-search reuse and history size
*_CONCURRENCY                                     # simultaneous jobs per source
IDLE_MINUTES                                      # closes an idle session (0 turns it off)
*_SEARCH_INTERVAL_MS                              # rate limiter
AA_CHROME_PROFILE, AA_CDP_PORT                    # the bot Chrome's profile/port
```

## AA: calendar code 309

`POST /booking/api/search/calendar` answers **HTTP 200 with `error: "309"` and
`calendarMonths: []`** when there is no award that month for the route. It is
missing data, not a failure: measured on 2026-09-25 with HEL→NRT business, where
September to January give 309 and July 2027 gives 23 days at 75,000.

Treating it as an error made the sweep give up after three months in a row and
return "no availability" for the whole year on a seasonal route.

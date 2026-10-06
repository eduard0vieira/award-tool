# Always-on server on a Windows notebook

The bot runs on an old notebook that stays on, instead of on a personal machine.
Colleagues reach it through an ngrok tunnel, and new commits on `main` reach it
on their own.

Written on 2026-10-06 for an Asus with an i5-6200U, 8 GB of RAM, an SSD and
Windows 10/11. **The project had never run on Windows before this guide**: expect
small fixes on the first day.

## What runs

- `scripts/start-server.cmd`, started by the Task Scheduler when the user logs on.
- It runs `scripts/run-server.ts`, the supervisor, which:
  - starts the server and brings it back 10 s after it dies;
  - every 5 min fetches `origin/main` and, when there is a new commit and no
    search is running (`GET /api/searches/active`), fast-forwards, runs `npm ci`
    if `package-lock.json` changed, and restarts the server.
- ngrok, as a second scheduled task, exposes port 5555 on a fixed domain.

Everything logs to `logs\server.log`.

## Steps that need a person

A Claude Code session on the notebook can do the rest, but not these:

- copying `.env` (and the Google credentials file, if the spreadsheet is used)
  from the main machine, by pen drive or another private channel, never by git;
- copying the alert portal build (see below);
- creating the ngrok account and its fixed domain;
- logging in to the sites that need it inside the bot's Chrome window;
- choosing whether Windows signs in on its own after a reboot.

## 1. Windows

- Power options, plugged in: never sleep, never turn off the disk. Closing the
  lid: do nothing.
- Optional: disable the "Windows Search" service. Indexing is useless here and
  was one of the processes using CPU on the first boot.
- Ideally a separate Windows user for the server. If the notebook is shared,
  everyone using it must know the bot's Chrome window must not be closed.

## 2. Install

In PowerShell:

```powershell
winget install Git.Git
winget install Google.Chrome
winget install ngrok.ngrok
```

Node: install **20 LTS** from nodejs.org (the version the project runs on
macOS). Playwright drives the installed Chrome (`channel: "chrome"`), so
`npx playwright install` is not needed.

## 3. Code

```powershell
mkdir C:\bot
cd C:\bot
git clone https://github.com/eduard0vieira/award-tool.git
cd award-tool
npm ci
```

The alert generator serves the portal build from the sibling folder
`C:\bot\vcc-alertas-portal\dist` (`PORTAL_DIST_DIR` in `src/core/paths.ts`).
That repository is private and its build needs its own `.env`, so copy the
`dist` folder from the main machine instead of building it here. Copy it again
whenever the portal changes.

## 4. `.env`

Copy the main machine's `.env` to `C:\bot\award-tool\.env`, then change:

- one search at a time per source, so 8 GB holds while someone else uses the
  notebook:

  ```
  AWARDTOOL_CONCURRENCY=1
  SEATSPY_CONCURRENCY=1
  AA_CONCURRENCY=1
  LATAM_CONCURRENCY=1
  SMILES_CONCURRENCY=1
  IBERIA_CONCURRENCY=1
  ```

- `GOOGLE_CREDENTIALS` to the Windows path of the copied credentials file;
- keep `BOT_AUTH_USER` and `BOT_AUTH_PASS` set: the tunnel makes the server
  public.

## 5. First run, by hand

```powershell
cd C:\bot\award-tool
npx tsx scripts/run-server.ts
```

Open http://localhost:5555 and run one short search per source. The bot opens
its own Chrome window; log in there where a source asks for it. On macOS the
AA and LATAM cookies came from `scripts/import-cookies.sh`, which is bash and
does not run here, so those logins happen in that window.

## 6. Start on log on

```powershell
schtasks /Create /TN "Award Tool" /TR "C:\bot\award-tool\scripts\start-server.cmd" /SC ONLOGON
```

Then, in the Task Scheduler, open the task and:

- leave "Run only when user is logged on": the bot's Chrome needs a desktop;
- uncheck "Stop the task if it runs longer than";
- under Settings, "If the task fails, restart every 1 minute".

After a reboot nothing runs until someone logs on. To come back on its own,
turn on automatic sign-in (`netplwiz`, uncheck "Users must enter a user name
and password"). That trades away the login screen of the notebook; decide with
whoever else uses it.

## 7. Tunnel

```powershell
ngrok config add-authtoken <token from the ngrok dashboard>
schtasks /Create /TN "Award Tool tunnel" /TR "ngrok http --url=<fixed domain> 5555" /SC ONLOGON
```

The fixed domain (one comes with the free plan) keeps the colleagues' URL from
changing.

## Updating

- Code: `git push` to `main` on the main machine. Within ~5 min, and as soon as
  no search is running, the notebook pulls and restarts. `logs\server.log` says
  `Atualizado para <commit>`.
- A change to `scripts/run-server.ts` itself only applies after the task
  restarts (log off and on, or reboot); the log says so.
- `.env` never comes through git: edit it on the notebook and restart the task.

## Known gaps on Windows

- Bash scripts do not run: `import-cookies.sh`, `open-bot-chrome.sh`,
  `stop-bot-chrome.sh`, `setup-spreadsheet.sh`. Neither does `npm test`, which
  uses `find`; run it from Git Bash.
- The supervisor's "is it idle?" check was tested with no search running; the
  busy path was not exercised live. A search started in the second between the
  check and the restart is lost.
- `logs\server.log` grows without limit.

# AGENTS.md

Permanent rules for agents working in this repository.
Specific tasks come in the chat. This always applies.

Also read `docs/CONTEXT.md`: it describes the architecture, the sources and the
real state of the system. This document covers **how to write code here**.

---

## What this project is

Internal tool of a travel agency that issues tickets with miles. It sweeps award
availability across several sources and returns the available dates in the
format used to notify the clients' group.

It is not generic software: the result goes straight to paying clients. **One
wrong piece of data in an alert costs real credibility with the client.** Prefer
failing visibly to delivering a plausible, wrong result.

---

## Core principle: a failure never disguises itself as a result

This is the most important rule of the repository. Most of this project's
historical bugs share a single cause: **missing data became a default value and
the failure passed as a valid result.**

Real examples that already happened:

- `_safe_int(default=4)`: a made-up seat count went into the client's alert
- `except: pass` in a date filter: the filter was switched off without anyone
  knowing
- Missing `Direct` field → default `False` → every flight discarded, no error
- `hasMore` not read: the first page treated as the complete result
- HTTP 400 meaning two different things, handled as one: "request refused" went
  out as "no availability"

Rules that follow from it:

1. **A field coming from an external source has no default value.** If the
   expected field does not exist, that is an error, with a message naming the
   field and the context. Never replace it with a guess.
2. **No silent `catch`.** Every catch captures a specific error, logs it with
   context, and either propagates it or marks the result as partial. Empty
   `catch {}` and `catch (e) {}` are forbidden.
3. **An incomplete result declares itself incomplete.** If any page, month or
   request failed, the result says so explicitly and does not become an alert.
4. **No data and a failed search are different states.** "No availability" can
   never be represented the same way as "the search broke".

Model this in the type, not by convention:

```ts
type SourceResult =
  | { kind: "ok"; section: ReportSection }
  | { kind: "no_availability" }
  | { kind: "partial"; section: ReportSection; reason: string }
  | { kind: "error"; reason: string; http?: number };
```

A discriminated union instead of `null`. The compiler forces every case to be
handled.

---

## Never code against an imagined schema

Every integration with an external source starts by **saving a real response to
disk** and reading what actually came. Documentation and assumptions are not a
valid basis.

A whole implementation of this project was once written against an imagined
schema, with a complete test suite built on the same assumptions. Every test
passed. The code was wrong. **A test written against the code's own assumption
tests nothing.**

Fixtures come from real responses, always.

---

## Contracts that do not break

**Date string format.** `"Ago 2026: 07 (9), 25 (3)"`: month abbreviated in
Portuguese, zero-padded day, seats in parentheses. It is a contract with
`vcc-alertas-portal` and with the alert generator. Do not invent a new format,
do not change `formatDatesByMonth`.

**Common output type.** Every source returns `ReportSection`
(`src/core/common.ts`). It is what makes the sources fit the same front and the
same generator. Do not create a parallel type.

**Rate limiter between requests.** It exists because the paid sources limit
queries and because anti-bot systems detect bursts. Do not remove it, do not
reduce it without asking.

---

## Security and data

- Credentials only in `.env`, never in the code, never in a commit.
  `.env.example` carries only the key names.
- Never commit cookies, tokens, client data or API responses containing personal
  information.
- Test fixtures are anonymized.
- The server requires a login (session cookie or Basic credentials) because it
  is exposed through a tunnel. Do not remove or weaken it.

---

## Language

**Everything is in English**: identifiers, file and folder names, comments, test
descriptions, the API's JSON fields and SSE payloads, environment variables and
documentation.

These stay in Portuguese, because translating them would break the product or a
contract:

- User-facing text: screens, displayed error messages, notices, alert captions
- The date format `"Ago 2026: 07 (9)"` and the fields the alert portal reads
- The spreadsheet column headers, which existing sheets already use

---

## Comments

The default is **none**. A comment has to justify its existence.

- Do not comment what the code already says. If a piece needs explaining to be
  understood, improve the name or extract a function
- Only comment what the code cannot say: the why of a non-obvious decision, a
  trap that already bit, the reason an order of operations matters
- No ceremonial JSDoc, function headers, step-by-step narration or section
  markers
- Long context (what was measured, what was left out) goes in the chat or in
  `docs/`, not in the file

---

## Code conventions

- TypeScript + Node. The server is **NestJS** and runs through the SWC loader
  (`@swc-node/register`), because Nest depends on decorator metadata that `tsx`
  (esbuild) does not emit. `scripts/` and `src/cli.ts` still run through `tsx`
- Every request body has a DTO validated with class-validator
- Controllers hold no business rules: they receive, validate and delegate
- DTOs and services are imported as values, never with `import type`: with
  `verbatimModuleSyntax` a type import erases the metadata and validation is
  skipped silently
- Each source has two parts: the pure scraper in `src/scrapers/<program>/`,
  which does not know Nest exists, and the Nest module in
  `src/server/sources/<program>/`, which wraps it. `src/core/` imports no source
- The front is plain HTML + JS until the planned migration to React. No other
  framework or bundler comes in before it
- Every disk path comes from `src/core/paths.ts`; never compute one with
  `__dirname` in the file itself
- Sources with a login use the session pool; sources with an official API need
  no browser at all

---

## Always ask before

- Installing a new dependency (especially a native module that needs compiling)
- Adding a database, external queue, cache or any infrastructure
- Refactoring code outside the scope of the current task
- Creating a new abstraction or layer of indirection
- Touching an existing source while working on another
- Changing `src/core/common.ts`, the output format or any contract above

---

## Commits

**One commit per change, however small.** No commit mixing a fix, a refactor and
documentation: if something breaks, `git diff` must point at a single thing.

Conventional Commits message, one line, **always in English**, as are branch
names, PR titles and PR descriptions.

```
<type>(<optional scope>): <description>
```

- Valid types: `feat`, `fix`, `chore`, `refactor`, `docs`, `style`, `test`,
  `perf`, `ci`, `build`
- Type and scope in lowercase; description in the imperative, short, no final
  period
- The scope is the source or the area: `smiles`, `latam`, `aa`, `tap`,
  `seatspy`, `iberia`, `server`, `front`, `spreadsheet`, `alerts`
- No emoji, no body and no attribution trailer (`Co-Authored-By` or session
  link). Old commits with emoji stay as they are; from here on, no

```
feat(latam): confirm miles with round-trip in a single search
fix(smiles): treat 406 as a block and return partial results
refactor: split sources into src/scrapers
docs: record the azul recon
```

---

## How to work

One phase at a time. At the end of each phase, stop, show what changed and the
result of the acceptance criterion. Do not move on without confirmation.

If something is getting more complex than seems reasonable, **stop and say why**
instead of pushing on. Unexpected complexity usually means the premise is wrong.

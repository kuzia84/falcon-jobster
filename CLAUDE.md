# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A small time-tracking web app: employees, one start/stop timer per employee, and a report for a period. Stack: Node.js >= 22.13 (ESM), Express 5, the built-in `node:sqlite` module (`DatabaseSync`), and a frontend in plain HTML/CSS/JS with no build step. Express is the only runtime dependency.

User-facing text (API error messages, UI, README, docs) is in Russian. Code comments are in English.

## Commands

```bash
npm ci --no-audit --no-fund
npm start                         # http://localhost:3000, database in data/timetracker.db
npm run seed                      # demo data, only into an empty database
npm test                          # API tests (node:test), test/**/*.test.js
npm run test:ui                   # UI tests (Playwright, Chromium), e2e/
npx playwright install chromium   # once, before the first UI run
```

Run one API test by name:

```bash
node --test --test-concurrency=8 --test-name-pattern="<part of test name>" test/api.test.js
```

Run one UI test: `npx playwright test --workers=1 -g "<part of test name>"`.

There is no linter and no build. Environment variables: `PORT` (default `3000`), `DB_PATH` (default `data/timetracker.db`). The `ExperimentalWarning: SQLite is an experimental feature` message at startup is expected.

## Architecture

Request flow: `src/server.js` (entry, opens the DB, graceful shutdown) → `src/app.js` (`createApp({ db, now })`: Express routes, input parsing, error handler) → `src/repo.js` (`createRepo(db)`: all SQL and business rules) → `src/db.js` (`openDb(path)`: schema, applied with `CREATE ... IF NOT EXISTS` on every open; there are no migrations).

Key points that need several files to see:

- **Errors.** `repo.js` throws `AppError(status, message)`. The error handler in `app.js` turns it into `{ error }` JSON with that status. Express 5 forwards errors from sync handlers, so the routes have no try/catch.
- **Clock injection.** `createApp` takes `now`. Every time value comes from `now()`, never from `Date.now()` inside the repo. API tests move a fake clock (`clock.now`) instead of waiting. Every `/api` response sends `X-Server-Time`, and the page uses it to correct the browser clock in live counters.
- **One active timer per employee** is enforced by the partial unique index `one_active_timer` in `db.js`, not by a SELECT check. A second start fails on INSERT, and the repo maps the unique violation to 409.
- **Name uniqueness** uses the `name_key` column (`toLocaleLowerCase('ru')`), because SQLite `NOCASE` folds only ASCII.
- **Time and periods.** The DB stores UTC milliseconds. The browser converts the selected dates to ISO instants in its own time zone (the "to" date is inclusive: the period ends at the next midnight). The server accepts only ISO with an explicit zone (`ISO_INSTANT` in `app.js`). The report includes entries that overlap the period and counts only the part inside it. An active timer ends at `now()`. Durations are clamped to be non-negative.
- **Frontend** (`public/app.js`) polls the API every 30 seconds, re-renders only on change, and keeps text that the user has started to type. After a 409 it reloads the current state.

## Tests

- API tests start `createApp` on port 0 with an in-memory or temp-file DB and call it over HTTP with `fetch`.
- `playwright.config.js` starts its own server on port 3457 with a new temp DB for each run (`UI_TEST_DB`). `e2e/cleanup.js` deletes DB files of earlier runs, because Windows keeps the current file locked. UI tests share one server and one database, so they run with one worker.

## Docs

`docs/architecture.md` (API table, decisions), `docs/testing.md` (what each test checks), `docs/bugs-and-reviews.md` (found bugs with causes and fixes). When you change behavior, API, or test counts, update these docs and the counts in `README.md`.

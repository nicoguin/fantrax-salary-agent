# 🏀 Fantrax Salary Agent

**A serverless, multi-league agent that keeps NBA salary-cap fantasy leagues (Fantrax) in sync with real-world contract data — and lets league members report discrepancies straight from Discord, triaged by an LLM.**

> Portfolio / showcase repository. Runs entirely on **GitHub Actions** — no server, no machine left on. Sanitized: contains the architecture and code, **no private data, no league IDs, no credentials**.

---

## The problem

Salary-cap dynasty leagues need every player's **contract length** (guaranteed years + option years) and **salary** to mirror the real NBA — across a whole league, every week, for many leagues at once. Doing it by hand is hours of copy-paste and it drifts constantly (trades, extensions, free agency, two-way/10-day deals).

## What it does

- **Scrapes** the source of truth (public contract site) once per run — full rosters + free-agent "previous AAV".
- **Normalizes** contracts into a compact format: `2+1 P` (2 guaranteed + 1 **player** option), `1+2 T` (**team** option), plus special tags `2-way` / `10 D`.
- **Pushes** Year + Salary to every team of every configured league via Fantrax's JSON API (no brittle DOM clicking).
- **Diffs** week-over-week and posts a **human-readable commentary** ("biggest signings, option changes, salary swings, trades") to Slack + Discord.
- **Triage loop**: league members report an error in a dedicated Discord channel → an **LLM classifies & verifies** it (real issue / user mistake / joke) and either **auto-fixes and re-pushes**, **explains why nothing changed**, or **escalates to the admin on Slack**.

## Architecture

```
GitHub Actions (cron) ───────────────────────────────────────────────
  maj-fantrax.yml (daily)                 triage.yml (3×/day)
     │                                        │
     ▼                                        ▼
  src/run_fantrax.mjs                     src/triage.mjs
   ├─ Playwright (headless Chromium)       ├─ read Discord channel (bot)
   ├─ scrape source 1× (shared)            ├─ Anthropic API → classify + verify
   ├─ build contract_map + diff            ├─ apply (override + targeted re-push)
   ├─ per league: own cookie → push        │   / explain / escalate (Slack)
   │   roster + free-agent pool            └─ reply in Discord
   └─ notify per league (Slack/Discord)
  commit snapshot back  ──►  baseline for next diff
```

- **Business logic** lives in a single browser-injectable module (`lib/run_weekly_api.js`), reused as-is by both the headless runner and (historically) an interactive mode — injected with Playwright's `addInitScript`.
- **Multi-tenant by config**: `leagues.config.json` lists the leagues; onboarding a new one = **one object + its secrets** (passed to the job in bulk via `toJSON(secrets)`, so the workflow never changes).
- **No credentials stored**: auth is a **session cookie** (`storageState`), refreshed ~monthly via a one-off headed login (`src/export_session.mjs`). Never a password.

## Highlights (engineering)

- **Zero-server, zero-PC**: GitHub Actions runs it on schedule; results are committed back so the weekly diff has a baseline.
- **Robust scraping**: merges the site's split roster tables (catches extension-eligible players), excludes dead-cap/retained sections, handles empty-pill end-of-contract, tolerates the site renaming its column headers.
- **LLM as a careful triager**, not a rubber stamp: it verifies against fresh data before acting, never guesses on homonyms, and escalates judgment calls to a human.
- **Cost-aware**: at a few reports/week, the whole thing runs within GitHub's free tier + a few cents/month of LLM tokens.

## Tech

Node 20 (ESM) · Playwright (headless Chromium) · Anthropic API (Claude) · Python (diff) · Discord & Slack webhooks + Discord bot · GitHub Actions.

## Run it (with your own data)

1. `npm install && npx playwright install chromium`
2. `npm run export-session` → produces a Fantrax session cookie → store as a GitHub secret.
3. Fill `leagues.config.json` (your league IDs) and add the referenced secrets.
4. Enable the workflows (Actions tab). Trigger manually to test.

## Disclaimer

Personal / educational project. It automates a fantasy-sports account the operator controls, using public contract data. It ships **no data, no league IDs and no credentials**. Respect the terms of service of any site you point it at.

## License

MIT — see [LICENSE](LICENSE).

// ============================================================================
// MAJ_year_Fantrax — Weekly run orchestrator (API-direct, no DOM scripting)
//
// Inject this file into a tab (Fantrax or Spotrac) and call the relevant
// methods. All functions live under window.__MAJ_RUN.* and are idempotent.
//
// Dependencies: NONE. Self-contained.
// Auth: relies on browser session cookies (no credentials stored).
// ============================================================================

window.__MAJ_RUN = window.__MAJ_RUN || {};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

window.__MAJ_RUN.normalize = function (name) {
  if (!name) return '';
  let s = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase();
  s = s.replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, ' ');
  s = s.replace(/[^a-z ]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
};

window.__MAJ_RUN.parseMoney = function (s) {
  if (!s) return null;
  const trimmed = String(s).replace(/[$,\s]/g, '').trim();
  if (!trimmed || trimmed === '-') return null;
  const mMatch = trimmed.match(/^(\d+(?:\.\d+)?)M$/i);
  if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1_000_000);
  const kMatch = trimmed.match(/^(\d+(?:\.\d+)?)K$/i);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1_000);
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
};

// Pill class → status code: G/C/N/P/T/U/R
window.__MAJ_RUN.__pillClassToCode = function (cls) {
  if (!cls) return 'G';
  if (/pill-ufa/.test(cls)) return 'U';
  if (/pill-rfa/.test(cls)) return 'R';
  if (/pill-player/.test(cls)) return 'P';
  if (/pill-club|pill-team/.test(cls)) return 'T';
  if (/pill-non-guaranteed/.test(cls)) return 'C';
  return 'G';
};

// Contract = "<G_count>+<PTO_count><TYPE>" across the future seasons (skip current).
// TYPE (2026-06 evolution) is the option-year type, appended ONLY when options > 0:
//   P = player option  (pill-player)
//   T = team option     (pill-club / pill-team)  -- INCLUT les options rookie
//       (Spotrac rend les options rookie a l'identique des options d'equipe :
//        meme pill-club, aucun signal distinctif -> pas de lettre R dediee, on met T.)
// Type pris sur la 1re annee d'option rencontree (cas mixte P+T tres rare -> 1re gagne).
// Exemples: "2+1 P", "2+1 T", "1+2 T", "0+0", "2+0" (espace avant la lettre;
// pas de suffixe si 0 option).
window.__MAJ_RUN.inferContract = function (seasons) {
  let guaranteed = 0;
  let options = 0;
  let optType = null;
  for (const [code] of seasons) {
    if (!code) break;
    if (code === 'G' || code === 'C' || code === 'N') guaranteed++;
    else if (code === 'P' || code === 'T' || code === 'O') {
      options++;
      if (!optType) optType = (code === 'P') ? 'P' : 'T';
    } else break;
  }
  const suffix = options > 0 ? (' ' + (optType || 'T')) : '';
  return `${guaranteed}+${options}${suffix}`;
};

// Special contract types written VERBATIM into the Year column, overriding the
// normal G+PO inference (owner, 2026-07-18):
//   - Two-way contract  -> "2-way"   (label changed from "2 WAY" on 2026-08-02)
//   - 10-day contract    -> "10 D"
// Detection is best-effort on Spotrac's target-season cell: we look at BOTH the
// salary-pill className AND the cell's raw text (Spotrac may render these as a
// distinct pill class, e.g. pill-two-way, OR as plain text "Two-Way" / "10-Day"
// with no standard salary pill). Text-based match makes us robust to class
// renames. Returns "2-way" | "10 D" | null.
// ⚠️ First run after a DOM change: verify against a KNOWN two-way / 10-day player
// (grep the fetched HTML for "two-way" / "10-day") — adjust the regexes if Spotrac
// uses a different label. Two-way FA (status TWO-WAY in scrapeSpotracFA -> "0+0")
// is a different case; the ACTIVE-table override here wins (actifs prioritaires).
window.__MAJ_RUN.__contractStatusOverride = function (cell) {
  if (!cell) return null;
  const pill = cell.querySelector('.pill');
  const cls = pill ? pill.className : '';
  const txt = (cell.textContent || '').toLowerCase();
  if (/pill-two-?way/i.test(cls) || /two[\s-]?way/.test(txt)) return '2-way';
  if (/pill-(?:ten|10)-?day/i.test(cls) || /(?:10|ten)[\s-]?day/.test(txt)) return '10 D';
  return null;
};

// ----------------------------------------------------------------------------
// Spotrac /yearly scraper — call while a Spotrac multi-year page is open.
// Returns { teamSlug, targetSeason, players: [{name, contract, salary}] }
// `salary` = next-season ($) integer dollars from the target season column.
//
// Season targeting: by default we compute `targetSeason` from the current
// date as ${YYYY}-${(YYYY+1)%100} (e.g. June 2026 → "2026-27") and search
// the header row for that exact label. This is robust to Spotrac rolling
// the table forward at the end of the previous season (which used to drop
// the +1 offset assumption — see history in README).
// You can override by passing `opts.targetSeason` explicitly (e.g. "2027-28").
// ----------------------------------------------------------------------------

window.__MAJ_RUN.computeTargetSeason = function (now) {
  const d = now || new Date();
  const y = d.getUTCFullYear();
  // NBA season X-Y means starts Oct X. Our Fantrax target = the season that
  // is current or about to start. From Jan-June: target = this year (Y-Y+1).
  // From Jul-Dec: target = this year (Y-Y+1). Same in both halves because
  // the league re-targets immediately after the previous season ends.
  // (If we ever need to lag/lead this rule, override via opts.targetSeason.)
  const yy = String((y + 1) % 100).padStart(2, '0');
  return `${y}-${yy}`;
};

window.__MAJ_RUN.scrapeSpotracYearly = function (opts) {
  const M = window.__MAJ_RUN;
  const options = opts || {};
  const targetSeason = options.targetSeason || M.computeTargetSeason();
  const root = options.root || document; // 2.6.0: allow scraping a DOMParser doc from fetch()
  // MERGE all "Player (N)" tables that have a target-season column. Spotrac's
  // /yearly page splits a team's contracts across several tables (main roster, an
  // "Extension-Eligible" sub-block — e.g. Kawhi Leonard on LAC — DOM mobile/desktop
  // duplicates, and occasional league-wide widgets). Picking a single table missed
  // players who only appear in a sub-block (they were pushed as defaulted 0+0).
  // Instead: scan EVERY Player table, keep each row whose TARGET-season cell has a
  // salary pill that is NOT a free-agent tag (pill-ufa/pill-rfa). Dedup by
  // normalized name (first occurrence wins). FA rows (no pill / ufa pill) are
  // skipped here and handled via scrapeFreeAgents (Prev AAV). Cross-team widget
  // rows are harmless: their contract is correct and gets overwritten by the
  // player's own team scrape in the final contract_map. (2026-07 fix.)
  // 2.7.3 (2026-08-02): EXCLUDE non-roster sections. Spotrac groups each team's /yearly rows under
  // <header><h2> section titles: "Active Roster", "Pending Transactions", "Dead Money", "Cap Hold"…
  // (each duplicated for responsive). "Dead Money" = waived/stretched/retained salary owed to players
  // who have NO playing NBA team for the target season (e.g. Jonas Valanciunas DEN $2M) — owner's rule:
  // dead cap = free agent = "0+0" (excluded here → the player defaults to 0+0 at push, or is picked up
  // as a FA with Prev AAV). "Cap Hold" = the team's own free agents (already handled by scrapeFreeAgents).
  // We skip a table when its nearest preceding <h2> matches SKIP_SECTION. Fail-safe: if no title is found
  // the table is KEPT (never silently drop the active roster). "Active Roster" / "Pending Transactions" /
  // extension-eligible sub-blocks (Kawhi) are kept.
  const H2 = Array.from(root.querySelectorAll('h2'));
  const SKIP_SECTION = /dead money|dead cap|waiv|retain|cap hold|free agent/i;
  const sectionTitle = (t) => {
    let best = null;
    for (const h of H2) { if (h.compareDocumentPosition(t) & 4 /* DOCUMENT_POSITION_FOLLOWING */) best = h.textContent.replace(/\s+/g, ' ').trim(); else break; }
    return best;
  };
  const byName = {};
  let headersOut = null;
  for (const t of root.querySelectorAll('table')) {
    const headers = Array.from(t.querySelectorAll('thead th, thead td')).map((h) => h.textContent.trim());
    if (!headers.length || !/^Player/i.test(headers[0])) continue;
    let ui = headers.findIndex((h) => h === targetSeason);
    if (ui < 0) ui = headers.findIndex((h) => /^\d{4}-\d{2}$/.test(h));
    if (ui < 0) continue;
    const sect = sectionTitle(t);
    if (sect && SKIP_SECTION.test(sect)) continue; // skip Dead Money / Cap Hold / Waived / Retained
    if (!headersOut) headersOut = headers;
    t.querySelectorAll('tbody tr').forEach((row) => {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length <= ui) return;
      const targetCell = cells[ui];
      const override = M.__contractStatusOverride(targetCell); // "2-way" | "10 D" | null
      const tp = targetCell.querySelector('.pill');
      if (!override) {
        if (!tp) return;                                     // no salary pill (FA plain text / empty) -> skip
        if (/pill-ufa|pill-rfa/.test(tp.className)) return;  // free-agent row -> handled by scrapeFreeAgents
      }
      const nameLink = cells[0].querySelector('a');
      const name = nameLink ? nameLink.textContent.trim() : cells[0].textContent.trim().split('\n').pop().trim();
      const key = M.normalize(name);
      if (!key || byName[key]) return;                     // dedup across tables (first wins)
      if (override) {
        // Two-way / 10-day: Year is the verbatim override; salary from the pill if
        // present, else parsed from the cell's raw text ($ amount).
        const amt = tp ? (tp.querySelector('.pill-start')?.textContent || tp.textContent).trim() : '';
        const salary = M.parseMoney(amt) ?? M.parseFAMoney(targetCell.textContent);
        byName[key] = { name, contract: override, salary };
        return;
      }
      const seasons = [];
      for (let k = 0; k < 4; k += 1) {
        const idx = ui + k;
        if (idx >= cells.length) { seasons.push(['', '']); continue; }
        const pill = cells[idx].querySelector('.pill');
        if (!pill) { seasons.push(['', '']); continue; }
        const amount = (pill.querySelector('.pill-start')?.textContent || pill.textContent).trim();
        // 2.7.2 (2026-08-02): a pill with NO dollar amount is an empty filler cell. Spotrac renders
        // dead-cap / retained rows (separate one-row "Player (1)" sub-tables — e.g. Jonas Valanciunas
        // on DEN, Ricky Rubio, waived/stretched money) with a pill-nba pill in EVERY future column but a
        // $ value only in the year(s) actually owed. Coding those empty pills as guaranteed 'G' inflated
        // single-year dead money to "4+0" (Jonas $2M dead cap -> "4+0" instead of "1+0"). Treat an
        // amount-less pill as end-of-contract so inferContract stops there. A real 4-year deal keeps 4+0
        // (a $ in every column); option years still count (they carry a $ amount).
        if (!/\$\s*\d/.test(amount)) { seasons.push(['', '']); continue; }
        const code = M.__pillClassToCode(pill.className);
        seasons.push([code, amount]);
      }
      byName[key] = { name, contract: M.inferContract(seasons), salary: M.parseMoney(seasons[0]?.[1]) };
    });
  }
  const players = Object.values(byName);
  return { error: players.length ? null : 'active_roster_table_not_found', targetSeason, headers: headersOut || [], players };
};

// ----------------------------------------------------------------------------
// Spotrac /yearly — Free-Agents table scraper.
// Spotrac shows a SECOND "Player (N)" table listing players who are FREE AGENTS
// for the target season (their contract expired): cells read "RFA / $X.XM" or
// "UFA / $X.XM" (cap hold), not a guaranteed salary pill. The active-roster
// scraper above only reads the first table, so these players are otherwise
// "not found" → defaulted. This reads the FA table so they can be set to a
// no-contract state (`0+0`) with their cap-hold as salary, plus an RFA/UFA tag.
//
// Returns { error, targetSeason, players: [{name, status, salary}] }
//   status ∈ 'RFA' | 'UFA' | 'TWO-WAY' | null
//   salary = cap hold ($) for the target season (integer dollars), or null.
// ----------------------------------------------------------------------------

window.__MAJ_RUN.parseFAMoney = function (cell) {
  if (!cell) return null;
  const m = cell.match(/\$(\d+(?:\.\d+)?)\s*M/i);
  if (m) return Math.round(parseFloat(m[1]) * 1_000_000);
  const k = cell.match(/\$(\d+(?:\.\d+)?)\s*K/i);
  if (k) return Math.round(parseFloat(k[1]) * 1_000);
  const f = cell.match(/\$([\d,]{4,})/); // full "$1,358,084" form
  if (f) return parseInt(f[1].replace(/,/g, ''), 10);
  return null;
};

window.__MAJ_RUN.scrapeSpotracFA = function (opts) {
  const M = window.__MAJ_RUN;
  const options = opts || {};
  const targetSeason = options.targetSeason || M.computeTargetSeason();
  const root = options.root || document; // 2.6.0: allow scraping a DOMParser doc from fetch()

  // Candidate tables: header starts with "Player" + has a season column + ≥1 row.
  const tables = Array.from(root.querySelectorAll('table')).filter((t) => {
    const h = (t.querySelector('thead th, thead td') || {}).textContent || '';
    if (!/^Player/i.test(h.trim())) return false;
    const hasSeason = Array.from(t.querySelectorAll('thead th')).some((x) => /^\d{4}-\d{2}$/.test(x.textContent.trim()));
    return hasSeason && t.querySelectorAll('tbody tr').length >= 1;
  });
  if (!tables.length) return { error: 'no_player_table', targetSeason, players: [] };

  // The FA table is the one whose TARGET-SEASON column holds the most RFA/UFA
  // tokens (the active table only shows RFA/UFA in *future* columns, not the
  // target one — so scoring on the target column disambiguates reliably).
  const scored = tables.map((t) => {
    const headers = Array.from(t.querySelectorAll('thead th, thead td')).map((h) => h.textContent.trim());
    let idx = headers.findIndex((h) => h === targetSeason);
    if (idx < 0) idx = headers.findIndex((h) => /^\d{4}-\d{2}$/.test(h));
    let faCells = 0;
    t.querySelectorAll('tbody tr').forEach((r) => {
      const tds = Array.from(r.querySelectorAll('td'));
      if (tds.length <= idx) return;
      if (/\b(RFA|UFA)\b/.test(tds[idx].textContent)) faCells += 1;
    });
    return { t, idx, faCells };
  });
  scored.sort((a, b) => b.faCells - a.faCells);
  const best = scored[0];
  if (!best || best.faCells === 0) return { error: null, targetSeason, players: [] };

  const players = [];
  best.t.querySelectorAll('tbody tr').forEach((row) => {
    const cells = Array.from(row.querySelectorAll('td'));
    if (cells.length <= best.idx) return;
    const a = cells[0].querySelector('a');
    const name = a ? a.textContent.trim() : cells[0].textContent.trim();
    if (!name || /roster charge/i.test(name)) return;
    const cell = cells[best.idx].textContent.trim().replace(/\s+/g, ' ');
    const stMatch = cell.match(/\b(RFA|UFA|TWO-?WAY)\b/i);
    const status = stMatch ? stMatch[1].toUpperCase().replace('TWOWAY', 'TWO-WAY') : null;
    players.push({ name, status, salary: M.parseFAMoney(cell) });
  });
  return { error: null, targetSeason, players };
};

// ----------------------------------------------------------------------------
// Spotrac GLOBAL free-agents page (/nba/free-agents/) — last-contract AAV.
//
// IMPORTANT (fix 2026-06): the per-team FA table (scrapeSpotracFA) exposes the
// 2026-27 *cap hold* (e.g. "UFA / $40.0M"), NOT the player's salary. Cap holds
// are inflated (≈120-175% of prior salary) and produced nonsense values in the
// fantasy leagues (Tobias Harris $40M, Mitchell Robinson $24.6M, etc.).
//
// The correct salary for a free agent = their LAST contract value = the
// "Prev AAV" column on the global free-agents page. Use scrapeSpotracFA only to
// detect WHO is a FA (+ RFA/UFA status); take the SALARY from here instead.
//
// Call while https://www.spotrac.com/nba/free-agents/ is open.
// Returns { error, players: { normalizedName: prevAAV_int|null } }.
// ----------------------------------------------------------------------------

window.__MAJ_RUN.scrapeFreeAgents = function (opts) {
  const M = window.__MAJ_RUN;
  const root = (opts && opts.root) || document; // 2.6.0: allow scraping a DOMParser doc from fetch()
  // 2.7.1 (2026-08-02): Spotrac renamed the FA-page column header "Prev AAV" -> "Previous AAV"
  // and the name header "Player" -> "Players". Tolerate both spellings so the scraper keeps matching
  // (the old /Prev AAV/i literally did NOT match "Previous AAV" -> free_agents_table_not_found).
  const AAV = /Prev(?:ious)?\.?\s*AAV/i;
  const tables = Array.from(root.querySelectorAll('table')).filter((t) =>
    Array.from(t.querySelectorAll('thead th, thead td')).some((h) => AAV.test(h.textContent)));
  let best = null, bestN = 0;
  for (const t of tables) { const n = t.querySelectorAll('tbody tr').length; if (n > bestN) { best = t; bestN = n; } }
  if (!best) return { error: 'free_agents_table_not_found', players: {} };
  const heads = Array.from(best.querySelectorAll('thead th, thead td')).map((h) => h.textContent.replace(/\s+/g, ' ').trim());
  const idxName = heads.findIndex((h) => /^Players?/i.test(h));
  const idxAAV = heads.findIndex((h) => AAV.test(h));
  if (idxName < 0 || idxAAV < 0) return { error: 'columns_not_found', heads, players: {} };
  const players = {};
  best.querySelectorAll('tbody tr').forEach((row) => {
    const cells = Array.from(row.querySelectorAll('td'));
    if (cells.length <= idxAAV) return;
    const a = cells[idxName].querySelector('a');
    const name = (a ? a.textContent : cells[idxName].textContent).trim();
    const k = M.normalize(name);
    if (!k) return;
    players[k] = M.parseFAMoney(cells[idxAAV].textContent);
  });
  return { error: null, players };
};

// ----------------------------------------------------------------------------
// Session checks
// ----------------------------------------------------------------------------

// Verify Fantrax session is alive. Returns { ok: bool, status, reason }.
// Strategy: hit /fxpa/req with getFantasyTeams. If session expired, Fantrax
// redirects to /login (302) or returns ERROR_AUTHENTICATION. We deliberately
// do NOT return roles/userInfo — those fields trip the MCP sandbox sensitive
// data filter. Just a clean boolean + reason string for diagnostics.
window.__MAJ_RUN.checkFantraxSession = async function (leagueId) {
  try {
    const r = await fetch('/fxpa/req?leagueId=' + leagueId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      redirect: 'manual',
      body: JSON.stringify({ msgs: [{ method: 'getFantasyTeams', data: { leagueId } }], uiv: 3 }),
    });
    if (r.type === 'opaqueredirect' || r.status === 302 || r.status === 401 || r.status === 403) {
      return { ok: false, status: r.status, reason: 'redirected_or_auth_failed' };
    }
    if (r.status !== 200) return { ok: false, status: r.status, reason: 'non_200' };
    const j = await r.json();
    if (j.pageError && j.pageError.code === 'ERROR_AUTHENTICATION') {
      return { ok: false, status: 200, reason: 'auth_error_in_payload' };
    }
    const teams = j.responses?.[0]?.data?.fantasyTeams;
    if (!Array.isArray(teams) || teams.length === 0) {
      return { ok: false, status: 200, reason: 'no_teams_in_response' };
    }
    return { ok: true, status: 200, teamsCount: teams.length };
  } catch (e) {
    return { ok: false, status: -1, reason: 'fetch_threw: ' + (e.message || e) };
  }
};

// ----------------------------------------------------------------------------
// Fantrax: enumerate all teams in the league (commissioner mode required).
// Returns [{teamId, name}]
// ----------------------------------------------------------------------------

window.__MAJ_RUN.listFantraxTeams = async function (leagueId) {
  const r = await fetch(`/fxpa/req?leagueId=${leagueId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      msgs: [{ method: 'getFantasyTeams', data: { leagueId } }],
      uiv: 3,
    }),
  });
  const j = await r.json();
  const list = j.responses?.[0]?.data?.fantasyTeams
    || j.responses?.[0]?.data?.teams
    || [];
  return list.map((t) => ({ teamId: t.id || t.teamId, name: t.name }));
};

// ----------------------------------------------------------------------------
// Fantrax: update one team via API (confirm + exec).
// contractMap = { normalizedName: {contract: '2+0', salary: 12345678} }
// aliases = { fantraxNormalizedName: spotracNormalizedName }
// Returns { teamId, filled, defaulted: [...], errors: [...] }
// ----------------------------------------------------------------------------

window.__MAJ_RUN.updateFantraxTeam = async function (leagueId, teamId, contractMap, aliases, opts) {
  const M = window.__MAJ_RUN;
  const options = Object.assign({ defaultContract: '0+0', overwriteSalary: true }, opts || {});
  const out = { teamId, filled: 0, defaulted: [], errors: [] };

  // 1) Get current roster
  const r1 = await fetch(`/fxpa/req?leagueId=${leagueId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      msgs: [{ method: 'getTeamRosterInfo', data: { leagueId, adminMode: true, teamId } }],
      uiv: 3,
    }),
  });
  const j1 = await r1.json();
  if (j1.pageError?.code) {
    out.errors.push({ step: 'getTeamRosterInfo', code: j1.pageError.code, text: j1.pageError.text });
    return out;
  }
  const rows = j1.responses?.[0]?.data?.tables?.['0']?.rows || [];
  if (!rows.length) {
    out.errors.push({ step: 'getTeamRosterInfo', code: 'NO_ROWS' });
    return out;
  }

  // 2) Build fieldMap
  const fieldMap = {};
  for (const row of rows) {
    if (!row.scorer) continue;
    const norm = M.normalize(row.scorer.name);
    const resolved = aliases[norm] || norm;
    const entry = contractMap[resolved];
    const currentSal = (row.cells?.[2]?.content || '').replace(/[^\d]/g, '') || '0';

    if (entry && entry.contract != null) {
      fieldMap[row.scorer.scorerId] = {
        posId: row.posId,
        stId: row.statusId,
        sal: options.overwriteSalary && entry.salary != null ? String(entry.salary) : currentSal,
        custCols: [entry.contract],
      };
      out.filled++;
    } else {
      // Default: keep current sal, contract → "0+0"
      fieldMap[row.scorer.scorerId] = {
        posId: row.posId,
        stId: row.statusId,
        sal: currentSal,
        custCols: [options.defaultContract],
      };
      out.defaulted.push({ name: row.scorer.name });
    }
  }

  // 3) Confirm (preview)
  const confirmBody = {
    msgs: [{
      method: 'confirmOrExecuteTeamRosterChanges',
      data: {
        rosterLimitPeriod: 1,
        fantasyTeamId: teamId,
        daily: false,
        adminMode: true,
        confirm: true,
        applyToFuturePeriods: true,
        fieldMap,
      },
    }],
    uiv: 3,
  };
  const r2 = await fetch(`/fxpa/req?leagueId=${leagueId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(confirmBody),
  });
  const j2 = await r2.json();
  if (j2.pageError?.code) {
    out.errors.push({ step: 'confirm', code: j2.pageError.code, text: j2.pageError.text });
    return out;
  }

  // 4) Execute
  const execBody = JSON.parse(JSON.stringify(confirmBody));
  delete execBody.msgs[0].data.confirm;
  const r3 = await fetch(`/fxpa/req?leagueId=${leagueId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(execBody),
  });
  const j3 = await r3.json();
  if (j3.pageError?.code) {
    out.errors.push({ step: 'exec', code: j3.pageError.code, text: j3.pageError.text });
    return out;
  }

  return out;
};

// ----------------------------------------------------------------------------
// Free-agent (player pool) salary update.
//
// The weekly roster push (updateFantraxTeam via /fxpa/req) only touches players
// who are ON A ROSTER. Free agents in the player pool keep Fantrax's native
// salary, which is usually stale (previous season) or a cap hold — e.g. a FA
// showed 4.4M in one league and 16.2M in another for the same player (fix 2026-07-09).
//
// The pool is edited from the legacy Salary/Contract Admin page and saved via
//   POST /fxa/saveSalariesAndContracts?leagueId=<LID>
//   body {salaryMap:{scorerId:sal}, contractMap:{}, teamIdOrPool:"~POOL_",
//         rosterLimitPeriod:1, applyToFuturePeriods:true}  -> "OK"
// The pool stores ONLY salary (no Year column — the contract/Year is a roster-slot
// attribute, meaningless for an unrostered FA), so contractMap stays empty.
// scorerIds are GLOBAL (same as the roster API); on the admin page each salary
// input is id="sal_<scorerId>". We fetch that page's HTML (paginated, 1000/page,
// same-origin with session cookies), parse name<->scorerId, match against the
// contract_map (+ aliases), and POST. Players whose map salary is null
// (rookies/two-way without a Prev AAV) are SKIPPED -> current Fantrax value kept.
//
// contractMap = { normalizedName: {contract, salary} }  (same shape as updateFantraxTeam)
// aliases     = { fantraxNormalizedName: spotracNormalizedName }
// Returns { leagueId, pages, poolPlayers, matched, salariesSent, skippedNullSal, status, resp, errors }
// ----------------------------------------------------------------------------
window.__MAJ_RUN.updatePoolSalaries = async function (leagueId, contractMap, aliases, opts) {
  const M = window.__MAJ_RUN;
  const options = Object.assign({ pageSize: 1000, maxPages: 10 }, opts || {});
  const al = aliases || {};
  const out = { leagueId, pages: 0, poolPlayers: 0, matched: 0, salariesSent: 0, skippedNullSal: 0, errors: [] };
  const parser = new DOMParser();
  const salaryMap = {};
  for (let p = 0; p < options.maxPages; p += 1) {
    const startIndex = p * options.pageSize;
    const url = `/newui/fantasy/salaryContractAdmin.go?leagueId=${leagueId}&sortOrder=NAME&startIndex=${startIndex}&teamIdOrPool=~POOL_&period=1&position=ALL&applyToFuturePeriods=true&_applyToFuturePeriods=false`;
    let html;
    try {
      const r = await fetch(url, { credentials: 'include' });
      html = await r.text();
    } catch (e) { out.errors.push({ step: 'fetch_page', startIndex, err: String(e.message || e) }); break; }
    const doc = parser.parseFromString(html, 'text/html');
    const inputs = doc.querySelectorAll('input[id^="sal_"]');
    if (!inputs.length) break;
    out.pages += 1;
    inputs.forEach((inp) => {
      out.poolPlayers += 1;
      const id = inp.id.replace(/^sal_/, '');
      const tr = inp.closest('tr');
      const a = tr ? tr.querySelector('a') : null;
      const name = a ? a.textContent.trim() : '';
      const key = al[M.normalize(name)] || M.normalize(name);
      const e = contractMap[key];
      if (!e) return;
      out.matched += 1;
      if (e.salary == null) { out.skippedNullSal += 1; return; } // rookie/two-way -> keep current
      salaryMap[id] = String(e.salary);
    });
    if (inputs.length < options.pageSize) break; // reached the last page
  }
  out.salariesSent = Object.keys(salaryMap).length;
  if (!out.salariesSent) return out;
  try {
    const body = JSON.stringify({ salaryMap, contractMap: {}, teamIdOrPool: '~POOL_', rosterLimitPeriod: 1, applyToFuturePeriods: true });
    const r = await fetch(`/fxa/saveSalariesAndContracts?leagueId=${leagueId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body,
    });
    out.status = r.status;
    out.resp = (await r.text()).slice(0, 60);
    if (r.status !== 200) out.errors.push({ step: 'save', status: r.status });
  } catch (e) { out.errors.push({ step: 'save', err: String(e.message || e) }); }
  return out;
};

// ----------------------------------------------------------------------------
// Sentinel
// ----------------------------------------------------------------------------
window.__MAJ_RUN.version = '2.7.4-twoway-label';
window.__MAJ_RUN.ready = true;

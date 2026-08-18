// ============================================================================
// fantrax_agent — Runner headless multi-ligue (GitHub Actions / VPS / Pi).
//
// Scrape Spotrac UNE fois (données NBA communes) → build contract_map →
// pour CHAQUE ligue de leagues.config.json : auth propre (cookie), push roster
// + pool, notif propre (Slack/Discord). Réutilise lib/run_weekly_api.js (module
// métier v2.7.x) injecté via addInitScript. page.evaluate() renvoie direct.
//
// Secrets : passés par GitHub Actions en un bloc JSON (env SECRETS_JSON =
// toJSON(secrets)) ; fallback sur process.env pour un test local (.env).
// Onboarder une ligue = 1 objet dans leagues.config.json + les secrets référencés.
// Aucun mot de passe stocké : seulement des cookies de session (storageState).
// ============================================================================
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'lib', 'run_weekly_api.js');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'leagues.config.json'), 'utf8'));
const TEAMS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'spotrac_teams.json'), 'utf8'));
const TODAY = new Date().toISOString().slice(0, 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// --- secrets : SECRETS_JSON (bloc GitHub) fusionné avec process.env (local) ---
let SECRETS = { ...process.env };
try { if (process.env.SECRETS_JSON) SECRETS = { ...SECRETS, ...JSON.parse(process.env.SECRETS_JSON) }; } catch (e) { console.error('SECRETS_JSON invalide', e.message); }
const secret = (name) => (name && SECRETS[name]) ? SECRETS[name] : '';
const PROXY = secret('PROXY_SERVER') ? { server: secret('PROXY_SERVER'), username: secret('PROXY_USERNAME'), password: secret('PROXY_PASSWORD') } : undefined;

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
function normalize(name){ if (!name) return ''; let s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase(); return s.replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, ' ').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); }

function loadAliases(){
  const aliases = {};
  try {
    fs.readFileSync(path.join(ROOT, 'data', 'match_players_names.csv'), 'utf8').split(/\r?\n/).slice(1).forEach((l) => {
      const [fx, sp] = l.split(','); if (fx && sp) aliases[normalize(fx)] = normalize(sp);
    });
  } catch {}
  return aliases;
}

async function postWebhook(url, payload, discord){
  if (!url) return 'skip';
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(discord ? { 'User-Agent': UA } : {}) }, body: JSON.stringify(payload) });
    return r.status;
  } catch (e) { return 'ERR ' + e.message; }
}
function chunks(s, max){ const o = []; for (const p of s.split('\n')) { if (!o.length || (o[o.length-1] + '\n' + p).length > max) o.push(p); else o[o.length-1] += '\n' + p; } return o; }

async function main(){
  log('=== fantrax_agent run', TODAY, '| ligues:', CFG.leagues.length, '===');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  // ---- A) Scrape Spotrac (UNE fois, données NBA communes) ----
  const ctxSpot = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 }, ...(PROXY ? { proxy: PROXY } : {}) });
  await ctxSpot.addInitScript({ path: MODULE });
  const pSpot = await ctxSpot.newPage();
  await pSpot.goto('https://www.spotrac.com/nba/atlanta-hawks/yearly', { waitUntil: 'domcontentloaded', timeout: 45000 });
  const ts = await pSpot.evaluate(() => window.__MAJ_RUN.computeTargetSeason());
  log('targetSeason =', ts);

  const active = {}; let scrapeErrors = 0;
  for (const { abbr, slug } of TEAMS) {
    try {
      await pSpot.goto(`https://www.spotrac.com/nba/${slug}/yearly`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await pSpot.waitForFunction(() => document.querySelectorAll('table tbody tr td .pill').length > 0, { timeout: 15000 }).catch(() => {});
      await pSpot.waitForTimeout(600);
      const res = await pSpot.evaluate((s) => window.__MAJ_RUN.scrapeSpotracYearly({ targetSeason: s }), ts);
      (res.players || []).forEach((pl) => { const k = normalize(pl.name); if (k) active[k] = { team: abbr, contract: pl.contract, salary: pl.salary }; });
      log(`  ${abbr}: ${(res.players || []).length} actifs${res.error ? ' ERR ' + res.error : ''}`);
    } catch (e) { scrapeErrors++; log(`  ${abbr}: ECHEC ${e.message}`); }
  }
  await pSpot.goto('https://www.spotrac.com/nba/free-agents/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pSpot.waitForFunction(() => document.querySelectorAll('table tbody tr td').length > 0, { timeout: 15000 }).catch(() => {});
  await pSpot.waitForTimeout(600);
  const fa = await pSpot.evaluate(() => window.__MAJ_RUN.scrapeFreeAgents());
  const faMap = fa.players || {};
  log(`Actifs: ${Object.keys(active).length} · Free agents (Previous AAV): ${Object.keys(faMap).length}${fa.error ? ' ERR ' + fa.error : ''}`);
  await ctxSpot.close();

  // ---- B) Build contract_map de base (FA d'abord, actifs par-dessus) ----
  const base = {};
  for (const [k, aav] of Object.entries(faMap)) base[k] = { team: 'FA', contract: '0+0', salary: aav ?? null };
  for (const [k, v] of Object.entries(active)) base[k] = { team: v.team, contract: v.contract, salary: v.salary };

  // écriture + snapshot (pour le diff hebdo — committé par le workflow)
  const mapPath = path.join(ROOT, 'data', 'contract_map.json');
  fs.writeFileSync(mapPath, JSON.stringify(base, null, 2), 'utf8');
  const snapDir = path.join(ROOT, 'data', 'snapshots'); fs.mkdirSync(snapDir, { recursive: true });
  let snap = path.join(snapDir, `contract_map_${TODAY}.json`), i = 2;
  while (fs.existsSync(snap)) { snap = path.join(snapDir, `contract_map_${TODAY}_${i}.json`); i++; }
  fs.copyFileSync(mapPath, snap);

  // diff + commentaire (partagés — mouvements NBA communs)
  let slackDiff = '', comment = '';
  try {
    const snaps = fs.readdirSync(snapDir).filter((f) => /^contract_map_\d{4}-\d{2}-\d{2}.*\.json$/.test(f)).sort();
    const prev = snaps.filter((f) => !f.includes(TODAY)).pop();
    if (prev) {
      fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
      const r = spawnSync('python3', [path.join(ROOT, 'lib', 'diff_contracts.py'), path.join(snapDir, prev), mapPath, '--out', path.join(ROOT, 'logs', `diff_${TODAY}.json`), '--slack', '--comment'], { encoding: 'utf8' });
      const err = (r.stderr || '').replace(/^Diff écrit dans .*\n?/m, '');
      const parts = err.split('---COMMENT---'); slackDiff = (parts[0] || '').trim(); comment = (parts[1] || '').trim();
    } else comment = '📝 Premier snapshot — pas de diff.';
  } catch (e) { log('diff ERR', e.message); }

  // ---- C) Par ligue : auth propre, push roster + pool, notif propre ----
  const aliases = loadAliases();
  const results = [];
  for (const lg of CFG.leagues) {
    let raw = secret(lg.authSecret);
    // Local : la valeur peut être un CHEMIN vers le fichier storageState (au lieu du JSON inline).
    if (raw && !raw.trim().startsWith('{') && fs.existsSync(raw.trim())) { try { raw = fs.readFileSync(raw.trim(), 'utf8'); } catch {} }
    if (!raw) { log(`⚠️ ${lg.name}: secret ${lg.authSecret} absent → ligue SKIPPÉE`); results.push({ lg, skipped: 'no_auth' }); continue; }
    let storageState; try { storageState = JSON.parse(raw); } catch { log(`⚠️ ${lg.name}: ${lg.authSecret} n'est pas un storageState JSON valide → SKIP`); results.push({ lg, skipped: 'bad_state' }); continue; }
    const ctx = await browser.newContext({ userAgent: UA, storageState });
    await ctx.addInitScript({ path: MODULE });
    const page = await ctx.newPage();
    try {
      await page.goto(`https://www.fantrax.com/fantasy/league/${lg.id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const sess = await page.evaluate((lid) => window.__MAJ_RUN.checkFantraxSession(lid), lg.id);
      if (!sess.ok) {
        log(`⚠️ ${lg.name}: session KO (${sess.reason})`);
        await postWebhook(secret(lg.slackWebhookSecret), { text: `⚠️ fantrax_agent — ${lg.name} : session Fantrax expirée (${sess.reason}). Rafraîchir le secret ${lg.authSecret}. Aucune écriture.` });
        results.push({ lg, skipped: 'session_ko' }); await ctx.close(); continue;
      }
      // contract_map spécifique ligue = base + overrides
      const cm = { ...base };
      for (const [k, o] of Object.entries(lg.overrides || {})) if (o && o.year) cm[k] = { contract: o.year, salary: null };

      const teams = await page.evaluate((lid) => window.__MAJ_RUN.listFantraxTeams(lid), lg.id);
      let filled = 0, defaulted = 0, errors = 0;
      for (const t of teams) {
        const o = await page.evaluate(([lid, tid, m, al]) => window.__MAJ_RUN.updateFantraxTeam(lid, tid, m, al, { defaultContract: '0+0', overwriteSalary: true }), [lg.id, t.teamId, cm, aliases]);
        filled += o.filled || 0; defaulted += (o.defaulted || []).length; errors += (o.errors || []).length;
      }
      let pool = {};
      try { pool = await page.evaluate(([lid, m, al]) => window.__MAJ_RUN.updatePoolSalaries(lid, m, al), [lg.id, cm, aliases]); } catch (e) { log(`${lg.name} pool ERR`, e.message); }
      log(`${lg.name}: ${teams.length} éq · ${filled} remplis · ${defaulted} default · ${errors} err · pool ${pool.salariesSent ?? '?'}`);

      const head = `✅ fantrax_agent — ${lg.name} — run OK (${TODAY})\n• Saison cible : ${ts}\n• ${teams.length}/${teams.length} équipes · ${filled} remplis · ${defaulted} default · ${errors} err · ${pool.salariesSent ?? 0} salaires pool`;
      const body = [head, lg.comment ? comment : '', slackDiff].filter(Boolean).join('\n\n');
      const sc = await postWebhook(secret(lg.slackWebhookSecret), { text: body });
      let dc = 'skip';
      if (lg.discordWebhookSecret) { const dbody = body.replace(/\*([^*]+)\*/g, '**$1**'); for (const c of chunks(dbody, 1900)) { dc = await postWebhook(secret(lg.discordWebhookSecret), { content: c }, true); await new Promise((r) => setTimeout(r, 1100)); } }
      results.push({ lg, teams: teams.length, filled, defaulted, errors, pool: pool.salariesSent ?? 0, slack: sc, discord: dc });
    } catch (e) { log(`${lg.name} FATAL`, e.message); results.push({ lg, error: e.message }); }
    await ctx.close();
  }

  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'logs', `run_${TODAY}.json`), JSON.stringify({ run_id: TODAY, target_season: ts, contract_map_keys: Object.keys(base).length, scrape_errors: scrapeErrors, leagues: results.map((r) => ({ name: r.lg.name, ...r, lg: undefined })) }, null, 2), 'utf8');
  await browser.close();
  log('=== DONE ===');
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1); });

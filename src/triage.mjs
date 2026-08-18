// ============================================================================
// triage.mjs — boucle de remontée des écarts (1 channel Discord par ligue).
//
// Pour chaque ligue avec correctionsChannelId : lit les nouveaux messages,
// demande à Claude (API Anthropic) de CLASSER + JUGER (écart réel / erreur user /
// blague) et de décider l'action :
//   apply    → override + push CIBLÉ de la ligue (run aussitôt) + accusé Discord
//   explain  → pas de changement, explication de l'écart en Discord
//   escalate → message à l'admin sur Slack + accusé Discord "remonté à l'admin"
//
// Vérité de référence = data/contract_map.json (rafraîchi quotidiennement, <24h)
// + connaissances NBA de Claude. Ne devine jamais sur une homonymie → escalade.
// Secrets : DISCORD_BOT_TOKEN, ANTHROPIC_API_KEY, + les authSecret/webhooks des ligues.
// ============================================================================
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'lib', 'run_weekly_api.js');
const CFG_PATH = path.join(ROOT, 'leagues.config.json');
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const STATE_PATH = path.join(ROOT, 'data', 'discord_state.json');
const MAP_PATH = path.join(ROOT, 'data', 'contract_map.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let SECRETS = { ...process.env };
try { if (process.env.SECRETS_JSON) SECRETS = { ...SECRETS, ...JSON.parse(process.env.SECRETS_JSON) }; } catch {}
const secret = (n) => (n && SECRETS[n]) ? SECRETS[n] : '';
const T = CFG.triage || {};
const BOT = secret(T.botTokenSecret), AKEY = secret(T.anthropicKeySecret), MODEL = T.model || 'claude-sonnet-5';
const ADMIN_SLACK = secret(T.adminSlackWebhookSecret);
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
function normalize(name){ if (!name) return ''; let s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase(); return s.replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, ' ').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); }

function loadAliases(){ const a = {}; try { fs.readFileSync(path.join(ROOT, 'data', 'match_players_names.csv'), 'utf8').split(/\r?\n/).slice(1).forEach((l) => { const [fx, sp] = l.split(','); if (fx && sp) a[normalize(fx)] = normalize(sp); }); } catch {} return a; }
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; } };
const writeState = (s) => fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), 'utf8');

// --- Discord REST (bot) ---
async function dGet(channelId, afterId){
  const u = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
  u.searchParams.set('limit', '50'); if (afterId) u.searchParams.set('after', afterId);
  const r = await fetch(u, { headers: { Authorization: `Bot ${BOT}` } });
  if (!r.ok) { log('Discord GET', r.status, await r.text().catch(() => '')); return []; }
  return r.json();  // ordre : plus récent -> plus ancien
}
async function dPost(channelId, content){
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, { method: 'POST', headers: { Authorization: `Bot ${BOT}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
  if (!r.ok) log('Discord POST', r.status);
}
async function slackAdmin(text){ if (!ADMIN_SLACK) { log('admin Slack absent'); return; } try { await fetch(ADMIN_SLACK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); } catch (e) { log('slack ERR', e.message); } }

// --- Claude (triage) ---
const SYSTEM = `Tu es l'agent de triage des remontées d'écarts d'une ligue fantasy NBA gérée sur Fantrax. Un utilisateur signale un problème sur la valeur "Year" (contrat : format G+PO avec suffixe P=player option / T=team option, ou "2-way", ou "10 D") ou "Salary" ($) d'un joueur.
La VÉRITÉ de référence est la valeur actuellement stockée (rafraîchie quotidiennement, <24h) que je te fournis, complétée par tes connaissances NBA.
Décide avec prudence :
- action "apply" UNIQUEMENT si l'écart est RÉEL et la correction CLAIRE et NON AMBIGÜE (ex. salaire manifestement périmé avec valeur sûre, erreur d'agent évidente). Fournis fix.field ("year" ex "1+0"/"2-way"/"10 D", ou "sal" entier en dollars) et fix.value.
- action "explain" si l'utilisateur se trompe, plaisante, ou si la valeur stockée est déjà correcte. Pas de changement.
- action "escalate" (vers l'admin humain) si : homonymie (NE JAMAIS deviner quel joueur), convention de ligue ou joueur non-NBA (valeur conventionnelle hors barème standard), bug d'agent reproductible, ou confiance faible.
Réponds STRICTEMENT en JSON, une seule ligne, sans texte autour :
{"type":"salaire|equipe|homonymie|erreur_agent|autre","player":"nom","assessment":"reel|erreur_user|blague|incertain","action":"apply|explain|escalate","fix":{"field":"year|sal","value":"..."}|null,"reply":"message court en français pour l'utilisateur, poli, factuel, expliquant l'écart","escalation_note":"contexte pour l'admin"|null,"confidence":0.0}`;

async function classify(report, ctx){
  const user = `Ligue : ${ctx.league}\nRemontée utilisateur : """${report}"""\nJoueur détecté (clé normalisée) : ${ctx.key || '(non identifié)'}\nValeur actuellement stockée : ${ctx.entry ? JSON.stringify(ctx.entry) : 'INTROUVABLE dans le contract_map'}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM, messages: [{ role: 'user', content: user }] }) });
    const j = await r.json();
    const txt = (j.content && j.content[0] && j.content[0].text) || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('pas de JSON dans la réponse');
  } catch (e) {
    log('classify ERR', e.message);
    return { type: 'autre', player: '', assessment: 'incertain', action: 'escalate', fix: null, reply: "Je n'ai pas pu analyser automatiquement — remonté à l'admin.", escalation_note: 'échec du triage LLM: ' + e.message, confidence: 0 };
  }
}

function matchPlayer(report, cmap, aliases){
  // heuristique : cherche la plus longue clé du cmap dont le nom normalisé apparaît dans le message
  const norm = normalize(report);
  let best = null;
  for (const k of Object.keys(cmap)) { if (k.length >= 6 && norm.includes(k) && (!best || k.length > best.length)) best = k; }
  if (!best) for (const [fx, sp] of Object.entries(aliases)) { if (norm.includes(fx)) { best = sp; break; } }
  return best;
}

// Applique un fix : patch le contract_map + override config + RE-PUSH ciblé de la ligue.
async function applyFix(browser, lg, key, fix, cmap, aliases){
  // 1) patch cmap en mémoire
  const patched = {}; for (const [k, v] of Object.entries(cmap)) patched[k] = { contract: v.contract, salary: v.salary };
  if (fix.field === 'year') patched[key] = { contract: String(fix.value), salary: patched[key] ? patched[key].salary : null };
  else if (fix.field === 'sal') patched[key] = { contract: patched[key] ? patched[key].contract : '0+0', salary: parseInt(String(fix.value).replace(/[^\d]/g, ''), 10) };
  // 2) persister l'override dans la config (permanent, repris aux runs suivants)
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const L = cfg.leagues.find((x) => x.id === lg.id); L.overrides = L.overrides || {};
  L.overrides[key] = fix.field === 'year' ? { year: String(fix.value) } : { sal: patched[key].salary };
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  // 3) push ciblé : re-pousse le roster de CETTE ligue avec le cmap patché (run aussitôt)
  const raw0 = secret(lg.authSecret);
  const raw = (raw0 && !raw0.trim().startsWith('{') && fs.existsSync(raw0.trim())) ? fs.readFileSync(raw0.trim(), 'utf8') : raw0;
  const ctx = await browser.newContext({ userAgent: UA, storageState: JSON.parse(raw) });
  await ctx.addInitScript({ path: MODULE });
  const page = await ctx.newPage();
  await page.goto(`https://www.fantrax.com/fantasy/league/${lg.id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const teams = await page.evaluate((lid) => window.__MAJ_RUN.listFantraxTeams(lid), lg.id);
  for (const t of teams) await page.evaluate(([lid, tid, m, al]) => window.__MAJ_RUN.updateFantraxTeam(lid, tid, m, al, { defaultContract: '0+0', overwriteSalary: true }), [lg.id, t.teamId, patched, aliases]);
  try { await page.evaluate(([lid, m, al]) => window.__MAJ_RUN.updatePoolSalaries(lid, m, al), [lg.id, patched, aliases]); } catch {}
  await ctx.close();
}

async function main(){
  if (!BOT || !AKEY) { log('DISCORD_BOT_TOKEN ou ANTHROPIC_API_KEY absent — abort'); process.exit(1); }
  const cmap = fs.existsSync(MAP_PATH) ? JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')) : {};
  const aliases = loadAliases();
  const state = readState();
  let browser = null;
  for (const lg of CFG.leagues) {
    const ch = lg.correctionsChannelId; if (!ch) continue;
    // 1ère activation : ne PAS retraiter l'historique — poser une baseline sur le dernier message.
    if (state[ch] === undefined) {
      const latest = await dGet(ch);
      state[ch] = latest.length ? latest[0].id : '0';
      writeState(state);
      log(`${lg.name}: 1ère activation du channel ${ch} → baseline posée (backlog ignoré)`);
      continue;
    }
    let msgs = await dGet(ch, state[ch]);
    msgs = msgs.filter((m) => !(m.author && m.author.bot)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, T.maxMessagesPerRun || 20);
    log(`${lg.name}: ${msgs.length} nouveau(x) message(s)`);
    for (const m of msgs) {
      const report = (m.content || '').trim(); if (!report) { state[ch] = m.id; continue; }
      const key = matchPlayer(report, cmap, aliases);
      const v = await classify(report, { league: lg.name, key, entry: key ? cmap[key] : null });
      log(`  «${report.slice(0, 60)}» → ${v.action} (${v.assessment}, conf ${v.confidence})`);
      try {
        if (v.action === 'apply' && v.fix && key) {
          if (!browser) browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
          await applyFix(browser, lg, key, v.fix, cmap, aliases);
          cmap[key] = cmap[key] || {}; if (v.fix.field === 'year') cmap[key].contract = String(v.fix.value); else cmap[key].salary = parseInt(String(v.fix.value).replace(/[^\d]/g, ''), 10);
          await dPost(ch, `✅ ${v.reply}`);
        } else if (v.action === 'escalate') {
          await slackAdmin(`🙋 fantrax_agent — remontée à arbitrer (${lg.name})\n> ${report}\n• Type: ${v.type} · joueur: ${v.player || key || '?'} · éval: ${v.assessment}\n• Note: ${v.escalation_note || '—'}\n• Valeur stockée: ${key ? JSON.stringify(cmap[key]) : 'introuvable'}`);
          await dPost(ch, `🙋 ${v.reply}`);
        } else {
          await dPost(ch, v.reply || 'Rien à corriger : la valeur stockée semble correcte.');
        }
      } catch (e) { log('  action ERR', e.message); await dPost(ch, "⚠️ Erreur en traitant ta remontée — remontée à l'admin."); await slackAdmin(`❌ fantrax_agent triage ERR (${lg.name}) sur «${report}» : ${e.message}`); }
      state[ch] = m.id;
    }
    writeState(state);
  }
  if (browser) await browser.close();
  log('=== triage DONE ===');
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1); });

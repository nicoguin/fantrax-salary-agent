// ============================================================================
// export_session.mjs — génère le storageState Fantrax (cookies) d'UNE ligue/compte.
//
// À lancer sur une machine AVEC écran (ton PC) :   npm run export-session
// → ouvre Chromium, tu te connectes À LA MAIN au compte Fantrax qui possède la
//   (les) ligue(s), puis ENTRÉE. Écrit ./fantrax_state.json.
//
// Ensuite : copier le CONTENU du fichier dans un secret GitHub (Settings →
// Secrets and variables → Actions → New secret) nommé comme l'`authSecret` de
// la ligue dans leagues.config.json (ex. FANTRAX_STATE_MAIN).
//   gh secret set FANTRAX_STATE_MAIN < fantrax_state.json      (via GitHub CLI)
//
// À refaire ~1×/mois (cookie ~30 j) ou quand l'agent poste « session expirée ».
// Aucun mot de passe stocké : uniquement le cookie de session.
// ============================================================================
import { chromium } from 'playwright';
import fs from 'node:fs';
import readline from 'node:readline';

const OUT = process.argv[2] || 'fantrax_state.json';
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto('https://www.fantrax.com/login');
console.log('\n>>> Connecte-toi à Fantrax dans la fenêtre (coche "Stay signed in").');
console.log('>>> Une fois sur ton dashboard, reviens ici et appuie sur ENTRÉE.\n');
await new Promise((res) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question('', () => { rl.close(); res(); }); });
await ctx.storageState({ path: OUT });
console.log(`\n✅ ${OUT} écrit. Colle son CONTENU dans le secret GitHub (authSecret de ta ligue).`);
console.log(`   Ex. : gh secret set FANTRAX_STATE_MAIN < ${OUT}`);
console.log('   ⚠️ NE PAS committer ce fichier.');
await browser.close();
if (fs.existsSync(OUT)) { /* laissé pour copie */ }

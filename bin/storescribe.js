#!/usr/bin/env node
// StoreScribe CLI: run it inside your app's repo. It reads the project, writes the listing, and saves it as fastlane metadata.
//   npx github:sbis04/storescribe         uses the hosted StoreScribe (competitor research included)
//   npx github:sbis04/storescribe --local runs Gemma on your machine through Ollama; nothing leaves your laptop
import { parseArgs } from 'node:util';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { scanRepo, contextText } from '../src/repo.js';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    local: { type: 'boolean' },
    stores: { type: 'string', default: 'ios,android' },
    langs: { type: 'string', default: '' },
    terms: { type: 'string', default: '' },
    pitch: { type: 'string', default: '' },
    name: { type: 'string' },
    out: { type: 'string', default: 'fastlane/metadata' },
    server: { type: 'string', default: process.env.STORESCRIBE_URL ?? 'https://storescribe.souvikbiswas.com' },
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    help: { type: 'boolean', short: 'h' },
  },
});

const c = (n) => (s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const bold = c(1), dim = c(2), green = c(32), yellow = c(33), red = c(31), blue = c(34);

if (opt.help) {
  console.log(`${bold('storescribe')}: App Store and Google Play listings from your app's repo

  ${bold('Usage')}  npx github:sbis04/storescribe [dir] [options]

  --langs ja-JP,de-DE    languages besides English (up to 5)
  --stores ios,android   which stores (default both)
  --terms "a, b"         search terms to target (default: the model picks)
  --pitch "..."          one line about the app, if the repo doesn't say
  --local                run Gemma with Ollama on this machine; nothing is sent anywhere
  --out DIR              where to write (default fastlane/metadata)
  --dry-run              print the listing, write nothing
  -y, --yes              overwrite existing metadata without asking`);
  process.exit(0);
}

const root = path.resolve(positionals[0] ?? '.');
const stores = opt.stores.split(',').map((s) => s.trim()).filter((s) => ['ios', 'android'].includes(s));
const locales = opt.langs.split(',').map((s) => s.trim()).filter(Boolean);

console.log(`\n${bold('StoreScribe')} ${dim(`· ${root}`)}\n`);
const ctx = await scanRepo(root);
const name = (opt.name ?? ctx.name).slice(0, 30);
console.log(`${green('✓')} ${bold(name)} ${dim(`(${ctx.kind.join(', ') || 'unknown project type'})`)}`);
if (ctx.iosId || ctx.androidId) console.log(dim(`  ${[ctx.iosId, ctx.androidId].filter(Boolean).join(' · ')}`));
console.log(dim(`  read ${ctx.sources.length} files${ctx.screens.length ? `, ${ctx.screens.length} screens in the code` : ''}${ctx.readme ? ', the README' : ''}${Object.keys(ctx.current).length ? ', your current listing' : ''}${ctx.screenshots.length ? `, ${ctx.screenshots.length} screenshots` : ''}`));
if (!ctx.readme && !ctx.description && !opt.pitch) {
  console.log(yellow(`\n  The repo doesn't say much about what the app does. Add --pitch "one line about it" for a better listing.`));
}
console.log();

let step = 0;
const emit = (kind, message) => {
  if (['result', 'brief-done'].includes(kind)) console.log(`${green('✓')} ${message}`);
  else if (kind === 'fix') console.log(`${yellow('↺')} ${message}`);
  else if (kind === 'error') console.log(`${red('✗')} ${message}`);
  else console.log(`${blue('•')} ${message}`);
  step++;
};

const app = { name, pitch: opt.pitch, details: '', category: '', audience: '', seed_terms: opt.terms.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 3), context: contextText(ctx) };
const t0 = Date.now();
let out, link;
try {
  out = opt.local ? await runLocal() : await runHosted();
} catch (err) {
  console.error(`\n${red('✗')} ${err.message}`);
  if (!opt.local) console.error(dim('  Try --local to run with Ollama on this machine.'));
  process.exit(1);
}
console.log(`\n${green('✓')} Done in ${Math.round((Date.now() - t0) / 1000)} s${out.cost ? dim(` · model cost $${out.cost.toFixed(4)}`) : opt.local ? dim(' · free, ran on this machine') : ''}\n`);

for (const r of out.results.filter((x) => x.locale === 'en-US')) {
  console.log(bold(r.store === 'ios' ? 'App Store' : 'Google Play'));
  for (const [k, v] of Object.entries(r.fields)) {
    if (k.includes('description') && v.length > 200) console.log(`  ${dim(k.padEnd(18))}${v.slice(0, 140).replace(/\s+/g, ' ')}… ${dim(`(${v.length} chars)`)}`);
    else console.log(`  ${dim(k.padEnd(18))}${v}`);
  }
  for (const i of r.issues) console.log(`  ${i.level === 'error' ? red('✗') : yellow('!')} ${i.text}`);
  console.log();
}

if (opt['dry-run']) process.exit(0);

// fastlane deliver (App Store) and supply (Google Play) read one .txt per field per locale.
const IOS_DIR = { 'en-US': 'en-US', 'es-ES': 'es-ES', 'es-MX': 'es-MX', 'fr-FR': 'fr-FR', 'de-DE': 'de-DE', 'it-IT': 'it', 'pt-BR': 'pt-BR', 'ja-JP': 'ja', 'ko-KR': 'ko', 'zh-Hans': 'zh-Hans', 'hi-IN': 'hi', 'id-ID': 'id', 'tr-TR': 'tr', 'nl-NL': 'nl-NL' };
const PLAY_DIR = { 'en-US': 'en-US', 'es-ES': 'es-ES', 'es-MX': 'es-419', 'fr-FR': 'fr-FR', 'de-DE': 'de-DE', 'it-IT': 'it-IT', 'pt-BR': 'pt-BR', 'ja-JP': 'ja-JP', 'ko-KR': 'ko-KR', 'zh-Hans': 'zh-CN', 'hi-IN': 'hi-IN', 'id-ID': 'id', 'tr-TR': 'tr-TR', 'nl-NL': 'nl-NL' };
const base = path.resolve(root, opt.out);
const files = out.results.flatMap((r) => Object.entries(r.fields).map(([k, v]) => [
  path.join(base, r.store === 'ios' ? IOS_DIR[r.locale] : path.join('android', PLAY_DIR[r.locale]), `${k}.txt`), v]));
const existing = (await Promise.all(files.map(([f]) => access(f).then(() => f, () => null)))).filter(Boolean);
if (existing.length && !opt.yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${yellow('?')} ${existing.length} files in ${path.relative(root, base)} already exist. Overwrite them? ${dim('(y/N)')} `);
  rl.close();
  if (!/^y/i.test(a)) { console.log(dim('Nothing written.')); process.exit(0); }
}
for (const [f, v] of files) { await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, `${v}\n`); }
console.log(`${green('✓')} Wrote ${files.length} files to ${bold(path.relative(root, base) || '.')}`);
console.log(dim(`  Upload with: fastlane deliver --skip_screenshots --skip_binary_upload   /   fastlane supply --skip_upload_apk --skip_upload_aab`));
if (link) console.log(`\n  Edit, compare versions and track rankings: ${blue(link)}\n`);

// ---------- the two ways to run ----------

async function runHosted() {
  // One workspace per machine, so every run lands in the same history on the web.
  const cfgFile = path.join(os.homedir(), '.storescribe.json');
  let cfg = {};
  try { cfg = JSON.parse(await readFile(cfgFile, 'utf8')); } catch { /* first run */ }
  if (!cfg.workspace) { cfg.workspace = randomUUID(); await writeFile(cfgFile, JSON.stringify(cfg, null, 2)); }

  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: app.name, pitch: app.pitch, context: app.context, seed_terms: app.seed_terms.join(',') })) fd.append(k, v);
  for (const s of stores) fd.append('stores', s);
  for (const l of locales) fd.append('locales', l);
  const sharp = (await import('sharp')).default;
  for (const f of ctx.screenshots) {
    const jpg = await sharp(f).resize({ width: 768, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    fd.append('screens', new Blob([jpg], { type: 'image/jpeg' }), path.basename(f));
  }
  const res = await fetch(`${opt.server}/api/generate`, { method: 'POST', body: fd, headers: { 'x-workspace': cfg.workspace } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Server said ${res.status}`);
  let done, appId;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = chunk.match(/^event: (.*)$/m)?.[1];
      const data = JSON.parse(chunk.match(/^data: (.*)$/m)?.[1] ?? 'null');
      if (ev === 'app') appId = data.id;
      if (ev === 'step') emit(data.step, data.message);
      if (ev === 'done') done = data;
      if (ev === 'fail') throw new Error(data.error);
    }
  }
  if (!done) throw new Error('The connection dropped before the listing was finished');
  link = `${opt.server}/app#ws=${cfg.workspace}&app=${appId}`;
  return done;
}

async function runLocal() {
  process.env.STORESCRIBE_NO_DB = '1';
  process.env.MODEL_API ??= 'ollama';
  process.env.MODEL_NAME ??= 'gemma4:latest';
  const { writeListing } = await import('../src/writer.js');
  const sharp = (await import('sharp')).default;
  const images = await Promise.all(ctx.screenshots.map((f) => sharp(f).resize({ width: 768, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()));
  return writeListing({ workspaceId: 'local', app, images, stores, locales, emit });
}

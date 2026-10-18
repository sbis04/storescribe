import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { pool, migrate, ensureWorkspace, meter, hit, countHits } from './db.js';
import { writeListing } from './writer.js';
import { STORES, LOCALES, lint, lengthOf, packKeywords } from './limits.js';
import { searchStore, findRank, serpEnabled } from './serp.js';
import { MODEL } from './model.js';

const BUILD = Date.now().toString(36);
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
app.use(express.json({ limit: '200kb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 5 } });

// Limits: every job is several paid model calls and every uncached search spends SerpApi quota.
const JOBS_PER_WORKSPACE = Number(process.env.JOBS_PER_WORKSPACE ?? 15);
const JOBS_PER_IP = Number(process.env.JOBS_PER_IP ?? 25);
const DAILY_JOBS = Number(process.env.DAILY_JOB_BUDGET ?? 150);
const DAILY_RANK_CHECKS = Number(process.env.DAILY_RANK_BUDGET ?? 40);
const MAX_LOCALES = 6;

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// HTML is never cached, and points at this build's assets so a deploy shows up on the next load.
const html = async (file, res) => {
  const { readFile } = await import('node:fs/promises');
  const page = (await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8')).replaceAll('?v=BUILD', `?v=${BUILD}`);
  res.set('cache-control', 'no-cache').type('html').send(page);
};
app.get(['/', '/index.html'], (_req, res) => html('index.html', res));
app.get(['/app', '/app.html'], (_req, res) => html('app.html', res));
app.use(express.static('public', { maxAge: '7d', index: false }));

// ---------- workspace (one per browser, no sign-up) ----------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function workspace(req, res, next) {
  const id = req.get('x-workspace');
  if (!id || !UUID.test(id)) return res.status(400).json({ error: 'Missing workspace id' });
  await ensureWorkspace(id);
  req.ws = id;
  next();
}
async function ownApp(req, res) {
  const { rows } = await pool.query('SELECT * FROM apps WHERE id = $1 AND workspace_id = $2', [req.params.id, req.ws]);
  if (!rows[0]) { res.status(404).json({ error: 'App not found' }); return null; }
  return rows[0];
}

app.get('/api/config', (_req, res) => res.json({
  stores: STORES, locales: LOCALES, serp: serpEnabled, model: MODEL, maxLocales: MAX_LOCALES,
}));

// ---------- generate (streams progress as server-sent events) ----------
app.post('/api/generate', workspace, upload.array('screens', 5), async (req, res) => {
  const b = req.body;
  const name = String(b.name ?? '').trim().slice(0, 30);
  const pitch = String(b.pitch ?? '').trim().slice(0, 200);
  if (!name || !pitch) return res.status(400).json({ error: 'Add your app name and a one-line pitch' });
  const stores = [].concat(b.stores ?? ['ios', 'android']).filter((s) => STORES[s]);
  const locales = [...new Set(['en-US', ...[].concat(b.locales ?? []).filter((l) => LOCALES[l])])].slice(0, MAX_LOCALES);
  if (!stores.length) return res.status(400).json({ error: 'Pick at least one store' });

  if (await countHits(`job:${req.ws}`, 86400) >= JOBS_PER_WORKSPACE || await countHits(`job-ip:${req.ip}`, 86400) >= JOBS_PER_IP) {
    return res.status(429).json({ error: `That's the limit of ${JOBS_PER_WORKSPACE} listings a day on the free plan. Come back tomorrow.` });
  }
  if (await countHits('budget:jobs', 86400) >= DAILY_JOBS) {
    return res.status(503).json({ error: 'StoreScribe has hit today\'s capacity. Your history and rank charts still work.' });
  }
  await Promise.all([hit(`job:${req.ws}`), hit(`job-ip:${req.ip}`), hit('budget:jobs')]);

  // Screenshots are downsized for the model and never written to disk or the database.
  const images = await Promise.all((req.files ?? []).map((f) =>
    sharp(f.buffer).rotate().resize({ width: 768, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()));

  let appRow;
  const fields = {
    name, pitch,
    details: String(b.details ?? '').trim().slice(0, 1500),
    category: String(b.category ?? '').trim().slice(0, 60),
    audience: String(b.audience ?? '').trim().slice(0, 200),
    seed_terms: String(b.seed_terms ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 3),
  };
  if (b.app_id) {
    const { rows } = await pool.query(
      `UPDATE apps SET name=$3, pitch=$4, details=$5, category=$6, audience=$7, seed_terms=$8 WHERE id=$1 AND workspace_id=$2 RETURNING *`,
      [b.app_id, req.ws, fields.name, fields.pitch, fields.details, fields.category, fields.audience, fields.seed_terms]);
    appRow = rows[0];
  }
  if (!appRow) {
    const { rows } = await pool.query(
      `INSERT INTO apps (workspace_id, name, pitch, details, category, audience, seed_terms) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.ws, fields.name, fields.pitch, fields.details, fields.category, fields.audience, fields.seed_terms]);
    appRow = rows[0];
  }

  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('app', { id: appRow.id });
  try {
    const out = await writeListing({
      workspaceId: req.ws, app: appRow, images, stores, locales,
      emit: (step, message, data) => send('step', { step, message, ...data }),
    });
    if (out.screens.features.length && !b.app_id) {
      await pool.query('UPDATE apps SET features = $2 WHERE id = $1', [appRow.id, out.screens.features.join('; ')]);
    }
    const version = await saveVersion(appRow.id, out.results, out.research, out.model, out);
    send('done', { version, research: out.research, results: out.results, terms: out.terms, cost: out.cost, tokensIn: out.tokensIn, tokensOut: out.tokensOut });
  } catch (err) {
    console.error(err);
    send('fail', { error: 'The writer hit a problem. Try again in a minute.' });
  }
  res.end();
});

async function saveVersion(appId, results, research, model, stats = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [appId]);
    const { rows } = await client.query('SELECT coalesce(max(version), 0) + 1 AS v FROM listing_versions WHERE app_id = $1', [appId]);
    const v = rows[0].v;
    for (const r of results) {
      await client.query(
        `INSERT INTO listing_versions (app_id, version, store, locale, fields, issues, research, model, tokens_in, tokens_out)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [appId, v, r.store, r.locale, r.fields, JSON.stringify(r.issues), research?.[r.store] ?? null, model,
          r.locale === 'en-US' ? stats.tokensIn ?? 0 : 0, r.locale === 'en-US' ? stats.tokensOut ?? 0 : 0]);
    }
    await client.query('COMMIT');
    return v;
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

// ---------- apps, versions, edits ----------
app.get('/api/apps', workspace, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.pitch, a.created_at,
            (SELECT max(version) FROM listing_versions v WHERE v.app_id = a.id) AS versions
     FROM apps a WHERE a.workspace_id = $1 ORDER BY a.created_at DESC LIMIT 50`, [req.ws]);
  res.json(rows);
});

app.get('/api/apps/:id', workspace, async (req, res) => {
  const a = await ownApp(req, res); if (!a) return;
  const { rows: versions } = await pool.query(
    `SELECT version, min(time) AS time, array_agg(DISTINCT store) AS stores, array_agg(DISTINCT locale) AS locales, max(model) AS model
     FROM listing_versions WHERE app_id = $1 GROUP BY version ORDER BY version DESC`, [a.id]);
  const v = Number(req.query.version) || versions[0]?.version;
  const { rows: results } = v ? await pool.query(
    `SELECT store, locale, fields, issues, research, time FROM listing_versions WHERE app_id = $1 AND version = $2 ORDER BY store = 'ios' DESC, locale = 'en-US' DESC, locale`,
    [a.id, v]) : { rows: [] };
  res.json({ app: a, versions, version: v, results });
});

app.patch('/api/apps/:id', workspace, async (req, res) => {
  const a = await ownApp(req, res); if (!a) return;
  const clean = (s) => (s == null ? null : String(s).trim().slice(0, 200) || null);
  await pool.query('UPDATE apps SET ios_id = $2, android_id = $3 WHERE id = $1',
    [a.id, clean(req.body.ios_id ?? a.ios_id), clean(req.body.android_id ?? a.android_id)]);
  res.json({ ok: true });
});

app.delete('/api/apps/:id', workspace, async (req, res) => {
  const a = await ownApp(req, res); if (!a) return;
  await pool.query('DELETE FROM listing_versions WHERE app_id = $1', [a.id]);
  await pool.query('DELETE FROM keyword_ranks WHERE app_id = $1', [a.id]);
  await pool.query('DELETE FROM apps WHERE id = $1', [a.id]);
  res.json({ ok: true });
});

// Hand edits: re-checked against the store rules, then saved as a new version so nothing is ever lost.
app.post('/api/apps/:id/versions', workspace, async (req, res) => {
  const a = await ownApp(req, res); if (!a) return;
  const results = [].concat(req.body.results ?? []).filter((r) => STORES[r.store] && LOCALES[r.locale]).slice(0, 40).map((r) => {
    const fields = Object.fromEntries(Object.keys(STORES[r.store].fields).map((k) => [k, String(r.fields?.[k] ?? '').slice(0, 4100)]));
    return { store: r.store, locale: r.locale, fields, issues: lint(r.store, fields, { appName: a.name }) };
  });
  if (!results.length) return res.status(400).json({ error: 'Nothing to save' });
  const version = await saveVersion(a.id, results, null, 'edited by hand');
  res.json({ version, results });
});

app.post('/api/lint', (req, res) => {
  const { store, fields } = req.body ?? {};
  if (!STORES[store]) return res.status(400).json({ error: 'Unknown store' });
  const lengths = Object.fromEntries(Object.entries(STORES[store].fields).map(([k, s]) => [k, lengthOf(String(fields?.[k] ?? ''), s)]));
  res.json({ issues: lint(store, fields ?? {}, { appName: req.body.appName }), lengths });
});

app.post('/api/pack-keywords', (req, res) => {
  const { terms = [], name = '', subtitle = '' } = req.body ?? {};
  res.json({ keywords: packKeywords([].concat(terms).slice(0, 60), { name, subtitle }) });
});

// ---------- rank tracking (a time series per app, store and search term) ----------
app.post('/api/apps/:id/ranks', workspace, async (req, res) => {
  const a = await ownApp(req, res); if (!a) return;
  if (!serpEnabled) return res.status(503).json({ error: 'Rank checks need a SerpApi key on the server' });
  const store = STORES[req.body.store] ? req.body.store : 'ios';
  const terms = [].concat(req.body.terms ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 5);
  if (!terms.length) return res.status(400).json({ error: 'Add a search term to track' });
  if (await countHits(`rank:${req.ws}`, 86400) + terms.length > 15 || await countHits('budget:rank', 86400) + terms.length > DAILY_RANK_CHECKS) {
    return res.status(429).json({ error: 'That\'s enough rank checks for today. Ranks move slowly; check again tomorrow.' });
  }
  const storeId = store === 'ios' ? a.ios_id : a.android_id;
  const out = [];
  for (const term of terms) {
    await Promise.all([hit(`rank:${req.ws}`), hit('budget:rank')]);
    const { results, cached } = await searchStore(store, term);
    if (!cached) await meter(req.ws, 'rank', { searches: 1 });
    const rank = findRank(results, { storeId, name: a.name });
    await pool.query('INSERT INTO keyword_ranks (app_id, store, term, rank) VALUES ($1,$2,$3,$4)', [a.id, store, term, rank]);
    out.push({ term, rank, top: results.slice(0, 5).map((r) => ({ position: r.position, title: r.title, icon: r.icon })) });
  }
  res.json(out);
});

app.get('/api/apps/:id/ranks', workspace, async (req, res) => {
  const a = await ownApp(req, res); if (!a) return;
  // One point per term per day (the day's best rank), last 30 days.
  const { rows } = await pool.query(
    `SELECT store, term, time_bucket(INTERVAL '1 day', time) AS day, min(rank) AS rank, count(*) FILTER (WHERE rank IS NULL) AS misses
     FROM keyword_ranks WHERE app_id = $1 AND time > now() - INTERVAL '30 days'
     GROUP BY store, term, day ORDER BY store, term, day`, [a.id]);
  res.json(rows);
});

// ---------- usage (from the continuous aggregate) ----------
app.get('/api/usage', workspace, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT coalesce(sum(listings), 0)::int AS listings, coalesce(sum(translations), 0)::int AS translations,
            coalesce(sum(searches), 0)::int AS searches, coalesce(sum(tokens_in + tokens_out), 0)::bigint AS tokens,
            coalesce(sum(cost_usd), 0)::float AS cost
     FROM usage_daily WHERE workspace_id = $1 AND day >= date_trunc('month', now())`, [req.ws]);
  res.json({ ...rows[0], model: MODEL });
});

await migrate();
const PORT = Number(process.env.PORT ?? 8080);
app.listen(PORT, () => console.log(`StoreScribe on http://localhost:${PORT} (model ${MODEL}${serpEnabled ? ', SerpApi on' : ''})`));

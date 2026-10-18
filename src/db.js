import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:storescribe@localhost:5433/storescribe';
const remote = /sslmode=|tsdb\.cloud/.test(url);
// Tiger Cloud signs its certificates with its own CA; verify against it rather than skipping checks.
const ca = /tsdb\.cloud/.test(url) ? readFileSync(new URL('../db/tiger-ca.pem', import.meta.url), 'utf8') : undefined;
export const pool = new pg.Pool({
  connectionString: url.replace(/[?&]sslmode=[^&]*/, ''),
  ssl: remote ? { ca, rejectUnauthorized: true } : undefined,
  options: '-c search_path=storescribe,public', // StoreScribe's tables live in their own schema
  max: 5,
});

export async function migrate() {
  const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  for (let i = 1; ; i++) {
    try { await pool.query(sql); return; } catch (err) {
      if (i >= 10) throw err;
      console.log(`database not ready (${err.code ?? err.message}), retrying…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function ensureWorkspace(id) {
  await pool.query('INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
}

export async function meter(workspaceId, kind, { tokensIn = 0, tokensOut = 0, searches = 0, cost = 0 } = {}) {
  await pool.query(
    'INSERT INTO usage (workspace_id, kind, tokens_in, tokens_out, searches, cost_usd) VALUES ($1,$2,$3,$4,$5,$6)',
    [workspaceId, kind, tokensIn, tokensOut, searches, cost],
  );
}

export async function hit(bucket) {
  await pool.query('INSERT INTO rate_hits (bucket) VALUES ($1)', [bucket]);
}
export async function countHits(bucket, seconds) {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM rate_hits WHERE bucket = $1 AND at > now() - make_interval(secs => $2)', [bucket, seconds]);
  return rows[0].n;
}

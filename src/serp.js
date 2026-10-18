// Competitor research and rank checks through SerpApi's App Store and Google Play engines.
// Every search is cached in the database for a day: SerpApi's free plan is a few hundred searches a month.
import { pool, noDb } from './db.js';

const KEY = process.env.SERPAPI_KEY;
export const serpEnabled = Boolean(KEY);
// SerpApi keys are 64 hex characters. SearchApi.io keys (24 characters) work too: same engines, same result shape.
const SEARCHAPI = Boolean(KEY) && !/^[0-9a-f]{64}$/i.test(KEY);
export const searchProvider = !KEY ? null : SEARCHAPI ? 'SearchApi' : 'SerpApi';
const TTL_HOURS = 24;

// Returns [{ position, id, title, developer, rating, reviews, description, icon }] for the top results.
export async function searchStore(store, term, country = 'us') {
  const q = term.trim().toLowerCase();
  const { rows } = noDb ? { rows: [] } : await pool.query(
    `SELECT results FROM serp_cache WHERE store = $1 AND term = $2 AND country = $3 AND fetched_at > now() - make_interval(hours => $4)`,
    [store, q, country, TTL_HOURS],
  );
  if (rows[0]) return { results: rows[0].results, cached: true };
  if (!KEY) return { results: [], cached: false };

  const params = store === 'ios'
    ? { engine: 'apple_app_store', term: q, country, num: '15' }
    : { engine: SEARCHAPI ? 'google_play_store' : 'google_play', store: 'apps', q, gl: country, hl: 'en' };
  const base = SEARCHAPI ? 'https://www.searchapi.io/api/v1/search' : 'https://serpapi.com/search.json';
  const res = await fetch(`${base}?${new URLSearchParams({ ...params, api_key: KEY })}`);
  if (!res.ok) throw new Error(`${searchProvider} ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${searchProvider}: ${j.error}`);
  const results = (store === 'ios' ? parseApple(j) : parsePlay(j)).slice(0, 15);
  if (!noDb) await pool.query(
    `INSERT INTO serp_cache (store, term, country, results) VALUES ($1, $2, $3, $4)
     ON CONFLICT (store, term, country) DO UPDATE SET results = EXCLUDED.results, fetched_at = now()`,
    [store, q, country, JSON.stringify(results)],
  );
  return { results, cached: false };
}

function parseApple(j) {
  return (j.organic_results ?? []).map((r, i) => ({
    position: r.position ?? i + 1,
    id: String(r.id ?? r.bundle_id ?? ''),
    title: r.title ?? '',
    developer: r.developer?.name ?? r.developer ?? '',
    rating: r.rating?.[0]?.rating ?? r.rating ?? null,
    reviews: r.rating?.[0]?.count ?? null,
    description: (r.description ?? '').slice(0, 600),
    icon: r.logos?.[0]?.link ?? r.logos?.link ?? r.icon ?? null,
  }));
}

function parsePlay(j) {
  const items = (j.organic_results ?? []).flatMap((s) => s.items ?? []).concat(j.app_highlight ? [j.app_highlight] : []);
  return items.map((r, i) => ({
    position: i + 1,
    id: r.product_id ?? r.id ?? '',
    title: r.title ?? '',
    developer: r.author ?? '',
    rating: r.rating ?? null,
    reviews: null,
    description: (r.description ?? '').slice(0, 600),
    icon: r.thumbnail ?? null,
  }));
}

// Where an app ranks for a term: matched on store id when known, else on its name.
export function findRank(results, { storeId, name }) {
  const n = name?.toLowerCase();
  const hit = results.find((r) => (storeId && r.id === storeId) || (n && r.title.toLowerCase().startsWith(n)));
  return hit ? hit.position : null;
}

// Words that recur across competitors' names and blurbs: the vocabulary the category actually searches with.
const STOP = new Set('the and for with your you app apps from that this are our all can get more into make made easy best free new one any use using keep time their them they helps help its it\'s also just like every what when where which who will have has been was were how than then out about over only each other through while see real around find whether information features watch device world right now need want lets let'.split(' '));
export function commonTerms(results, exclude = []) {
  const skip = new Set(exclude.flatMap((e) => e.toLowerCase().split(/\W+/)));
  const freq = new Map();
  for (const r of results) {
    const words = new Set(`${r.title} ${r.description}`.toLowerCase().match(/\p{L}{3,}/gu) ?? []);
    for (const w of words) if (!STOP.has(w) && !skip.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([term, apps]) => ({ term, apps }));
}

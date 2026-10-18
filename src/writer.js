// The pipeline: read the screenshots → research the category → draft per store → enforce the rules → localize.
// Gemma does the writing; code owns every limit, so nothing over-length or off-policy reaches the user.
import { ask, costOf, MODEL } from './model.js';
import { STORES, LOCALES, lengthOf, hardTrim, packKeywords, lint } from './limits.js';
import { searchStore, commonTerms, serpEnabled } from './serp.js';
import { meter } from './db.js';

const STYLE = `Write like a sharp human copywriter, not an ad. Lead with what the person gets, in concrete words.
Never use: revolutionary, seamless, unleash, elevate, game-changer, cutting-edge, "take it to the next level", "look no further".
No em dashes. No ALL CAPS words. Vary your words: don't repeat the same keyword over and over, stores penalise keyword stuffing. At most two emoji in a description, none elsewhere.
Only state facts from the brief: never invent features, updates, numbers, awards or reviews.
Never name or compare to competitor apps. Never claim "#1", "best", "free" or rankings in a name or subtitle.`;

const str = { type: 'string' };
const SCHEMAS = {
  screens: { type: 'object', properties: { features: { type: 'array', items: str }, look: str }, required: ['features', 'look'] },
  seeds: { type: 'object', properties: { terms: { type: 'array', items: str } }, required: ['terms'] },
  ios: {
    type: 'object',
    properties: { name: str, subtitle: str, promotional_text: str, description: str, keyword_candidates: { type: 'array', items: str } },
    required: ['name', 'subtitle', 'promotional_text', 'description', 'keyword_candidates'],
  },
  android: {
    type: 'object',
    properties: { title: str, short_description: str, full_description: str },
    required: ['title', 'short_description', 'full_description'],
  },
  fix: { type: 'object', properties: { text: str }, required: ['text'] },
  brief: {
    type: 'object',
    properties: { pitch: str, details: str, audience: str, category: str, seed_terms: { type: 'array', items: str }, features: { type: 'array', items: str } },
    required: ['pitch', 'details', 'audience', 'category', 'seed_terms', 'features'],
  },
};

// A run accumulates tokens so the whole job is metered as one line per step.
class Run {
  constructor(workspaceId, emit) { this.ws = workspaceId; this.emit = emit; this.tin = 0; this.tout = 0; }
  async ask(kind, prompt, opts) {
    const r = await ask(prompt, opts);
    this.tin += r.tokensIn; this.tout += r.tokensOut;
    await meter(this.ws, kind, { tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: costOf(r.tokensIn, r.tokensOut) });
    return r;
  }
}

export async function readScreens(run, images) {
  if (!images.length) return { features: [], look: '' };
  run.emit('screens', `Reading ${images.length} screenshot${images.length > 1 ? 's' : ''}`);
  const { data } = await run.ask('screens', `These are screenshots of one mobile app. List what a user can actually do in it, based only on what you see.
features: up to 8 short phrases, each a concrete capability visible in the screens (e.g. "split a bill between friends", "dark mode").
look: one sentence on the visual style.
Reply with JSON only.`, { schema: SCHEMAS.screens, images, temperature: 0.2, maxTokens: 500 });
  return { features: (data.features ?? []).slice(0, 8), look: data.look ?? '' };
}

// From a scanned repo (README, screen names, current listing) to the same brief the web form collects.
export async function briefFromRepo(run, app, context) {
  run.emit('brief', 'Reading the project');
  const { data } = await run.ask('brief', `Below is what was found in a mobile app's source code repository. Write the brief a store-listing copywriter needs.
Only use facts present below. Ignore build steps, licences, contributors and developer tooling.
pitch: one line, at most 120 characters, what the app does for the person using it.
details: up to 600 characters: the main features and what makes it different, in plain words.
audience: who it's for, a few words.
category: the App Store category it belongs in, one or two words.
seed_terms: 3 short phrases (1 to 3 words) people would type into the App Store to find this kind of app. Not the app's name.
features: up to 8 short phrases, each a concrete thing a user can do, taken from the screens and README.

App name: ${app.name}
${context}

Reply with JSON only.`, { schema: SCHEMAS.brief, temperature: 0.2, maxTokens: 900 });
  return data;
}

export async function seedTerms(run, app) {
  if (app.seed_terms?.length) return app.seed_terms.slice(0, 3);
  const { data } = await run.ask('seeds', `An app called "${app.name}": ${app.pitch}
${app.details}
Give 3 short search phrases (1 to 3 words each) a person would type into the App Store to find an app like this. Generic category words, not the app's name.
Reply with JSON only.`, { schema: SCHEMAS.seeds, temperature: 0.2, maxTokens: 120 });
  return (data.terms ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 3);
}

export async function research(run, stores, terms, country = 'us') {
  const out = {};
  for (const store of stores) {
    const seen = new Map();
    let searches = 0;
    for (const term of terms) {
      if (serpEnabled) run.emit('research', `Searching ${STORES[store].label} for "${term}"`);
      try {
        const { results, cached } = await searchStore(store, term, country);
        if (!cached && serpEnabled) searches++;
        for (const r of results.slice(0, 8)) if (!seen.has(r.id || r.title)) seen.set(r.id || r.title, { ...r, term });
      } catch (err) { run.emit('research', `Search failed: ${err.message}`); }
    }
    if (searches) await meter(run.ws, 'search', { searches });
    const competitors = [...seen.values()].slice(0, 10);
    out[store] = { terms, competitors, common: commonTerms(competitors) };
  }
  return out;
}

const brandsOf = (competitors) => competitors.map((c) => c.title.split(/[:\-–|]/)[0].trim()).filter((b) => b.length > 2);

function briefOf(app, screens, rs) {
  const comp = rs?.competitors?.length
    ? `Top apps people see for "${rs.terms.join('", "')}" (study how they position, then stand apart; never mention them):
${rs.competitors.slice(0, 8).map((c) => `- ${c.title}: ${c.description.slice(0, 160).replace(/\s+/g, ' ')}`).join('\n')}
Words that recur across them (the category's search vocabulary): ${rs.common.slice(0, 15).map((t) => t.term).join(', ')}`
    : '';
  return `App name: ${app.name}
One-line pitch: ${app.pitch}
${app.details ? `Details from the developer: ${app.details}\n` : ''}${app.category ? `Category: ${app.category}\n` : ''}${app.audience ? `Who it's for: ${app.audience}\n` : ''}${screens.features.length ? `Seen in the screenshots: ${screens.features.join('; ')}\n` : ''}${comp}`;
}

async function draft(run, store, app, screens, rs) {
  run.emit('draft', `Writing the ${STORES[store].label} listing`);
  const f = STORES[store].fields;
  const prompt = store === 'ios'
    ? `You write App Store listings that rank and convert.
${briefOf(app, screens, rs)}

Write the listing in English (US). Hard limits, counted in characters:
- name: at most ${f.name.max}. Start with "${app.name}", then a short keyword phrase if it fits (e.g. "${app.name}: Budget Planner").
- subtitle: at most ${f.subtitle.max}. A benefit, with a search keyword not already in the name.
- promotional_text: at most ${f.promotional_text.max}. One or two sentences that make someone want it today. Only describe what the app already does: never invent updates, new features or offers.
- description: 1200 to 2500 characters. A strong first two lines (they show before "more"), then short paragraphs and a few "•" bullets of real features. Plain text, no markdown, no headings with #.
- keyword_candidates: 20 single words or short phrases people search for, most valuable first. Do not repeat words from the name or subtitle. No competitor names.
${STYLE}
Reply with JSON only.`
    : `You write Google Play listings that rank and convert. Google Play ranks on the words in the full description, so use the category's search vocabulary naturally, never as a list.
${briefOf(app, screens, rs)}

Write the listing in English (US). Hard limits, counted in characters:
- title: at most ${f.title.max}. Start with "${app.name}", then a short keyword phrase if it fits.
- short_description: at most ${f.short_description.max}. One line that makes someone tap.
- full_description: 1500 to 3000 characters. Strong opening paragraph, then short sections and "•" bullets of real features. Plain text, no markdown.
${STYLE}
Reply with JSON only.`;
  const { data } = await run.ask('draft', prompt, { schema: SCHEMAS[store], temperature: 0.6, maxTokens: 2200 });
  return data;
}

// In a name, subtitle or short line, saying the same word twice wastes precious characters ("planes & planes").
function repeated(v, s) {
  if (s.max > 200) return null;
  const words = v.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
  const seen = new Set();
  for (const w of words) { const base = w.replace(/s$/, ''); if (seen.has(base)) return w; seen.add(base); }
  return null;
}

// Ask the model to shorten anything over its limit; after two tries, cut cleanly in code.
async function enforce(run, store, fields, app, locale, avoid, keywordCandidates) {
  const spec = STORES[store].fields;
  for (const [k, s] of Object.entries(spec)) {
    if (k === 'keywords') continue;
    let v = String(fields[k] ?? '').trim();
    for (let tries = 0; tries < 2 && (lengthOf(v, s) > s.max || repeated(v, s)); tries++) {
      const dup = repeated(v, s);
      run.emit('fix', dup && lengthOf(v, s) <= s.max ? `${s.label} repeats "${dup}", rewording it` : `${s.label} is ${lengthOf(v, s)}/${s.max}, tightening it`);
      const { data } = await run.ask('fix', `Rewrite this ${s.label.toLowerCase()} for the ${STORES[store].label} in ${LOCALES[locale]}, keeping the meaning and any app name, in at most ${Math.floor(s.max * 0.92)} characters, without repeating any word. It is currently ${lengthOf(v, s)}.
Text: ${v}
Reply with JSON only: {"text": "..."}`, { schema: SCHEMAS.fix, temperature: 0.3, maxTokens: s.max > 200 ? 1800 : 120 });
      v = String(data.text ?? v).trim();
    }
    fields[k] = hardTrim(v, s);
  }
  if (store === 'ios') {
    fields.keywords = packKeywords(keywordCandidates ?? [], { name: fields.name, subtitle: fields.subtitle, avoid, max: spec.keywords.max });
  }
  const out = Object.fromEntries(Object.keys(spec).map((k) => [k, fields[k] ?? '']));
  return { fields: out, issues: lint(store, out, { appName: app.name }) };
}

async function localize(run, store, app, en, enCandidates, locale) {
  run.emit('translate', `Localizing for ${LOCALES[locale]} (${STORES[store].label})`);
  const f = STORES[store].fields;
  const limits = Object.entries(f).filter(([k]) => k !== 'keywords').map(([k, s]) => `- ${k}: at most ${k.includes('description') && s.max > 1000 ? 3000 : s.max} characters`).join('\n');
  const source = Object.fromEntries(Object.entries(en).filter(([k]) => k !== 'keywords'));
  const { data } = await run.ask('translate', `Localize this ${STORES[store].label} listing for ${LOCALES[locale]} (${locale}). Write it the way a native copywriter in that market would, not a word-for-word translation. Keep the app name "${app.name}" as is.
${store === 'ios' ? `Also give keyword_candidates: 20 words people in that market actually type into the App Store for this kind of app (in ${LOCALES[locale]}, not translations of English keywords if locals search differently). English version had: ${enCandidates.slice(0, 20).join(', ')}.\n` : ''}Limits:
${limits}
${STYLE}
English listing (JSON): ${JSON.stringify(source)}
Reply with JSON only, same keys${store === 'ios' ? ' plus keyword_candidates' : ''}.`, { schema: SCHEMAS[store], temperature: 0.4, maxTokens: 2600 });
  return data;
}

// Runs the whole job and returns { research, screens, results: [{ store, locale, fields, issues }] }.
export async function writeListing({ workspaceId, app, images, stores, locales, country = 'us', emit = () => {} }) {
  const run = new Run(workspaceId, emit);
  let brief;
  if (app.context) {
    brief = await briefFromRepo(run, app, app.context);
    app = {
      ...app,
      pitch: app.pitch || brief.pitch || '',
      details: app.details || brief.details || '',
      audience: app.audience || brief.audience || '',
      category: app.category || brief.category || '',
      seed_terms: app.seed_terms?.length ? app.seed_terms : (brief.seed_terms ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 3),
    };
    emit('brief-done', `Pitch: ${app.pitch}`, { brief: { ...brief, pitch: app.pitch } });
  }
  const screens = await readScreens(run, images);
  if (brief?.features?.length) screens.features = [...new Set([...screens.features, ...brief.features])].slice(0, 10);
  const terms = await seedTerms(run, app);
  emit('terms', `Researching: ${terms.join(', ')}`, { terms });
  const rs = await research(run, stores, terms, country);
  emit('research-done', serpEnabled ? 'Competitor research done'
    : process.env.STORESCRIBE_LOCAL ? 'Offline mode: no web searches, nothing leaves this machine' : 'No SerpApi key, so skipping competitor research', { research: rs });

  const results = [];
  for (const store of stores) {
    const avoid = brandsOf(rs[store]?.competitors ?? []).filter((b) => b.toLowerCase() !== app.name.toLowerCase());
    const d = await draft(run, store, app, screens, rs[store]);
    const en = await enforce(run, store, d, app, 'en-US', avoid, d.keyword_candidates);
    results.push({ store, locale: 'en-US', ...en });
    emit('result', `${STORES[store].label} listing ready`, { store, locale: 'en-US', ...en });
    for (const locale of locales.filter((l) => l !== 'en-US')) {
      try {
        const l = await localize(run, store, app, en.fields, d.keyword_candidates ?? [], locale);
        const done = await enforce(run, store, l, app, locale, avoid, l.keyword_candidates);
        results.push({ store, locale, ...done });
        emit('result', `${LOCALES[locale]} ready`, { store, locale, ...done });
      } catch (err) { emit('error', `${LOCALES[locale]} failed: ${err.message}`); }
    }
  }
  return { app, brief, screens, terms, research: rs, results, model: MODEL, tokensIn: run.tin, tokensOut: run.tout, cost: costOf(run.tin, run.tout) };
}

// The hard rules of each store. The model drafts; this file decides what is allowed to ship.

export const STORES = {
  ios: {
    label: 'App Store',
    fields: {
      name: { label: 'App name', max: 30 },
      subtitle: { label: 'Subtitle', max: 30 },
      promotional_text: { label: 'Promotional text', max: 170 },
      keywords: { label: 'Keywords', max: 100, bytes: true }, // Apple counts bytes, so Japanese gets ~33 characters
      description: { label: 'Description', max: 4000 },
    },
  },
  android: {
    label: 'Google Play',
    fields: {
      title: { label: 'App name', max: 30 },
      short_description: { label: 'Short description', max: 80 },
      full_description: { label: 'Full description', max: 4000 },
    },
  },
};

export const LOCALES = {
  'en-US': 'English (US)', 'es-ES': 'Spanish (Spain)', 'es-MX': 'Spanish (Mexico)', 'fr-FR': 'French', 'de-DE': 'German',
  'it-IT': 'Italian', 'pt-BR': 'Portuguese (Brazil)', 'ja-JP': 'Japanese', 'ko-KR': 'Korean', 'zh-Hans': 'Chinese (Simplified)',
  'hi-IN': 'Hindi', 'id-ID': 'Indonesian', 'tr-TR': 'Turkish', 'nl-NL': 'Dutch',
};

const bytes = (s) => Buffer.byteLength(s, 'utf8');
// Characters as a person counts them (an emoji or accented letter is one).
const chars = (s) => [...new Intl.Segmenter().segment(s)].length;
export const lengthOf = (s, spec) => (spec.bytes ? bytes(s) : chars(s));

// Everyday words that are naturally frequent and say nothing about keyword stuffing.
const COMMON = new Set('your with that this from have more every they their them what when where which while will into than then just also each like make made keep about over only been were there here these those does need want ever even much many most some such very youre dont'.split(' '));

// Google Play rejects these in titles, and both stores discourage them anywhere in name lines.
const BANNED_IN_TITLES = /\b(free|best|#?1|no\.? ?1|top|sale|discount|download now|install now)\b/i;

// Apple indexes the name and subtitle already, so repeating those words in the keywords field wastes bytes.
// Builds the field greedily: most important terms first, no duplicates, no spaces after commas.
export function packKeywords(terms, { name = '', subtitle = '', avoid = [], max = 100 } = {}) {
  const taken = new Set(`${name} ${subtitle}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const blocked = avoid.map((a) => a.toLowerCase());
  const out = [];
  const seen = new Set();
  for (const raw of terms.flatMap((t) => String(t).split(','))) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!t || seen.has(t) || taken.has(t) || taken.has(t.replace(/s$/, ''))) continue;
    if (blocked.some((b) => b && (t.includes(b) || b.includes(t)) && t.length > 2)) continue; // competitor names
    const singular = t.replace(/s$/, '');
    if (seen.has(singular) || seen.has(`${t}s`)) continue;
    if (bytes([...out, t].join(',')) > max) continue;
    out.push(t); seen.add(t);
  }
  return out.join(',');
}

// Trim at a word or sentence boundary so a forced cut still reads cleanly.
export function hardTrim(s, spec) {
  if (lengthOf(s, spec) <= spec.max) return s;
  let cut = s;
  while (lengthOf(cut, spec) > spec.max) cut = cut.slice(0, -1);
  const sentence = cut.lastIndexOf('. ');
  if (spec.max > 200 && sentence > spec.max * 0.7) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  return (space > cut.length * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, '');
}

// Problems a reviewer or the store would flag. Each is { field, level: 'error'|'warn', text }.
export function lint(store, fields, { appName = '' } = {}) {
  const issues = [];
  const spec = STORES[store].fields;
  for (const [k, s] of Object.entries(spec)) {
    const v = fields[k] ?? '';
    if (!v.trim()) issues.push({ field: k, level: 'error', text: `${s.label} is empty` });
    else if (lengthOf(v, s) > s.max) issues.push({ field: k, level: 'error', text: `${s.label} is ${lengthOf(v, s)}/${s.max}${s.bytes ? ' bytes' : ''}` });
  }
  const title = store === 'ios' ? fields.name : fields.title;
  if (title && BANNED_IN_TITLES.test(title)) issues.push({ field: store === 'ios' ? 'name' : 'title', level: 'error', text: `"${title.match(BANNED_IN_TITLES)[0]}" isn't allowed in an app name on Google Play` });
  if (title && appName && !title.toLowerCase().includes(appName.toLowerCase())) issues.push({ field: store === 'ios' ? 'name' : 'title', level: 'warn', text: `Doesn't include your app's name "${appName}"` });
  if (store === 'ios' && fields.keywords && /,\s/.test(fields.keywords)) issues.push({ field: 'keywords', level: 'warn', text: 'Spaces after commas waste bytes' });
  const body = store === 'ios' ? fields.description : fields.full_description;
  if (body) {
    const words = (body.toLowerCase().match(/\p{L}{4,}/gu) ?? []).filter((w) => !COMMON.has(w));
    const freq = {};
    for (const w of words) freq[w] = (freq[w] ?? 0) + 1;
    const [w, n] = Object.entries(freq).sort((a, b) => b[1] - a[1])[0] ?? [];
    if (w && words.length > 60 && n / words.length > 0.04) issues.push({ field: store === 'ios' ? 'description' : 'full_description', level: 'warn', text: `"${w}" is ${Math.round((n / words.length) * 100)}% of the words; stores treat that as keyword stuffing` });
    if ((body.match(/\p{Extended_Pictographic}/gu) ?? []).length > 8) issues.push({ field: store === 'ios' ? 'description' : 'full_description', level: 'warn', text: 'Lots of emoji; Play may flag it as spammy' });
  }
  return issues;
}

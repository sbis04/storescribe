const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

// ---------- theme ----------
const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
applyTheme(store.get('ss.theme'));
$('themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next); store.set('ss.theme', next);
};

// ---------- workspace: one per browser, no sign-up ----------
// The CLI prints a link with its workspace in the hash, so its listings open here for editing.
const handoff = new URLSearchParams(location.hash.slice(1));
if (/^[0-9a-f-]{36}$/i.test(handoff.get('ws') ?? '')) {
  store.set('ss.workspace', handoff.get('ws'));
  if (handoff.get('app')) store.set('ss.lastApp', handoff.get('app'));
  history.replaceState(null, '', location.pathname);
}
let ws = store.get('ss.workspace');
if (!ws) { ws = crypto.randomUUID(); store.set('ss.workspace', ws); }
const api = (path, opts = {}) => fetch(path, { ...opts, headers: { 'x-workspace': ws, ...(opts.body && !(opts.body instanceof FormData) && { 'content-type': 'application/json' }), ...opts.headers } });
const toast = (msg) => { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600); };

let CFG;
const state = { app: null, version: null, versions: [], results: [], research: {}, store: 'ios', locale: 'en-US', dirty: new Set(), shots: [] };

// ---------- setup ----------
async function boot() {
  CFG = await fetch('/api/config').then((r) => r.json());
  $('footModel').textContent = CFG.model.startsWith('gemma') ? `Gemma 4 (${CFG.model})` : CFG.model;
  $('modelNote').textContent = CFG.serp
    ? 'Takes a minute or two. Nothing you enter trains anyone\'s model.'
    : 'Takes a minute or two. Competitor research is off on this server.';
  $('langs').innerHTML = Object.entries(CFG.locales).map(([code, label]) => code === 'en-US'
    ? `<label class="chip fixed"><input type="checkbox" checked disabled><span>${label}</span></label>`
    : `<label class="chip"><input type="checkbox" name="locales" value="${code}"><span>${label}</span></label>`).join('');
  $('langs').addEventListener('change', limitLocales);
  await Promise.all([loadApps(), loadUsage()]);
  const last = store.get('ss.lastApp');
  if (last && [...$('appPicker').options].some((o) => o.value === last)) openApp(last);
}

function limitLocales() {
  const boxes = [...$('langs').querySelectorAll('input[name=locales]')];
  const n = boxes.filter((b) => b.checked).length;
  for (const b of boxes) b.disabled = !b.checked && n >= CFG.maxLocales - 1;
  $('langCount').textContent = n ? `English + ${n} more` : `English + up to ${CFG.maxLocales - 1}`;
}

async function loadApps() {
  const apps = await api('/api/apps').then((r) => r.json());
  const p = $('appPicker');
  p.hidden = !apps.length;
  p.innerHTML = `<option value="">+ New app</option>${apps.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}`;
  if (state.app) p.value = state.app.id;
}
$('appPicker').onchange = (e) => (e.target.value ? openApp(e.target.value) : newApp());

async function loadUsage() {
  const u = await api('/api/usage').then((r) => r.json());
  const pill = $('usagePill');
  if (!u.listings && !u.translations) { pill.hidden = true; return; }
  pill.hidden = false;
  pill.innerHTML = `This month: <b>${u.listings}</b> listing${u.listings === 1 ? '' : 's'} · <b>${u.translations}</b> translations · model cost <b>$${u.cost.toFixed(u.cost < 0.1 ? 4 : 2)}</b>`;
}

function newApp() {
  state.app = null; state.results = []; store.set('ss.lastApp', '');
  $('form').reset(); $('appId').value = ''; state.shots = []; renderThumbs(); limitLocales();
  $('result').hidden = true; $('empty').hidden = false; $('intro').hidden = false;
  document.querySelector('.layout').classList.remove('has-result', 'editing');
}
$('editToggle').onclick = () => {
  const open = document.querySelector('.layout').classList.toggle('editing');
  $('editToggle').setAttribute('aria-expanded', String(open));
};

// ---------- screenshots ----------
$('screens').onchange = (e) => addShots(e.target.files);
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addShots(e.dataTransfer.files); });
function addShots(files) {
  for (const f of files) if (f.type.startsWith('image/') && state.shots.length < 5) state.shots.push({ file: f, url: URL.createObjectURL(f) });
  $('screens').value = '';
  renderThumbs();
}
function renderThumbs() {
  $('thumbs').innerHTML = state.shots.map((s, i) => `<figure><img src="${s.url}" alt="Screenshot ${i + 1}"><button type="button" data-i="${i}" aria-label="Remove screenshot">×</button></figure>`).join('');
}
$('thumbs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  e.preventDefault();
  state.shots.splice(Number(b.dataset.i), 1); renderThumbs();
});

// ---------- generate ----------
$('form').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData($('form'));
  if (!fd.getAll('stores').length) return toast('Pick at least one store');
  for (const s of state.shots) fd.append('screens', s.file, s.file.name);
  $('go').disabled = true; $('go').querySelector('span').textContent = 'Writing…';
  $('empty').hidden = true; $('result').hidden = true; $('progress').hidden = false;
  document.querySelector('.layout').classList.remove('has-result', 'editing');
  $('progressTitle').textContent = `Writing ${fd.get('name')}'s listing…`;
  $('steps').innerHTML = '';
  if (innerWidth < 960) $('progress').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const t0 = Date.now();
  try {
    const res = await api('/api/generate', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Something went wrong');
    let appId, done;
    await readEvents(res, (event, d) => {
      if (event === 'app') appId = d.id;
      if (event === 'step') step(d);
      if (event === 'done') done = d;
      if (event === 'fail') throw new Error(d.error);
    });
    if (!done) throw new Error('The connection dropped before the listing was finished');
    step({ step: 'done', message: `Done in ${Math.round((Date.now() - t0) / 1000)} s` }, true);
    store.set('ss.lastApp', appId);
    await Promise.all([loadApps(), loadUsage()]);
    await openApp(appId, done.version);
  } catch (err) {
    step({ step: 'error', message: err.message }, true);
    toast(err.message);
  } finally {
    $('go').disabled = false; $('go').querySelector('span').textContent = 'Write my listing';
  }
};

async function readEvents(res, on) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = chunk.match(/^event: (.*)$/m)?.[1];
      const data = chunk.match(/^data: (.*)$/m)?.[1];
      if (ev && data) on(ev, JSON.parse(data));
    }
  }
}

function step(d, final = false) {
  const list = $('steps');
  list.querySelector('li.now')?.classList.remove('now');
  const li = document.createElement('li');
  li.textContent = d.message;
  if (d.step === 'fix') li.className = 'fix';
  if (d.step === 'error') li.className = 'err';
  else if (!final) li.classList.add('now');
  list.append(li);
}

// ---------- open an app / version ----------
async function openApp(id, version) {
  const d = await api(`/api/apps/${id}${version ? `?version=${version}` : ''}`).then((r) => (r.ok ? r.json() : null));
  if (!d) return newApp();
  Object.assign(state, { app: d.app, version: d.version, versions: d.versions, results: d.results, dirty: new Set() });
  state.research = Object.fromEntries(d.results.filter((r) => r.research).map((r) => [r.store, r.research]));
  store.set('ss.lastApp', String(id));
  fillForm(d.app);
  $('appPicker').value = String(id);
  const stores = [...new Set(d.results.map((r) => r.store))];
  if (!stores.includes(state.store)) state.store = stores[0] ?? 'ios';
  if (!d.results.some((r) => r.store === state.store && r.locale === state.locale)) state.locale = 'en-US';
  $('empty').hidden = true; $('progress').hidden = true; $('intro').hidden = true; $('result').hidden = false;
  document.querySelector('.layout').classList.add('has-result');
  document.querySelector('.layout').classList.remove('editing');
  $('editToggle').setAttribute('aria-expanded', 'false');
  $('editSummary').textContent = `${d.app.name} · ${[...new Set(d.results.map((r) => r.locale))].length} languages`;
  render();
  renderVersions();
  loadRanks();
}

function fillForm(a) {
  const f = $('form');
  const el = f.elements;
  $('appId').value = a.id;
  el.name.value = a.name; el.pitch.value = a.pitch; el.details.value = a.details;
  el.category.value = a.category; el.audience.value = a.audience; el.seed_terms.value = (a.seed_terms ?? []).join(', ');
  const locs = new Set(state.results.map((r) => r.locale));
  for (const b of f.querySelectorAll('input[name=locales]')) b.checked = locs.has(b.value);
  const st = new Set(state.results.map((r) => r.store));
  for (const b of f.querySelectorAll('input[name=stores]')) b.checked = !st.size || st.has(b.value);
  limitLocales();
}

const current = () => state.results.find((r) => r.store === state.store && r.locale === state.locale);

function render() {
  const a = state.app;
  const v = state.versions.find((x) => x.version === state.version);
  $('resultTitle').textContent = a.name;
  $('resultMeta').textContent = `Version ${state.version} · ${v ? new Date(v.time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''} · ${v?.model ?? ''}`;

  const stores = [...new Set(state.results.map((r) => r.store))];
  $('storeTabs').innerHTML = stores.map((s) => {
    const errs = state.results.filter((r) => r.store === s).flatMap((r) => r.issues).filter((i) => i.level === 'error').length;
    return `<button role="tab" data-store="${s}" aria-selected="${s === state.store}">${CFG.stores[s].label}<span class="n ${errs ? 'bad' : ''}">${errs ? `${errs} to fix` : state.results.filter((r) => r.store === s).length + ' lang'}</span></button>`;
  }).join('');
  const locales = state.results.filter((r) => r.store === state.store).map((r) => r.locale);
  $('localeTabs').innerHTML = locales.map((l) => `<button data-locale="${l}" aria-pressed="${l === state.locale}">${esc(CFG.locales[l] ?? l)}</button>`).join('');
  renderFields();
  renderPreview();
  renderResearch();
}
$('storeTabs').onclick = (e) => { const b = e.target.closest('[data-store]'); if (!b) return; state.store = b.dataset.store; if (!current()) state.locale = 'en-US'; render(); };
$('localeTabs').onclick = (e) => { const b = e.target.closest('[data-locale]'); if (!b) return; state.locale = b.dataset.locale; render(); };

// ---------- fields ----------
const segLen = (s) => [...new Intl.Segmenter().segment(s)].length;
const byteLen = (s) => new TextEncoder().encode(s).length;
const measure = (s, spec) => (spec.bytes ? byteLen(s) : segLen(s));

function renderFields() {
  const r = current(); if (!r) { $('fields').innerHTML = ''; return; }
  const spec = CFG.stores[state.store].fields;
  $('fields').innerHTML = Object.entries(spec).map(([k, s]) => `
    <div class="fcard ${s.max > 1000 ? 'big' : ''} ${k === 'keywords' ? 'kw' : ''}" data-field="${k}">
      <div class="fcard-head"><h4>${s.label}</h4><span class="count"></span><button class="copy" type="button" data-copy="${k}">Copy</button></div>
      <div class="meter"><i></i></div>
      <textarea rows="1" spellcheck="${k !== 'keywords'}" ${k === 'keywords' ? 'wrap="off"' : ''} aria-label="${s.label}">${esc(r.fields[k])}</textarea>
      ${k === 'keywords' ? '<div class="kw-chips"></div>' : ''}
      <div class="issues">${r.issues.filter((i) => i.field === k).map((i) => `<div class="issue ${i.level}">${esc(i.text)}</div>`).join('')}</div>
    </div>`).join('');
  for (const card of $('fields').querySelectorAll('.fcard')) updateCard(card);
  $('saveRow').hidden = !state.dirty.size;
}

function updateCard(card) {
  const k = card.dataset.field;
  const s = CFG.stores[state.store].fields[k];
  const ta = card.querySelector('textarea');
  const n = measure(ta.value, s);
  const cls = n > s.max ? 'over' : n > s.max * 0.9 && s.max < 1000 ? 'near' : 'ok';
  const c = card.querySelector('.count');
  c.textContent = `${n}/${s.max}${s.bytes ? ' bytes' : ''}`; c.className = `count ${cls}`;
  const bar = card.querySelector('.meter i');
  bar.style.width = `${Math.min(100, (n / s.max) * 100)}%`; bar.className = cls;
  ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + (k === 'keywords' ? 8 : 0)}px`;
  if (k === 'keywords') card.querySelector('.kw-chips').innerHTML = ta.value.split(',').filter((t) => t.trim()).map((t) => `<span>${esc(t.trim())}</span>`).join('');
}

let lintTimer;
$('fields').addEventListener('input', (e) => {
  const card = e.target.closest('.fcard'); if (!card) return;
  const r = current();
  r.fields[card.dataset.field] = e.target.value;
  state.dirty.add(`${r.store}|${r.locale}`);
  updateCard(card);
  renderPreview();
  $('saveRow').hidden = false;
  clearTimeout(lintTimer);
  lintTimer = setTimeout(async () => {
    const { issues } = await fetch('/api/lint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store: r.store, fields: r.fields, appName: state.app.name }) }).then((x) => x.json());
    r.issues = issues;
    for (const c of $('fields').querySelectorAll('.fcard')) {
      c.querySelector('.issues').innerHTML = issues.filter((i) => i.field === c.dataset.field).map((i) => `<div class="issue ${i.level}">${esc(i.text)}</div>`).join('');
    }
  }, 350);
});
$('fields').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  await navigator.clipboard.writeText(current().fields[b.dataset.copy]);
  b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200);
});

$('saveBtn').onclick = async () => {
  const results = state.results.filter((r) => state.dirty.has(`${r.store}|${r.locale}`));
  const res = await api(`/api/apps/${state.app.id}/versions`, { method: 'POST', body: JSON.stringify({ results: state.results }) });
  if (!res.ok) return toast('Could not save');
  const { version } = await res.json();
  toast(`Saved ${results.length} edited listing${results.length === 1 ? '' : 's'} as version ${version}`);
  openApp(state.app.id, version);
};

// ---------- preview ----------
function renderPreview() {
  const r = current(); if (!r) return;
  const f = r.fields;
  const ios = r.store === 'ios';
  const shots = state.shots.length ? state.shots.map((s) => `<img src="${s.url}" alt="">`).join('') : '<div class="shots-hint">Add screenshots in the form to see them here</div>';
  $('preview').className = `store-preview ${ios ? 'ios' : 'android'}`;
  $('preview').innerHTML = `
    <div class="sp-store">${ios ? 'App Store preview' : 'Google Play preview'}</div>
    <div class="sp-head">
      <div class="sp-icon">${esc(state.app.name.slice(0, 1).toUpperCase())}</div>
      <div><div class="sp-name">${esc(ios ? f.name : f.title)}</div>
        <div class="sp-sub">${esc(ios ? f.subtitle : state.app.category || 'App')}</div>
        <span class="sp-get">${ios ? 'GET' : 'Install'}</span></div>
    </div>
    <div class="sp-shots">${shots}</div>
    ${ios ? `<div class="sp-promo">${esc(f.promotional_text)}</div>` : `<div class="sp-promo"><b>About this app</b><br>${esc(f.short_description)}</div>`}
    <div class="sp-desc" id="spDesc">${esc(ios ? f.description : f.full_description)}</div>
    <button class="sp-more" type="button" id="spMore">more</button>`;
  $('spMore').onclick = () => { const d = $('spDesc'); d.classList.toggle('open'); $('spMore').textContent = d.classList.contains('open') ? 'less' : 'more'; };
}

// ---------- research ----------
function renderResearch() {
  const rs = state.research[state.store];
  const card = $('researchCard');
  if (!rs?.competitors?.length) {
    card.hidden = !state.results.length;
    $('researchSub').textContent = CFG.serp ? 'No competitor research saved with this version.' : 'Competitor research needs a SerpApi key on the server.';
    $('vocab').innerHTML = ''; $('competitors').innerHTML = '';
    return;
  }
  card.hidden = false;
  const text = Object.values(current()?.fields ?? {}).join(' ').toLowerCase();
  const used = rs.common.filter((t) => text.includes(t.term)).length;
  $('researchSub').textContent = `Top ${CFG.stores[state.store].label} results for “${rs.terms.join('”, “')}”. Green words are the category's search vocabulary that made it into your listing (${used} of ${rs.common.length}).`;
  $('vocab').innerHTML = rs.common.map((t) => `<span class="${text.includes(t.term) ? 'used' : ''}" title="Used by ${t.apps} of these apps">${esc(t.term)}<small>${t.apps}</small></span>`).join('');
  $('competitors').innerHTML = rs.competitors.map((c) => `<li>${c.icon ? `<img src="${esc(c.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="noicon"></div>'}
    <div style="min-width:0"><b>${esc(c.title)}</b><small>${esc(c.developer || '')}${c.rating ? ` · ★ ${Number(c.rating).toFixed(1)}` : ''}</small></div></li>`).join('');
}

// ---------- versions ----------
function renderVersions() {
  $('versions').innerHTML = state.versions.map((v) => `<li><button type="button" data-v="${v.version}" aria-current="${v.version === state.version}">
    <span>Version ${v.version} <small>· ${v.model === 'edited by hand' ? 'your edits' : `${v.locales.length} language${v.locales.length === 1 ? '' : 's'}`}</small></span>
    <small>${new Date(v.time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small></button></li>`).join('');
}
$('versions').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) openApp(state.app.id, Number(b.dataset.v)); };

// ---------- ranks ----------
$('rankForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!state.app) return;
  const terms = $('rankTerms').value.split(',').map((t) => t.trim()).filter(Boolean);
  if (!terms.length) return toast('Add a search term or two');
  const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const res = await api(`/api/apps/${state.app.id}/ranks`, { method: 'POST', body: JSON.stringify({ store: $('rankStore').value, terms }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    const label = CFG.stores[$('rankStore').value].label;
    toast(d.map((x) => `“${x.term}”: ${x.rank ? `#${x.rank}` : `not in the top 15`} on ${label}`).join(' · '));
    await loadRanks();
  } catch (err) { toast(err.message); } finally { btn.disabled = false; btn.textContent = 'Check now'; }
};

const SERIES = ['#3f5bd8', '#0c8a5f', '#c2412d', '#b7791f', '#8a4fd8'];
async function loadRanks() {
  const rows = await api(`/api/apps/${state.app.id}/ranks`).then((r) => r.json());
  const el = $('rankChart');
  if (!rows.length) { el.innerHTML = '<p class="rank-empty">No checks yet.</p>'; return; }
  const key = (r) => `${r.store === 'ios' ? 'App Store' : 'Play'} · ${r.term}`;
  const series = [...new Set(rows.map(key))].slice(0, 5);
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const W = 520, H = 200, padL = 34, padB = 22, padT = 10, padR = 10;
  const worst = 16; // "not in the top 15" sits on the floor
  const x = (d) => padL + (days.length === 1 ? (W - padL - padR) / 2 : (days.indexOf(d) / (days.length - 1)) * (W - padL - padR));
  const y = (rank) => padT + ((Math.min(rank ?? worst, worst) - 1) / (worst - 1)) * (H - padT - padB);
  const ticks = [1, 5, 10, 15];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rank over time, lower is better">
    <g class="grid">${ticks.map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/>`).join('')}</g>
    <g class="axis">${ticks.map((t) => `<text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">#${t}</text>`).join('')}
      ${days.map((d, i) => (i === 0 || i === days.length - 1 ? `<text x="${x(d)}" y="${H - 4}" text-anchor="middle">${new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' })}</text>` : '')).join('')}</g>
    ${series.map((s, si) => {
      const pts = rows.filter((r) => key(r) === s).map((r) => [x(r.day), y(r.rank), r]);
      return `<path class="line" stroke="${SERIES[si]}" d="${pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px},${py}`).join(' ')}"/>
        ${pts.map(([px, py, r]) => `<circle cx="${px}" cy="${py}" r="4.5" fill="${SERIES[si]}" stroke="var(--panel)" stroke-width="2"><title>${esc(s)}: ${r.rank ? `#${r.rank}` : 'not in top 15'}</title></circle>`).join('')}`;
    }).join('')}
  </svg>
  <div class="rank-legend">${series.map((s, i) => {
    const last = rows.filter((r) => key(r) === s).at(-1);
    return `<span><i style="background:${SERIES[i]}"></i>${esc(s)} <b>${last.rank ? `#${last.rank}` : '–'}</b></span>`;
  }).join('')}</div>`;
}

// ---------- export ----------
// fastlane's deliver (App Store) and supply (Google Play) read one .txt per field per locale.
const IOS_DIR = { 'en-US': 'en-US', 'es-ES': 'es-ES', 'es-MX': 'es-MX', 'fr-FR': 'fr-FR', 'de-DE': 'de-DE', 'it-IT': 'it', 'pt-BR': 'pt-BR', 'ja-JP': 'ja', 'ko-KR': 'ko', 'zh-Hans': 'zh-Hans', 'hi-IN': 'hi', 'id-ID': 'id', 'tr-TR': 'tr', 'nl-NL': 'nl-NL' };
const PLAY_DIR = { 'en-US': 'en-US', 'es-ES': 'es-ES', 'es-MX': 'es-419', 'fr-FR': 'fr-FR', 'de-DE': 'de-DE', 'it-IT': 'it-IT', 'pt-BR': 'pt-BR', 'ja-JP': 'ja-JP', 'ko-KR': 'ko-KR', 'zh-Hans': 'zh-CN', 'hi-IN': 'hi-IN', 'id-ID': 'id', 'tr-TR': 'tr-TR', 'nl-NL': 'nl-NL' };
$('exportBtn').onclick = async () => {
  if (!window.JSZip) return toast('Export is still loading, try again in a second');
  const zip = new window.JSZip();
  for (const r of state.results) {
    const dir = r.store === 'ios' ? `fastlane/metadata/${IOS_DIR[r.locale]}` : `fastlane/metadata/android/${PLAY_DIR[r.locale]}`;
    for (const [k, v] of Object.entries(r.fields)) zip.file(`${dir}/${k}.txt`, v);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-v${state.version}-metadata.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Unzip into your project and run fastlane deliver / supply');
};
$('copyAllBtn').onclick = async () => {
  const r = current(); const spec = CFG.stores[r.store].fields;
  await navigator.clipboard.writeText(Object.entries(spec).map(([k, s]) => `${s.label}\n${r.fields[k]}`).join('\n\n'));
  toast(`Copied the ${CFG.locales[r.locale]} ${CFG.stores[r.store].label} listing`);
};

boot();

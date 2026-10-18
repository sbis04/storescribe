// Reads an app's repo and pulls out what a listing writer needs: name, description, ids, screens, current listing, screenshots.
// Works for Flutter, React Native / Expo, native iOS and native Android projects. Nothing here calls a model.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const read = (p) => readFile(p, 'utf8').catch(() => null);
const SKIP = new Set(['node_modules', '.git', 'build', 'Pods', '.dart_tool', '.gradle', 'DerivedData', '.expo', 'dist', '.next', 'vendor', '.idea']);

async function walk(dir, depth = 0, out = []) {
  if (depth > 6 || out.length > 4000) return out;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, depth + 1, out); else out.push(p);
  }
  return out;
}

const first = (s, re) => s?.match(re)?.[1]?.trim();

export async function scanRepo(root) {
  const files = await walk(root);
  const rel = (p) => path.relative(root, p);
  const find = (re) => files.filter((f) => re.test(rel(f)));
  const ctx = { root, kind: [], name: null, description: null, iosId: null, androidId: null, screens: [], readme: '', current: {}, screenshots: [], sources: [] };
  const note = (p) => ctx.sources.push(rel(p));

  // Flutter
  const pubspec = path.join(root, 'pubspec.yaml');
  const ps = await read(pubspec);
  if (ps) {
    ctx.kind.push('Flutter'); note(pubspec);
    ctx.description = first(ps, /^description:\s*["']?(.+?)["']?\s*$/m);
    if (/^a new flutter (project|application)/i.test(ctx.description ?? '')) ctx.description = null;
    ctx.packageName = first(ps, /^name:\s*(\S+)/m);
  }
  // Expo / React Native
  for (const f of ['app.json', 'app.config.json']) {
    const j = await read(path.join(root, f));
    if (!j) continue;
    try {
      const a = JSON.parse(j).expo ?? JSON.parse(j);
      ctx.kind.push('Expo'); note(path.join(root, f));
      ctx.name ??= a.name; ctx.description ??= a.description;
      ctx.iosId ??= a.ios?.bundleIdentifier; ctx.androidId ??= a.android?.package;
    } catch { /* not JSON we understand */ }
  }
  const pkg = await read(path.join(root, 'package.json'));
  if (pkg) {
    try {
      const p = JSON.parse(pkg);
      if (p.dependencies?.['react-native']) ctx.kind.push('React Native');
      ctx.description ??= p.description;
      ctx.packageName ??= p.name;
    } catch { /* ignore */ }
  }
  // iOS: display name and bundle id
  for (const f of find(/Info\.plist$/).filter((f) => !/Tests|Pods|\.framework/.test(f)).slice(0, 3)) {
    const s = await read(f);
    const n = first(s, /<key>CFBundleDisplayName<\/key>\s*<string>([^<$]+)<\/string>/);
    if (n) { ctx.name ??= n; note(f); }
  }
  // The app's own bundle id is the shortest one that isn't a test, widget, watch or extension target.
  for (const f of find(/project\.pbxproj$/).slice(0, 2)) {
    const ids = [...(await read(f) ?? '').matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([\w.-]+)"?;/g)].map((m) => m[1])
      .filter((id) => !/tests?$|uitests|watch|widget|extension|intent|notification|clip|\$\(/i.test(id))
      .sort((a, b) => a.length - b.length);
    if (ids[0]) { ctx.iosId ??= ids[0]; ctx.kind.includes('iOS') || ctx.kind.push('iOS'); }
  }
  // Android: label and application id
  for (const f of find(/(^|\/)res\/values\/strings\.xml$/).slice(0, 3)) {
    const n = first(await read(f), /<string name="app_name">([^<]+)<\/string>/);
    if (n) { ctx.name ??= n; note(f); }
  }
  for (const f of find(/AndroidManifest\.xml$/).filter((f) => /main/.test(f)).slice(0, 2)) {
    const n = first(await read(f), /android:label="([^"@]+)"/);
    if (n) { ctx.name ??= n; note(f); }
  }
  for (const f of find(/app\/build\.gradle(\.kts)?$/).slice(0, 1)) {
    const id = first(await read(f), /applicationId\s*=?\s*["']([\w.]+)["']/);
    if (id) { ctx.androidId ??= id; ctx.kind.includes('Android') || ctx.kind.push('Android'); }
  }
  ctx.name ??= ctx.packageName?.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) ?? path.basename(root);

  // Screens and pages, by file and class name: a cheap map of what the app does.
  const screenRe = /(screen|page|view|tab|sheet)s?\.(dart|tsx?|jsx?|swift|kt)$/i;
  ctx.screens = [...new Set(files.filter((f) => screenRe.test(f) && !/test|spec|mock|generated|\.g\./i.test(f))
    .map((f) => path.basename(f).replace(/\.(dart|tsx?|jsx?|swift|kt)$/, '').replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/\b(screen|page|view|widget)\b/g, '').trim())
    .filter((n) => n && n.length < 40))].slice(0, 40);
  // Feature folders (lib/features/flight_radar, src/features/billing, ...) name whole areas of the app.
  ctx.features = [...new Set(files.map((f) => rel(f).match(/(?:^|\/)(?:features|modules)\/([^/]+)\//)?.[1]).filter(Boolean)
    .map((n) => n.replace(/[_-]+/g, ' ')))].slice(0, 20);

  // README: the developer's own words about the app, minus badges, code and build instructions.
  const readme = files.find((f) => /^readme\.md$/i.test(rel(f)));
  if (readme) {
    note(readme);
    ctx.readme = (await read(readme))
      .replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<[^>]+>/g, '')
      .split(/\n(?=#+\s*(getting started|install|setup|build|development|contributing|license|running)\b)/i)[0]
      .replace(/^.*a new flutter (project|application)\.?$/gim, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 5000);
    if (ctx.readme.replace(/^#.*$/gm, '').trim().length < 40) ctx.readme = ''; // only a title left: a template README
  }

  // The listing that's live today, if the project already uses fastlane.
  const meta = path.join(root, 'fastlane', 'metadata');
  for (const [field, file] of [['description', 'en-US/description.txt'], ['name', 'en-US/name.txt'], ['subtitle', 'en-US/subtitle.txt'], ['keywords', 'en-US/keywords.txt'], ['full_description', 'android/en-US/full_description.txt'], ['short_description', 'android/en-US/short_description.txt']]) {
    const s = await read(path.join(meta, file));
    if (s?.trim()) ctx.current[field] = s.trim().slice(0, 3000);
  }

  // Screenshots: fastlane's folders first, then anything that looks like one. Biggest files first (real screens, not icons).
  const shotRe = /\.(png|jpe?g)$/i;
  const candidates = [
    ...find(/fastlane\/screenshots\/(en-US\/)?/i).filter((f) => shotRe.test(f)),
    ...find(/(^|\/)(screenshots?|store|assets\/store|docs\/(img|images|screenshots))\//i).filter((f) => shotRe.test(f)),
    // Marketing sites and onboarding art in the repo show the app too.
    ...find(/(^|\/)(website|site|web|landing|docs)\/.*(hero|screen|shot|preview|mock)[^/]*\.(png|jpe?g)$/i),
    ...find(/(onboarding|walkthrough)[^/]*\.(png|jpe?g)$/i).filter((f) => !/icon/i.test(f)),
  ];
  // Portrait, phone-shaped images first (real screens), then by size.
  const sharp = (await import('sharp')).default;
  const sized = await Promise.all([...new Set(candidates)].map(async (f) => {
    const m = await sharp(f).metadata().catch(() => ({}));
    return { f, size: (await stat(f)).size, tall: (m.height ?? 0) / (m.width ?? 1) > 1.6 };
  }));
  ctx.screenshots = sized.filter((x) => x.size > 30_000).sort((a, b) => (b.tall - a.tall) || (b.size - a.size)).slice(0, 5).map((x) => x.f);
  return ctx;
}

// Turns the scan into the plain-text brief the model reads.
export function contextText(ctx) {
  return [
    `Project type: ${ctx.kind.join(', ') || 'unknown'}`,
    `App name in the project: ${ctx.name}`,
    ctx.description && `Description in the project: ${ctx.description}`,
    ctx.features?.length && `Feature folders in the code: ${ctx.features.join(', ')}`,
    ctx.screens.length && `Screens in the code: ${ctx.screens.join(', ')}`,
    ctx.readme && `README:\n${ctx.readme}`,
    Object.keys(ctx.current).length && `Current store listing:\n${Object.entries(ctx.current).map(([k, v]) => `${k}: ${v}`).join('\n')}`,
  ].filter(Boolean).join('\n\n').slice(0, 12000);
}

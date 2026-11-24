// Static checks: every JS file parses, and every file referenced by the
// manifest / HTML pages / module imports exists.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const rel = (p) => relative(root, p).replace(/\\/g, '/');

// 1. syntax
const jsFiles = walk(join(root, 'src')).filter((f) => f.endsWith('.js'));
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    errors.push(`Syntax error in ${rel(f)}:\n${e.stderr}`);
  }
}

// 2. manifest references
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const refs = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((c) => c.js),
];
for (const r of refs) if (!existsSync(join(root, r))) errors.push(`manifest references missing file: ${r}`);

// 3. HTML src/href + JS imports
for (const f of walk(join(root, 'src'))) {
  const text = readFileSync(f, 'utf8');
  const found = f.endsWith('.html')
    ? [...text.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1])
    : f.endsWith('.js')
      ? [...text.matchAll(/(?:^|\n)\s*import[^'"]*['"](\.[^'"]+)['"]/g), ...text.matchAll(/import\(['"](\.[^'"]+)['"]\)/g)].map((m) => m[1])
      : [];
  for (const r of found) if (!existsSync(join(dirname(f), r))) errors.push(`${rel(f)} references missing ${r}`);
}

// 4. service worker's injected files
const sw = readFileSync(join(root, manifest.background.service_worker), 'utf8');
for (const m of sw.matchAll(/'(src\/content\/[^']+\.js)'/g)) if (!existsSync(join(root, m[1]))) errors.push(`service worker injects missing ${m[1]}`);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`OK — ${jsFiles.length} JS files parse, ${refs.length} manifest references and all page/import references resolve.`);

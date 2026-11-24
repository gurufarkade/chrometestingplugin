// Builds dist/qa-scenario-recorder-<version>.zip for the Chrome Web Store
// (or for sharing with teammates who load it via "Load unpacked").
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../src/shared/zip.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const include = ['manifest.json', ...walk(join(root, 'src')), ...walk(join(root, 'icons'))];
const files = include.map((f) => {
  const abs = f.startsWith(root) ? f : join(root, f);
  return { name: relative(root, abs).replace(/\\/g, '/'), data: new Uint8Array(readFileSync(abs)) };
});
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', `qa-scenario-recorder-${version}.zip`);
writeFileSync(out, createZip(files));
console.log(`Wrote ${relative(root, out)} (${files.length} files)`);

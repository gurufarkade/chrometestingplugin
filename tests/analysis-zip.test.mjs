import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeUrl, apiSignature, diffApiCalls, maskHeaders, matchesAnyPattern, sameRoute } from '../src/shared/analysis.js';
import { createZip, crc32 } from '../src/shared/zip.js';

test('normalizeUrl replaces id-like segments', () => {
  assert.equal(normalizeUrl('https://a.test/api/orders/123?x=1'), 'https://a.test/api/orders/:id');
  assert.equal(normalizeUrl('https://a.test/u/3f2504e0-4f89-11d3-9a0c-0305e82c3301/profile'), 'https://a.test/u/:id/profile');
  assert.equal(normalizeUrl('https://a.test/p/65a1f0c2e4b0a1b2c3d4e5f6'), 'https://a.test/p/:id');
  assert.equal(normalizeUrl('https://a.test/api/v2/users'), 'https://a.test/api/v2/users');
  assert.equal(apiSignature({ method: 'post', url: 'https://a.test/api/orders/9' }), 'POST https://a.test/api/orders/:id');
  assert.ok(sameRoute('https://a.test/o/1?a', 'https://a.test/o/2'));
});

test('diffApiCalls finds missing, unexpected, status and latency changes', () => {
  const rec = [
    { api: 'fetch', method: 'POST', url: 'https://a.test/api/login', status: 200, duration: 100 },
    { api: 'fetch', method: 'GET', url: 'https://a.test/api/orders/1', status: 200, duration: 100 },
    { api: 'fetch', method: 'GET', url: 'https://a.test/api/cart', status: 200, duration: 100 },
    { api: 'document', method: 'GET', url: 'https://a.test/', status: 200 },
  ];
  const rep = [
    { api: 'fetch', method: 'POST', url: 'https://a.test/api/login', status: 500, duration: 90 },
    { api: 'fetch', method: 'GET', url: 'https://a.test/api/orders/2', status: 200, duration: 900 },
    { api: 'xhr', method: 'GET', url: 'https://a.test/api/new', status: 200, duration: 10 },
  ];
  const d = diffApiCalls(rec, rep);
  assert.equal(d.matched.length, 2);
  assert.deepEqual(d.statusChanged.map((x) => x.signature), ['POST https://a.test/api/login']);
  assert.deepEqual(d.missing.map((x) => x.signature), ['GET https://a.test/api/cart']);
  assert.deepEqual(d.unexpected.map((x) => x.signature), ['GET https://a.test/api/new']);
  assert.deepEqual(d.slower.map((x) => x.signature), ['GET https://a.test/api/orders/:id']);
});

test('maskHeaders and ignore patterns', () => {
  assert.deepEqual(maskHeaders({ Authorization: 'x', Accept: 'y' }, ['authorization']), { Authorization: '***MASKED***', Accept: 'y' });
  assert.deepEqual(maskHeaders({ Authorization: 'x' }, ['authorization'], false), { Authorization: 'x' });
  assert.ok(matchesAnyPattern('https://www.google-analytics.com/g/collect', ['google-analytics.com']));
  assert.ok(!matchesAnyPattern('https://a.test/api', ['google-analytics.com', '']));
});

test('crc32 known vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip is readable by the OS unzip tool', (t) => {
  const zip = createZip([
    { name: 'a.txt', data: 'hello' },
    { name: 'dir/b.json', data: '{"x":1}' },
    { name: 'bin.dat', data: new Uint8Array([0, 1, 2, 255]) },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'qazip-'));
  try {
    const file = join(dir, 'x.zip');
    writeFileSync(file, zip);
    const out = join(dir, 'out');
    try {
      if (process.platform === 'win32') {
        execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${file}' -DestinationPath '${out}'`]);
      } else {
        execFileSync('unzip', ['-q', file, '-d', out]);
      }
    } catch (e) {
      t.skip(`no unzip tool available: ${e.message}`);
      return;
    }
    assert.equal(readFileSync(join(out, 'a.txt'), 'utf8'), 'hello');
    assert.equal(readFileSync(join(out, 'dir', 'b.json'), 'utf8'), '{"x":1}');
    assert.deepEqual([...readFileSync(join(out, 'bin.dat'))], [0, 1, 2, 255]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

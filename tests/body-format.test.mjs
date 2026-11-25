import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, formatBody, highlight } from '../src/shared/body-format.js';

test('detects formats from content-type and body', () => {
  assert.equal(detectFormat('{"a":1}', 'application/json; charset=utf-8'), 'json');
  assert.equal(detectFormat('[1,2]', ''), 'json');
  assert.equal(detectFormat('{"a":1}', { 'Content-Type': 'application/vnd.api+json' }), 'json');
  assert.equal(detectFormat('<a><b>1</b></a>', 'text/xml'), 'xml');
  assert.equal(detectFormat('<?xml version="1.0"?><a/>', ''), 'xml');
  assert.equal(detectFormat('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body/></soap:Envelope>', 'text/xml'), 'soap');
  assert.equal(detectFormat('<!doctype html><html></html>', ''), 'html');
  assert.equal(detectFormat('user=ada&pass=x%20y', 'application/x-www-form-urlencoded'), 'form');
  assert.equal(detectFormat('{"query":"query Me { me { id } }","variables":{}}', 'application/json'), 'graphql');
  assert.equal(detectFormat('hello world', 'text/plain'), 'text');
});

test('pretty-prints JSON and flags invalid JSON', () => {
  assert.equal(formatBody('{"a":{"b":[1,2]}}', 'application/json').text, '{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}');
  const bad = formatBody('{"a":', 'application/json');
  assert.equal(bad.ok, false);
  assert.equal(bad.text, '{"a":');
  assert.match(bad.label, /invalid/);
});

test('indents XML, keeping text-only elements on one line', () => {
  const r = formatBody('<?xml version="1.0"?><order id="7"><item>Pen</item><qty>2</qty><note/></order>', 'application/xml');
  assert.equal(r.label, 'XML');
  assert.equal(r.text, '<?xml version="1.0"?>\n<order id="7">\n  <item>Pen</item>\n  <qty>2</qty>\n  <note/>\n</order>');
});

test('formats SOAP envelopes and form bodies', () => {
  const s = formatBody('<s:Envelope xmlns:s="x"><s:Body><Add><a>1</a></Add></s:Body></s:Envelope>', 'text/xml; charset=utf-8');
  assert.equal(s.format, 'soap');
  assert.equal(s.text.split('\n').length, 7);
  assert.equal(formatBody('q=red+shoes&page=2', 'application/x-www-form-urlencoded').text, 'q = red shoes\npage = 2');
});

test('GraphQL shows the query and variables', () => {
  const r = formatBody(JSON.stringify({ operationName: 'Me', query: 'query Me { me { id } }', variables: { x: 1 } }), 'application/json');
  assert.match(r.text, /^# operation: Me\nquery Me/);
  assert.match(r.text, /# variables\n\{\n {2}"x": 1\n\}/);
});

test('highlight tokens re-join to the original text', () => {
  for (const [body, ct] of [['{"a":true,"b":"x","n":-1.5e3}', 'application/json'], ['<a href="1"><!-- c --><b>t</b></a>', 'text/xml'], ['a=1&b=2', 'application/x-www-form-urlencoded']]) {
    const f = formatBody(body, ct);
    const toks = highlight(f.text, f.format);
    assert.equal(toks.map((t) => t[1]).join(''), f.text);
    assert.ok(toks.some((t) => t[0]));
  }
  assert.deepEqual(highlight('{"k": 1}', 'json').filter((t) => t[0]).map((t) => t[0]), ['tk-punc', 'tk-key', 'tk-num', 'tk-punc']);
});

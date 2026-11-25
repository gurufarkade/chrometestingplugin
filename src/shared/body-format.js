// Body format module — detect what an API body is and pretty-print it in that
// format. Pure (no DOM), so it runs in the dashboard and in Node tests.
//
// Interface:
//   detectFormat(body, contentType) -> 'json' | 'graphql' | 'soap' | 'xml' | 'html' | 'form' | 'text'
//   formatBody(body, contentType)   -> { format, label, text, ok }   (ok=false: shown raw, could not parse)
//   highlight(text, format)         -> [[className|null, text], ...] tokens for syntax colouring

const ctOf = (headersOrCt) => {
  if (!headersOrCt) return '';
  if (typeof headersOrCt === 'string') return headersOrCt.toLowerCase();
  const k = Object.keys(headersOrCt).find((x) => x.toLowerCase() === 'content-type');
  return k ? String(headersOrCt[k]).toLowerCase() : '';
};

const LABELS = { json: 'JSON', graphql: 'GraphQL', soap: 'SOAP XML', xml: 'XML', html: 'HTML', form: 'Form data', text: 'Text' };

function tryJson(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

export function detectFormat(body, contentType) {
  const s = String(body ?? '').trim();
  const ct = ctOf(contentType);
  const looksXml = /^<(\?xml|[A-Za-z_][\w.:-]*[\s>/])/.test(s);
  const isSoap = /<([\w-]+:)?Envelope[\s>]/.test(s) && /soap|envelope/i.test(s);
  if (/graphql/.test(ct)) return 'graphql';
  if (/json/.test(ct) || ((s.startsWith('{') || s.startsWith('[')) && tryJson(s).ok)) {
    const j = tryJson(s);
    if (j.ok && j.value && typeof j.value === 'object' && !Array.isArray(j.value) && typeof j.value.query === 'string' && /^\s*(query|mutation|subscription|\{)/.test(j.value.query)) return 'graphql';
    return 'json';
  }
  if (/soap/.test(ct) || isSoap) return 'soap';
  if (/html/.test(ct) || /^<!doctype html|^<html[\s>]/i.test(s)) return 'html';
  if (/xml/.test(ct) || looksXml) return 'xml';
  if (/x-www-form-urlencoded/.test(ct) || (/^[\w.%[\]-]+=[^&\s]*(&[\w.%[\]-]+=[^&\s]*)*$/.test(s) && s.includes('='))) return 'form';
  return 'text';
}

// ------------------------------------------------------------------ XML

/** Indent XML/HTML by tags. Keeps text-only elements on one line: <a>text</a>. */
export function formatXml(src, indent = '  ') {
  const s = String(src).trim();
  const tokens = s.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<[^>]+>|[^<]+/g);
  if (!tokens) return s;
  const out = [];
  let depth = 0;
  const VOID = /^<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)[\s>/]/i;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('<')) {
      const text = t.trim();
      if (text) out.push(indent.repeat(depth) + text);
      continue;
    }
    if (t.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      out.push(indent.repeat(depth) + t);
      continue;
    }
    const selfClosing = t.endsWith('/>') || /^<[?!]/.test(t) || VOID.test(t);
    // <tag>text</tag> → one line
    const next = tokens[i + 1];
    const after = tokens[i + 2];
    if (!selfClosing && next && !next.startsWith('<') && after?.startsWith('</') && next.trim().length <= 120 && !next.includes('\n')) {
      out.push(indent.repeat(depth) + t + next.trim() + after);
      i += 2;
      continue;
    }
    if (!selfClosing && next?.startsWith('</')) {
      out.push(indent.repeat(depth) + t + next);
      i += 1;
      continue;
    }
    out.push(indent.repeat(depth) + t);
    if (!selfClosing) depth++;
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ format

function formatForm(s) {
  const lines = [];
  for (const pair of s.split('&')) {
    if (!pair) continue;
    const [k, ...v] = pair.split('=');
    const dec = (x) => {
      try {
        return decodeURIComponent(x.replace(/\+/g, ' '));
      } catch {
        return x;
      }
    };
    lines.push(`${dec(k)} = ${dec(v.join('='))}`);
  }
  return lines.join('\n');
}

function formatGraphql(s) {
  const j = tryJson(s);
  if (!j.ok) return { text: s, ok: true }; // raw application/graphql body
  const { query, variables, operationName, ...rest } = j.value;
  if (typeof query !== 'string') return { text: JSON.stringify(j.value, null, 2), ok: true };
  const parts = [];
  if (operationName) parts.push(`# operation: ${operationName}`);
  parts.push(query.trim());
  if (variables && Object.keys(variables).length) parts.push(`\n# variables\n${JSON.stringify(variables, null, 2)}`);
  if (Object.keys(rest).length) parts.push(`\n# extra\n${JSON.stringify(rest, null, 2)}`);
  return { text: parts.join('\n'), ok: true };
}

export function formatBody(body, contentType) {
  if (body == null || body === '') return { format: 'text', label: LABELS.text, text: '', ok: true };
  const raw = String(body);
  const format = detectFormat(raw, contentType);
  let text = raw;
  let ok = true;
  try {
    if (format === 'json') {
      const j = tryJson(raw.trim());
      ok = j.ok;
      if (ok) text = JSON.stringify(j.value, null, 2);
    } else if (format === 'graphql') ({ text, ok } = formatGraphql(raw.trim()));
    else if (format === 'xml' || format === 'soap' || format === 'html') text = formatXml(raw);
    else if (format === 'form') text = formatForm(raw.trim());
  } catch {
    text = raw;
    ok = false;
  }
  return { format, label: LABELS[format] + (ok ? '' : ' (invalid — shown raw)'), text, ok };
}

// ------------------------------------------------------------------ highlight

const JSON_RE = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;
const XML_RE = /(<!--[\s\S]*?-->)|(<!\[CDATA\[[\s\S]*?\]\]>)|(<\/?[\w.:-]+|\/?>|<\?[\w-]+|\?>)|([\w.:-]+)(=)("[^"]*"|'[^']*')/g;

function tokenize(text, re, classify) {
  const out = [];
  let last = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push([null, text.slice(last, m.index)]);
    out.push(...classify(m));
    last = re.lastIndex;
  }
  if (last < text.length) out.push([null, text.slice(last)]);
  return out;
}

export function highlight(text, format) {
  if (!text) return [];
  if (text.length > 200000) return [[null, text]]; // keep the dashboard responsive on huge bodies
  if (format === 'json') {
    return tokenize(text, JSON_RE, (m) => {
      if (m[1]) return m[2] ? [['tk-key', m[1]], [null, m[2]]] : [['tk-str', m[1]]];
      if (m[3]) return [['tk-lit', m[3]]];
      if (m[4]) return [['tk-num', m[4]]];
      return [['tk-punc', m[5]]];
    });
  }
  if (format === 'xml' || format === 'soap' || format === 'html') {
    // only colour markup, not text inside tags' content
    return tokenize(text, XML_RE, (m) => {
      if (m[1]) return [['tk-comment', m[1]]];
      if (m[2]) return [['tk-str', m[2]]];
      if (m[3]) return [['tk-tag', m[3]]];
      return [['tk-key', m[4]], ['tk-punc', m[5]], ['tk-str', m[6]]];
    });
  }
  if (format === 'form') {
    return text.split(/(\n)/).flatMap((line) => {
      const i = line.indexOf(' = ');
      return i < 0 ? [[null, line]] : [['tk-key', line.slice(0, i)], ['tk-punc', ' = '], ['tk-str', line.slice(i + 3)]];
    });
  }
  return [[null, text]];
}

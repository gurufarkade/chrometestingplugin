// Test data module — knows what each typed/chosen value in a Scenario *is*,
// whether a Run should reuse it or get a fresh one, and how to make fresh,
// realistic, constraint-respecting values.
//
// Interface (see tests/test-data.test.mjs):
//   buildDataPlan(steps, { now })            -> { intent, needsDecision, fields[] }
//   resolveData(plan, choices, { rng, now }) -> { values: { [stepId]: string }, fields[] }
//       choices = { mode: 'recommended'|'recorded'|'fresh', strategies?: {key: strategy}, custom?: {key: value} }
//   applyData(steps, resolved)               -> new steps with values (and dependent assertions) substituted
//   generatorSource(field) / dataHelpersSource() -> JS source used by exported Playwright/Cypress specs
//   createRng(seed)                          -> deterministic random source
//
// Pure: no browser APIs.

// ------------------------------------------------------------------ randomness

export function createRng(seed = Math.floor(Math.random() * 2 ** 31)) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => Math.floor(next() * (max - min + 1)) + min;
  const pick = (arr) => arr[int(0, arr.length - 1)];
  const token = (n, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') => Array.from({ length: n }, () => alphabet[int(0, alphabet.length - 1)]).join('');
  return { next, int, pick, token };
}

const FIRST = ['Olivia', 'Liam', 'Emma', 'Noah', 'Aisha', 'Omar', 'Priya', 'Arjun', 'Sofia', 'Mateo', 'Hana', 'Yusuf', 'Chloe', 'Ethan', 'Fatima', 'Lucas', 'Maya', 'Ravi', 'Elena', 'Daniel'];
const LAST = ['Smith', 'Johnson', 'Khan', 'Patel', 'Garcia', 'Nguyen', 'Ahmed', 'Fernandes', 'Kowalski', 'Tanaka', 'Silva', 'Rossi', 'Haddad', 'Dubois', 'Novak', 'Brown'];
const COMPANIES = ['Northwind Traders', 'Contoso Ltd', 'Fabrikam Inc', 'Globex Labs', 'Initech Systems', 'Umbrella Logistics', 'Acorn Analytics', 'Bluewave Retail'];
const STREETS = ['Maple Avenue', 'Harbour Road', 'King Street', 'Palm Boulevard', 'Station Lane', 'Garden Close', 'Hillview Drive', 'Market Square'];
const CITIES = ['Dubai', 'London', 'Pune', 'Toronto', 'Sydney', 'Berlin', 'Austin', 'Singapore', 'Lisbon', 'Nairobi'];
const STATES = ['California', 'Ontario', 'Maharashtra', 'Bavaria', 'Victoria', 'Texas', 'Dubai', 'Queensland'];
const WORDS = ['quick', 'sample', 'review', 'update', 'priority', 'demo', 'client', 'project', 'invoice', 'request', 'monthly', 'summary', 'feedback', 'regional', 'service', 'order'];

// ------------------------------------------------------------------ field recognition

const AUTOCOMPLETE_KIND = {
  email: 'email', username: 'username', 'current-password': 'password', 'new-password': 'password', 'one-time-code': 'otp',
  'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName', 'cc-name': 'fullName', tel: 'phone', 'tel-national': 'phone',
  organization: 'company', 'street-address': 'street', 'address-line1': 'street', 'address-line2': 'street', 'address-level2': 'city',
  'address-level1': 'state', 'postal-code': 'postalCode', country: 'country', 'country-name': 'country', url: 'url', bday: 'dob',
  'cc-number': 'cardNumber', 'cc-csc': 'cvv', 'cc-exp': 'expiry',
};

// Ordered: first match wins.
const KEYWORD_KIND = [
  ['cvv', /\b(cvv|cvc|csc)\b|card (security|verification) code/],
  ['otp', /\b(otp|one.?time|verification code|2fa|mfa|auth(entication)? code|security code|passcode)\b/],
  ['password', /pass(word)?\b|\bpwd\b|password/],
  ['cardNumber', /card.?(number|no)|cc.?num/],
  ['expiry', /expir|exp.?date|mm.?\/?.?yy/],
  ['email', /e-?mail/],
  ['username', /user.?name|login.?id|user.?id|\bhandle\b/],
  ['firstName', /first.?name|given.?name|\bfname\b|forename/],
  ['lastName', /last.?name|surname|family.?name|\blname\b/],
  ['fullName', /full.?name|^name$|your name|contact name|card.?holder|customer name/],
  ['phone', /phone|mobile|\btel\b|cell|contact number|whatsapp/],
  ['company', /company|organi[sz]ation|business name|employer/],
  ['postalCode', /\bzip\b|postal|post.?code|pin.?code/],
  ['street', /address|street|\baddr\b/],
  ['city', /\bcity\b|\btown\b/],
  ['state', /\bstate\b|province|\bregion\b|county/],
  ['country', /country/],
  ['dob', /birth|\bdob\b/],
  ['date', /date|\bday\b/],
  ['amount', /amount|price|salary|cost|total|budget|\bfee\b/],
  ['quantity', /\bqty\b|quantity|\bunits\b|number of/],
  ['url', /website|\burl\b|\blink\b/],
  ['search', /search|query|keyword|\bfind\b|\bfilter\b/],
  ['paragraph', /comment|description|message|notes?\b|remarks|\bbio\b|about/],
  ['sentence', /title|subject|headline/],
];

const SECRET_KINDS = new Set(['password', 'otp', 'cvv', 'secret']);
const UNIQUE_KINDS = new Set(['email', 'username', 'phone']);
const FUTURE_DATE_RE = /check.?in|check.?out|start|end|from|\bto\b|departure|arrival|appointment|delivery|due|booking|travel|event|valid|expir|schedule|reserv/;

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[_-]+/g, ' ').trim();
}

function fieldLabel(t = {}) {
  return t.label || t.name || t.placeholder || t.nameAttr || t.id || t.friendly || 'Field';
}

function inferKind(step) {
  const t = step.target || {};
  if (step.action === 'select') return 'option';
  // autocomplete tokens are hyphenated ("given-name"); the last token is the field name
  const ac = String(t.autocomplete || '').toLowerCase().trim().split(/\s+/).pop();
  if (ac && AUTOCOMPLETE_KIND[ac]) return AUTOCOMPLETE_KIND[ac];
  const type = norm(t.type);
  const hay = norm([t.label, t.name, t.placeholder, t.nameAttr, t.id, t.ariaLabel].filter(Boolean).join(' | '));
  if (type === 'password') return /otp|one time|verification|code|pin/.test(hay) ? 'otp' : 'password';
  if (type === 'email') return 'email';
  if (type === 'tel') return 'phone';
  if (type === 'url') return 'url';
  if (type === 'search' || t.role === 'searchbox' || t.nameAttr === 'q') return 'search';
  if (type === 'date') return /birth|dob/.test(hay) ? 'dob' : 'date';
  if (type === 'datetime local') return 'datetime';
  if (type === 'time') return 'time';
  for (const [kind, re] of KEYWORD_KIND) if (re.test(hay)) return kind === 'date' && type === 'number' ? 'number' : kind;
  if (type === 'number' || type === 'range') return 'number';
  if (step.sensitive) return 'secret';
  if (t.tag === 'textarea') return 'paragraph';
  const v = String(step.value ?? '');
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'email';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date';
  if (/^\+?[\d\s().-]{7,}$/.test(v) && /\d{3}/.test(v)) return 'phone';
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'number';
  return 'text';
}

const INTENT_RULES = [
  ['signup', /sign.?up|register|registration|create (an |your |new )?account|join now|enrol|onboard|get started/],
  // "add" creates a record ("Add user") — but not "Add to cart / basket / wishlist"
  ['create', /\b(create|new|save)\b|\badd\b(?! to (cart|basket|bag|trolley|wish ?list|favou?rites|compare))/],
  ['checkout', /checkout|payment|pay now|place order|billing/],
  ['booking', /\bbook|reserv|appointment|schedule/],
  ['login', /log.?in|sign.?in|authenticat/],
  ['search', /search|filter/],
];
const INTENT_PRIORITY = ['signup', 'create', 'checkout', 'booking', 'login', 'search', 'form'];

function stepIntent(steps, index) {
  const s = steps[index];
  const t = s.target || {};
  const nextClick = steps.slice(index + 1).find((x) => x.action === 'click' || x.action === 'press');
  let path = '';
  try {
    path = new URL(s.url).pathname;
  } catch {}
  // The form/dialog and its submit button describe the intent best; the URL and title are fallbacks.
  const near = norm([t.context?.form, t.context?.dialog, nextClick?.target?.name, nextClick?.target?.friendly].filter(Boolean).join(' | '));
  for (const [intent, re] of INTENT_RULES) if (re.test(near)) return intent;
  const far = norm([s.title, path].filter(Boolean).join(' | '));
  for (const [intent, re] of INTENT_RULES) if (re.test(far)) return intent;
  return 'form';
}

/** Field label -> data key ("First name" -> "firstName"). Shared with the exporters so keys always match. */
export function camel(s) {
  const words = String(s || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (!words.length) return 'field';
  const out = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  return /^\d/.test(out) ? `f${out}` : out;
}

function recommend(field, intent, now) {
  const k = field.kind;
  if (k === 'otp') return ['custom', 'One-time code changes every time — enter it when the Run starts.'];
  if (k === 'cvv' || k === 'cardNumber' || k === 'expiry') return ['recorded', 'Payment test data — keep the sandbox card.'];
  if (k === 'password') return intent === 'signup' ? ['fresh', 'New account needs its own password.'] : ['recorded', 'Existing account credentials.'];
  if (k === 'secret') return ['recorded', 'Secret value — kept from the recording (exported as an env variable).'];
  if (k === 'search') return ['recorded', 'Results depend on this search term.'];
  if (k === 'option') return ['recorded', 'Choosing another option can change the flow.'];
  if ((k === 'date' || k === 'datetime') && FUTURE_DATE_RE.test(norm(field.label))) {
    const d = Date.parse(field.recorded);
    if (!Number.isNaN(d) && d < now) return ['fresh', 'Recorded date is in the past — the app will likely reject it.'];
  }
  if (intent === 'signup' || intent === 'create') {
    if (UNIQUE_KINDS.has(k)) return ['fresh', `Must be unique — reusing it will hit "already exists".`];
    if (!['number', 'amount', 'quantity', 'country', 'state', 'date', 'datetime', 'time', 'dob'].includes(k)) {
      return ['fresh', 'New record — fresh realistic data avoids duplicates.'];
    }
  }
  if (intent === 'login') return ['recorded', 'Existing account — reuse the recorded value.'];
  if (k === 'amount' || k === 'quantity' || k === 'number') return ['recorded', 'Totals and limits depend on this number.'];
  return ['recorded', 'Value from the recording.'];
}

function constraintsOf(t = {}) {
  const c = {};
  for (const k of ['maxLength', 'minLength', 'pattern', 'min', 'max', 'step', 'required']) if (t[k] !== undefined && t[k] !== null && t[k] !== '' && t[k] !== -1) c[k] = t[k];
  if (t.options) c.options = t.options;
  return c;
}

export function buildDataPlan(steps, { now = Date.now() } = {}) {
  const fields = [];
  const used = new Set();
  const intents = [];
  steps.forEach((s, i) => {
    if (s.action !== 'fill' && s.action !== 'select') return;
    if (s.skip) return;
    const kind = inferKind(s);
    const label = fieldLabel(s.target);
    let key = camel(label);
    for (let n = 2; used.has(key); n++) key = `${camel(label)}${n}`;
    used.add(key);
    const intent = stepIntent(steps, i);
    if (s.action === 'fill') intents.push(intent); // typed fields describe the scenario; dropdowns don't
    const field = {
      stepId: s.id,
      key,
      label,
      kind,
      action: s.action,
      secret: SECRET_KINDS.has(kind) || !!s.sensitive,
      recorded: s.value ?? '',
      recordedLabel: s.optionLabels?.[0],
      masked: !!s.masked,
      constraints: constraintsOf(s.target),
      intent,
    };
    [field.strategy, field.reason] = recommend(field, intent, now);
    fields.push(field);
  });
  const intent = INTENT_PRIORITY.find((p) => intents.includes(p)) || 'form';
  return { intent, needsDecision: fields.some((f) => f.strategy !== 'recorded'), fields };
}

// ------------------------------------------------------------------ generation

function capitalize(w) {
  return w ? w[0].toUpperCase() + w.slice(1) : w;
}
function differs(rng, gen, recorded, tries = 6) {
  let v = gen();
  for (let i = 0; i < tries && v === recorded; i++) v = gen();
  return v;
}
/** Letters→random letters (same case), digits→random digits, everything else kept. */
function shapeOf(rng, s) {
  return String(s).replace(/[A-Z]/g, () => rng.token(1, 'ABCDEFGHJKLMNPQRSTUVWXYZ')).replace(/[a-z]/g, () => rng.token(1, 'abcdefghjkmnpqrstuvwxyz')).replace(/\d/g, () => String(rng.int(0, 9)));
}
function phoneParts(recorded) {
  const s = String(recorded || '');
  const groups = s.split(/(?<=\S)(?=[\s-])/); // keep separators attached to the following group
  if (s.startsWith('+') && groups.length > 2) return [groups.slice(0, 2).join(''), groups.slice(2).join('')];
  if (groups.length > 1) return [groups[0], groups.slice(1).join('')];
  const digits = s.replace(/\D/g, '');
  return digits.length >= 7 ? [s.slice(0, 3), s.slice(3)] : ['+1 555 ', '010 0000'];
}
function iso(d) {
  return d.toISOString().slice(0, 10);
}
function fitLength(v, c) {
  let out = String(v);
  if (c.maxLength && out.length > Number(c.maxLength)) out = out.slice(0, Number(c.maxLength));
  while (c.minLength && out.length < Number(c.minLength)) out += 'x';
  return out;
}
function matchesPattern(v, pattern) {
  if (!pattern) return true;
  try {
    return new RegExp(`^(?:${pattern})$`, 'v').test(v);
  } catch {
    try {
      return new RegExp(`^(?:${pattern})$`).test(v);
    } catch {
      return true;
    }
  }
}

function generate(field, rng, now) {
  const r = String(field.recorded ?? '');
  const c = field.constraints || {};
  const word = () => rng.pick(WORDS);
  switch (field.kind) {
    case 'email': {
      const [local, domain] = r.includes('@') ? r.split('@') : ['qa', 'example.com'];
      return `${local.split('+')[0]}+${rng.token(6)}@${domain}`;
    }
    case 'username':
      return `${(r.replace(/[^a-zA-Z]/g, '').slice(0, 10) || 'qa_user').toLowerCase()}_${rng.token(5)}`;
    case 'password':
      return `${capitalize(word())}${rng.int(10, 99)}!${capitalize(word())}${rng.token(3, 'abcdefghjkmnpqrstuvwxyz')}${rng.int(1, 9)}`;
    case 'firstName':
      return differs(rng, () => rng.pick(FIRST), r);
    case 'lastName':
      return differs(rng, () => rng.pick(LAST), r);
    case 'fullName':
      return differs(rng, () => `${rng.pick(FIRST)} ${rng.pick(LAST)}`, r);
    case 'phone': {
      const [prefix, rest] = phoneParts(r);
      return prefix + shapeOf(rng, rest).replace(/^(\D*)0/, (m, p) => `${p}${rng.int(1, 9)}`);
    }
    case 'company':
      return differs(rng, () => rng.pick(COMPANIES), r);
    case 'street':
      return `${rng.int(1, 250)} ${rng.pick(STREETS)}`;
    case 'city':
      return differs(rng, () => rng.pick(CITIES), r);
    case 'state':
      return rng.pick(STATES);
    case 'postalCode':
      return r ? shapeOf(rng, r) : String(rng.int(10000, 99999));
    case 'country':
      return r || 'United Arab Emirates';
    case 'url':
      return `https://example.com/${rng.token(8)}`;
    case 'dob':
      return iso(new Date(now - rng.int(25 * 365, 60 * 365) * 86400000));
    case 'date': {
      const future = FUTURE_DATE_RE.test(norm(field.label)) || Date.parse(r) < now;
      const d = new Date(now + (future ? rng.int(7, 60) : rng.int(-30, 30)) * 86400000);
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(r)) return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
      return iso(d);
    }
    case 'datetime':
      return `${iso(new Date(now + rng.int(7, 60) * 86400000))}T${String(rng.int(9, 17)).padStart(2, '0')}:00`;
    case 'time':
      return `${String(rng.int(8, 18)).padStart(2, '0')}:${rng.pick(['00', '15', '30', '45'])}`;
    case 'amount': {
      const min = c.min !== undefined ? Number(c.min) : 1;
      const max = c.max !== undefined ? Number(c.max) : Math.max(100, Number(r) * 2 || 500);
      const v = min + rng.next() * (max - min);
      return /\./.test(r) || !r ? v.toFixed(2) : String(Math.round(v));
    }
    case 'quantity':
      return String(rng.int(Number(c.min ?? 1), Number(c.max ?? 5)));
    case 'number': {
      if (c.min !== undefined || c.max !== undefined) return String(rng.int(Number(c.min ?? 0), Number(c.max ?? Number(c.min ?? 0) + 100)));
      return r ? shapeOf(rng, r).replace(/^0(?=\d)/, String(rng.int(1, 9))) : String(rng.int(1, 999));
    }
    case 'option': {
      const opts = (c.options || []).filter((o) => o.value !== '' && !o.disabled);
      return opts.length ? differs(rng, () => rng.pick(opts).value, r) : r;
    }
    case 'cardNumber':
      return '4111111111111111';
    case 'cvv':
      return '123';
    case 'expiry': {
      const d = new Date(now + 2 * 365 * 86400000);
      return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCFullYear()).slice(2)}`;
    }
    case 'search':
    case 'otp':
    case 'secret':
      return r;
    case 'paragraph':
      return `${capitalize(word())} ${word()} ${word()} for ${word()} ${word()}. Created by QA run ${rng.token(4)}.`;
    case 'sentence':
      return `${capitalize(word())} ${word()} ${rng.token(4)}`;
    default:
      // Code-like values keep their shape (ACME-1234 -> QWRT-5821); prose gets new words.
      if (/^[A-Z0-9][A-Z0-9_\-/.]*$/.test(r) || /\d/.test(r)) return differs(rng, () => shapeOf(rng, r), r);
      return `${capitalize(word())} ${word()} ${rng.token(4)}`;
  }
}

function freshValue(field, rng, now) {
  const c = field.constraints || {};
  let v = fitLength(generate(field, rng, now), c);
  if (!matchesPattern(v, c.pattern)) {
    for (let i = 0; i < 8 && !matchesPattern(v, c.pattern); i++) v = fitLength(shapeOf(rng, field.recorded), c);
    if (!matchesPattern(v, c.pattern)) v = field.recorded;
  }
  return v;
}

// ------------------------------------------------------------------ resolve / apply

export function resolveData(plan, choices = {}, { rng = createRng(), now = Date.now() } = {}) {
  const mode = choices.mode || 'recommended';
  const values = {};
  const fields = plan.fields.map((f) => {
    let strategy;
    if (choices.custom && choices.custom[f.key] !== undefined && choices.custom[f.key] !== '') strategy = 'custom';
    else if (choices.strategies?.[f.key]) strategy = choices.strategies[f.key];
    else if (mode === 'recorded') strategy = f.strategy === 'custom' ? 'custom' : 'recorded';
    else if (mode === 'fresh') strategy = f.strategy === 'custom' || (f.kind === 'password' && f.strategy === 'recorded') || (f.secret && f.kind !== 'password') ? f.strategy : 'fresh';
    else strategy = f.strategy;
    let value;
    if (strategy === 'custom') value = choices.custom?.[f.key] ?? '';
    else if (strategy === 'fresh') value = freshValue(f, rng, now);
    else value = f.recorded;
    values[f.stepId] = value;
    return { ...f, strategy, value, missing: strategy === 'custom' && !value };
  });
  return { values, fields };
}

export function applyData(steps, resolved) {
  const byStep = new Map(resolved.fields.map((f) => [f.stepId, f]));
  const replacements = resolved.fields
    .filter((f) => !f.secret && f.value !== f.recorded && String(f.recorded).length >= 3)
    .map((f) => [String(f.recorded), String(f.value), f.kind === 'option' ? f.constraints?.options : null]);
  const sub = (text) => {
    let out = String(text);
    for (const [from, to] of replacements) out = out.split(from).join(to);
    return out;
  };
  return steps.map((s) => {
    const f = byStep.get(s.id);
    if (f) {
      if (s.action === 'select') {
        const opt = (f.constraints?.options || []).find((o) => o.value === f.value);
        return { ...s, value: f.value, values: [f.value], optionLabels: opt ? [opt.label] : s.optionLabels };
      }
      return { ...s, value: f.value, masked: f.strategy === 'recorded' ? s.masked : false };
    }
    if (s.action === 'assert' && typeof s.assert?.expected === 'string' && replacements.length) {
      return { ...s, assert: { ...s.assert, expected: sub(s.assert.expected) } };
    }
    return s;
  });
}

// ------------------------------------------------------------------ code generation (for exported specs)

export function dataHelpersSource() {
  return [
    '// Fresh test data for every run (generated by QA Scenario Recorder).',
    'const qaData = {',
    "  uid: (n = 6) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join(''),",
    '  pick: (list) => list[Math.floor(Math.random() * list.length)],',
    '  int: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,',
    "  shape: (s) => s.replace(/[A-Z]/g, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).replace(/[a-z]/g, () => 'abcdefghjkmnpqrstuvwxyz'[Math.floor(Math.random() * 23)]).replace(/\\d/g, () => String(Math.floor(Math.random() * 10))),",
    '  daysFromNow: (min, max) => new Date(Date.now() + (Math.floor(Math.random() * (max - min + 1)) + min) * 86400000).toISOString().slice(0, 10),',
    "  password: () => `Qa${Math.floor(Math.random() * 90 + 10)}!${Math.random().toString(36).slice(2, 8)}X`,",
    '};',
  ].join('\n');
}

const js = (v) => JSON.stringify(v);

export function generatorSource(field) {
  const r = String(field.recorded ?? '');
  const c = field.constraints || {};
  switch (field.kind) {
    case 'email': {
      const [local, domain] = r.includes('@') ? r.split('@') : ['qa', 'example.com'];
      return `\`${local.split('+')[0]}+\${qaData.uid(6)}@${domain}\``;
    }
    case 'username':
      return `\`${(r.replace(/[^a-zA-Z]/g, '').slice(0, 10) || 'qa_user').toLowerCase()}_\${qaData.uid(5)}\``;
    case 'password':
      return 'qaData.password()';
    case 'firstName':
      return `qaData.pick(${js(FIRST)})`;
    case 'lastName':
      return `qaData.pick(${js(LAST)})`;
    case 'fullName':
      return `\`\${qaData.pick(${js(FIRST)})} \${qaData.pick(${js(LAST)})}\``;
    case 'phone': {
      const [prefix, rest] = phoneParts(r);
      return `${js(prefix)} + qaData.shape(${js(rest)})`;
    }
    case 'company':
      return `qaData.pick(${js(COMPANIES)})`;
    case 'street':
      return `\`\${qaData.int(1, 250)} \${qaData.pick(${js(STREETS)})}\``;
    case 'city':
      return `qaData.pick(${js(CITIES)})`;
    case 'state':
      return `qaData.pick(${js(STATES)})`;
    case 'postalCode':
      return r ? `qaData.shape(${js(r)})` : 'String(qaData.int(10000, 99999))';
    case 'url':
      return '`https://example.com/${qaData.uid(8)}`';
    case 'date':
    case 'datetime':
      return 'qaData.daysFromNow(7, 60)';
    case 'dob':
      return 'qaData.daysFromNow(-60 * 365, -25 * 365)';
    case 'time':
      return "`${String(qaData.int(8, 18)).padStart(2, '0')}:00`";
    case 'quantity':
      return `String(qaData.int(${Number(c.min ?? 1)}, ${Number(c.max ?? 5)}))`;
    case 'number':
    case 'amount':
      if (c.min !== undefined || c.max !== undefined) return `String(qaData.int(${Number(c.min ?? 0)}, ${Number(c.max ?? Number(c.min ?? 0) + 100)}))`;
      return r ? `qaData.shape(${js(r)})` : 'String(qaData.int(1, 999))';
    case 'option': {
      const opts = (c.options || []).filter((o) => o.value !== '' && !o.disabled).map((o) => o.value);
      return opts.length ? `qaData.pick(${js(opts)})` : js(r);
    }
    case 'paragraph':
      return '`Automated QA note ${qaData.uid(4)}.`';
    case 'sentence':
      return '`QA ${qaData.uid(5)}`';
    case 'search':
    case 'country':
    case 'cardNumber':
    case 'cvv':
    case 'expiry':
    case 'otp':
    case 'secret':
      return js(r);
    default:
      if (/^[A-Z0-9][A-Z0-9_\-/.]*$/.test(r) || /\d/.test(r)) return `qaData.shape(${js(r)})`;
      return '`QA ${qaData.uid(6)}`';
  }
}

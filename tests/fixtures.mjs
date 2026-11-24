// A realistic recorded session (login → search → add to cart → order → verify).
const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);
let seq = 1;
const ev = (kind, ts, data) => ({ id: seq, seq: seq++, kind, ts: T0 + ts, sessionId: 'sess_demo', runId: null, ...data });

const target = (extra) => ({
  viewport: { w: 1280, h: 720, dpr: 1 },
  rect: { x: 100, y: 200, w: 120, h: 32 },
  context: {},
  ...extra,
});

export const session = {
  id: 'sess_demo',
  name: 'Login and place an order',
  createdAt: T0,
  startUrl: 'http://localhost:4321/app/login',
  status: 'completed',
  durationMs: 42000,
  environment: { userAgent: 'Chrome/131', viewport: { width: 1280, height: 720 }, language: 'en-US', timezone: 'Asia/Dubai', devicePixelRatio: 1 },
  runs: [],
};

export const events = [
  ev('step', 0, { action: 'goto', url: 'http://localhost:4321/app/login', title: 'Demo Shop' }),
  ev('step', 1000, {
    action: 'fill',
    value: 'qa@example.com',
    url: 'http://localhost:4321/app/login',
    target: target({
      tag: 'input', type: 'email', friendly: 'Email', label: 'Email', id: 'email', nameAttr: 'email', context: { form: 'Sign in' },
      candidates: [
        { type: 'id', value: 'email', css: '#email', unique: true },
        { type: 'role', role: 'textbox', name: 'Email', unique: true },
        { type: 'label', value: 'Email', unique: true },
        { type: 'css', value: '#email', css: '#email', unique: true },
        { type: 'xpath', value: '//*[@id="email"]', unique: false },
      ],
    }),
  }),
  ev('step', 2000, {
    action: 'fill',
    value: 'Passw0rd!',
    sensitive: true,
    url: 'http://localhost:4321/app/login',
    target: target({
      tag: 'input', type: 'password', friendly: 'Password', label: 'Password', id: 'password', nameAttr: 'password', context: { form: 'Sign in' },
      candidates: [
        { type: 'id', value: 'password', css: '#password', unique: true },
        { type: 'label', value: 'Password', unique: true },
        { type: 'css', value: '#password', css: '#password', unique: true },
      ],
    }),
  }),
  ev('step', 3000, {
    action: 'click',
    url: 'http://localhost:4321/app/login',
    target: target({
      tag: 'button', role: 'button', name: 'Sign in', friendly: 'Sign in', context: { form: 'Sign in' },
      candidates: [
        { type: 'role', role: 'button', name: 'Sign in', unique: true },
        { type: 'text', tag: 'button', value: 'Sign in', unique: true },
        { type: 'css', value: 'form > button.primary', css: 'form > button.primary', unique: true },
      ],
    }),
  }),
  ev('network', 3300, {
    api: 'fetch', method: 'POST', url: 'http://localhost:4321/api/login', status: 200, duration: 140, startTime: T0 + 3050,
    requestHeaders: { 'Content-Type': 'application/json' },
    requestBody: '{"email":"qa@example.com","password":"Passw0rd!"}',
    responseHeaders: { 'content-type': 'application/json' }, mimeType: 'application/json',
    responseBody: '{"token":"tok_abc","user":{"email":"qa@example.com"}}',
  }),
  ev('navigation', 3400, { url: 'http://localhost:4321/app/products', spa: true }),
  ev('network', 3500, {
    api: 'fetch', method: 'GET', url: 'http://localhost:4321/api/products?q=&category=', status: 200, duration: 90, startTime: T0 + 3420,
    requestHeaders: { Authorization: 'Bearer tok_abc' }, mimeType: 'application/json', responseBody: '{"items":[]}',
  }),
  ev('step', 5000, {
    action: 'select', value: 'peripherals', values: ['peripherals'], optionLabels: ['Peripherals'], url: 'http://localhost:4321/app/products',
    target: target({ tag: 'select', role: 'combobox', name: 'Category', friendly: 'Category', id: 'category', candidates: [{ type: 'id', value: 'category', css: '#category', unique: true }] }),
  }),
  ev('step', 7000, {
    action: 'click', url: 'http://localhost:4321/app/products',
    target: target({
      tag: 'button', role: 'button', name: 'Add to cart', friendly: 'Add to cart', testId: { attr: 'data-testid', value: 'add-101' },
      context: { row: 'Mechanical keyboard — $89.00 Add to cart' },
      candidates: [
        { type: 'testid', attr: 'data-testid', value: 'add-101', css: '[data-testid="add-101"]', unique: true },
        { type: 'role', role: 'button', name: 'Add to cart', unique: false },
      ],
    }),
  }),
  ev('step', 8000, { action: 'check', url: 'http://localhost:4321/app/products', target: target({ tag: 'input', type: 'checkbox', role: 'checkbox', friendly: 'Express delivery', id: 'express', candidates: [{ type: 'id', value: 'express', css: '#express', unique: true }] }) }),
  ev('step', 9000, {
    action: 'click', url: 'http://localhost:4321/app/products',
    target: target({ tag: 'button', role: 'button', name: 'Apply coupon', friendly: 'Apply coupon', id: 'coupon', candidates: [{ type: 'id', value: 'coupon', css: '#coupon', unique: true }] }),
  }),
  ev('network', 9200, { api: 'fetch', method: 'POST', url: 'http://localhost:4321/api/coupon', status: 500, duration: 150, startTime: T0 + 9050, requestBody: '{"code":"WELCOME10"}', mimeType: 'application/json', responseBody: '{"error":"Coupon service unavailable"}' }),
  ev('console', 9300, { level: 'error', message: 'Coupon failed Error: Coupon service unavailable', url: 'http://localhost:4321/app/products' }),
  ev('step', 9500, { action: 'note', value: 'Coupon returns 500', flag: 'bug' }),
  ev('step', 11000, {
    action: 'click', url: 'http://localhost:4321/app/products',
    target: target({ tag: 'button', role: 'button', name: 'Place order', friendly: 'Place order', testId: { attr: 'data-testid', value: 'place-order' }, candidates: [{ type: 'testid', attr: 'data-testid', value: 'place-order', css: '[data-testid="place-order"]', unique: true }] }),
  }),
  ev('network', 11300, { api: 'fetch', method: 'POST', url: 'http://localhost:4321/api/orders', status: 201, duration: 180, startTime: T0 + 11050, requestBody: '{"items":[{"id":101,"qty":1}],"express":true}', mimeType: 'application/json', responseBody: '{"id":5001,"total":89,"status":"CONFIRMED"}' }),
  ev('step', 13000, {
    action: 'click', url: 'http://localhost:4321/app/products',
    target: target({ tag: 'button', role: 'button', name: "View order", friendly: 'View order', id: 'viewOrder', context: { dialog: 'Order confirmed' }, candidates: [{ type: 'id', value: 'viewOrder', css: '#viewOrder', unique: true }] }),
  }),
  ev('navigation', 13100, { url: 'http://localhost:4321/app/orders/5001', spa: true }),
  ev('network', 13300, { api: 'fetch', method: 'GET', url: 'http://localhost:4321/api/orders/5001', status: 200, duration: 80, startTime: T0 + 13150, mimeType: 'application/json', responseBody: '{"id":5001,"status":"CONFIRMED"}' }),
  ev('step', 15000, {
    action: 'assert', assert: { type: 'text', expected: 'CONFIRMED' }, url: 'http://localhost:4321/app/orders/5001',
    target: target({ tag: 'b', friendly: 'CONFIRMED', testId: { attr: 'data-testid', value: 'order-status' }, candidates: [{ type: 'testid', attr: 'data-testid', value: 'order-status', css: '[data-testid="order-status"]', unique: true }] }),
  }),
  ev('step', 16000, { action: 'press', key: 'k', modifiers: { ctrl: true }, url: 'http://localhost:4321/app/orders/5001' }),
];

export const screenshots = [
  { id: 'shot_1', stepEventId: 1, reason: 'start', dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
  { id: 'shot_4', stepEventId: 4, reason: 'click', dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
  { id: 'shot_pl', stepEventId: null, reason: 'page-load', dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
];

// Demo "shop" app for trying QA Scenario Recorder. Zero dependencies.
//   node demo/server.js   →  http://localhost:4321   (login: qa@example.com / Passw0rd!)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.PORT || 4321);
const here = dirname(fileURLToPath(import.meta.url));
const USERS = { 'qa@example.com': { password: 'Passw0rd!', name: 'QA Engineer' } };
const PRODUCTS = [
  { id: 101, name: 'Mechanical keyboard', price: 89.0, category: 'peripherals' },
  { id: 102, name: '4K monitor', price: 329.0, category: 'displays' },
  { id: 103, name: 'USB-C hub', price: 39.5, category: 'peripherals' },
  { id: 104, name: 'Noise-cancelling headset', price: 149.0, category: 'audio' },
];
const tokens = new Map();
const orders = new Map();
let nextOrder = 5001;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  try {
    return data ? JSON.parse(data) : {};
  } catch {
    return null;
  }
}
function auth(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return tokens.get(t);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 200)); // realistic latency

  if (p === '/' || p === '/index.html' || p.startsWith('/app')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(await readFile(join(here, 'index.html')));
  }
  if (p === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const u = USERS[body?.email];
    if (!u || u.password !== body.password) return json(res, 401, { error: 'Invalid email or password' });
    const token = `tok_${Math.random().toString(36).slice(2)}`;
    tokens.set(token, { email: body.email, name: u.name });
    return json(res, 200, { token, user: { email: body.email, name: u.name } });
  }
  const user = auth(req);
  if (p.startsWith('/api/') && !user) return json(res, 401, { error: 'Unauthorized' });
  if (p === '/api/products' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const cat = url.searchParams.get('category') || '';
    return json(res, 200, { items: PRODUCTS.filter((x) => (!q || x.name.toLowerCase().includes(q)) && (!cat || x.category === cat)) });
  }
  if (p === '/api/orders' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body?.items?.length) return json(res, 422, { error: 'Cart is empty' });
    const total = body.items.reduce((s, it) => s + (PRODUCTS.find((x) => x.id === it.id)?.price || 0) * it.qty, 0);
    const order = { id: nextOrder++, items: body.items, express: !!body.express, total: Math.round(total * 100) / 100, status: 'CONFIRMED' };
    orders.set(order.id, order);
    return json(res, 201, order);
  }
  const m = p.match(/^\/api\/orders\/(\d+)$/);
  if (m && req.method === 'GET') {
    const o = orders.get(Number(m[1]));
    return o ? json(res, 200, o) : json(res, 404, { error: 'Order not found' });
  }
  if (p === '/api/coupon' && req.method === 'POST') {
    return json(res, 500, { error: 'Coupon service unavailable' }); // deliberate bug for demos
  }
  json(res, 404, { error: 'Not found' });
}).listen(PORT, () => console.log(`Demo shop running at http://localhost:${PORT}  (qa@example.com / Passw0rd!)`));

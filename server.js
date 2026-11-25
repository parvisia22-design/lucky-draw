'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const L = require('./lib/logic');
const { Store, FileBackend, PgBackend, emptyState } = require('./lib/store');
const { SheetSync } = require('./lib/sheets');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

function createApp(store, env) {
  const EVENT_NAME = env.EVENT_NAME || 'Our Booth';
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
  const PUBLIC_URL = (env.BASE_URL || '').replace(/\/+$/, '');
  const page = name => fs.readFileSync(path.join(__dirname, 'public', name), 'utf8').replace(/\{\{EVENT_NAME\}\}/g, esc(EVENT_NAME));
  const SIGNUP_HTML = page('signup.html');
  const ADMIN_HTML = page('admin.html');
  const QR_HTML = page('qr.html');
  const sheets = new SheetSync({ url: env.SHEETS_WEBHOOK_URL, secret: env.SHEETS_SECRET, eventName: EVENT_NAME, getState: () => store.get() });
  store.onChange(() => sheets.schedule());
  sheets.schedule();                               // catch up on anything changed while the app was down

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);                       // Railway sits behind a proxy
  app.use(express.json({ limit: '20kb' }));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
    });
    if (req.path.startsWith('/api') || req.path.startsWith('/admin')) res.set('Cache-Control', 'no-store');
    next();
  });

  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const baseUrl = req => PUBLIC_URL || (req.protocol + '://' + req.get('host'));

  /* ---------- public ---------- */
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/', (req, res) => res.type('html').send(SIGNUP_HTML));
  app.use('/brand', express.static(path.join(__dirname, 'public', 'brand'), { maxAge: '7d' }));

  // simple per-IP limit for sign-ups (a whole venue can share one IP, so it is generous)
  const hits = new Map();
  setInterval(() => hits.clear(), 60000).unref();
  app.post('/api/register', wrap(async (req, res) => {
    const n = (hits.get(req.ip) || 0) + 1; hits.set(req.ip, n);
    if (n > 600) throw new L.HttpError(429, 'Too many requests. Please wait a moment.');
    if (req.body && req.body.website) return res.json({ ok: true, ticket: '0000', name: 'Thank you', existing: false });   // honeypot
    const r = await store.mutate(draft => L.register(draft, req.body));
    res.json({ ok: true, ticket: r.attendee.ticket, name: r.attendee.name, existing: r.existing });
  }));

  app.get('/qr.svg', wrap(async (req, res) => {
    const svg = await QRCode.toString(baseUrl(req) + '/', { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').send(svg);
  }));
  app.get('/qr', wrap(async (req, res) => {
    const url = baseUrl(req) + '/';
    const svg = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    res.type('html').send(QR_HTML.replace('{{QR_SVG}}', () => svg).replace('{{URL}}', () => esc(url)));
  }));

  /* ---------- admin (HTTP Basic auth) ---------- */
  const fails = new Map();
  setInterval(() => fails.clear(), 5 * 60000).unref();
  function deny(res, status, msg) {
    if (status === 401) res.set('WWW-Authenticate', 'Basic realm="Booth staff", charset="UTF-8"');
    return res.status(status).type('text').send(msg);
  }
  function auth(req, res, next) {
    if (!ADMIN_PASSWORD) return deny(res, 503, 'Staff area is disabled. Set the ADMIN_PASSWORD variable on the server.');
    if ((fails.get(req.ip) || 0) >= 10) return deny(res, 429, 'Too many wrong passwords. Try again in a few minutes.');
    const h = req.get('authorization') || '';
    let pass = '';
    if (/^basic /i.test(h)) {
      const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
      pass = dec.slice(dec.indexOf(':') + 1);
    }
    if (h && crypto.timingSafeEqual(sha(pass), sha(ADMIN_PASSWORD))) return next();
    if (h) fails.set(req.ip, (fails.get(req.ip) || 0) + 1);
    return deny(res, 401, 'Staff login required.');
  }
  app.use(['/admin', '/api/admin'], auth);
  app.use('/api/admin', (req, res, next) => {        // blocks cross-site form posts (CSRF)
    if (req.method !== 'GET' && req.get('x-requested-with') !== 'booth') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
  app.get('/admin', (req, res) => res.type('html').send(ADMIN_HTML));

  const view = state => ({
    eventName: EVENT_NAME, attendees: state.attendees, draws: state.draws, prizes: state.prizes,
    config: state.config, tally: state.tally, sheets: sheets.status(), serverTime: new Date().toISOString()
  });
  app.get('/api/admin/state', (req, res) => res.json(view(store.get())));

  app.post('/api/admin/spin', wrap(async (req, res) => {
    const r = await store.mutate(draft => L.spin(draft, req.body && req.body.who));
    res.json({ draw: r.draw, segs: r.segs, winner: r.winner, state: view(store.get()) });
  }));
  app.post('/api/admin/undo', wrap(async (req, res) => {
    await store.mutate(draft => {
      const i = draft.draws.findIndex(d => d.id === (req.body && req.body.id));
      if (i < 0) throw new L.HttpError(404, 'That draw no longer exists.');
      draft.draws.splice(i, 1);
    });
    res.json(view(store.get()));
  }));
  app.put('/api/admin/prizes', wrap(async (req, res) => {
    await store.mutate(draft => L.setPrizes(draft, req.body && req.body.prizes));
    res.json(view(store.get()));
  }));
  app.put('/api/admin/config', wrap(async (req, res) => {
    await store.mutate(draft => L.setConfig(draft, req.body));
    res.json(view(store.get()));
  }));
  app.post('/api/admin/attendee', wrap(async (req, res) => {
    // optional souvenir in the same step: if it can't be given (out of stock, ...) nobody is added either
    const r = await store.mutate(draft => {
      const attendee = L.staffCheckin(draft, req.body);
      const prizeId = req.body && req.body.prizeId;
      return { attendee, draw: prizeId ? L.give(draft, attendee.ticket, prizeId) : null };
    });
    res.json({ attendee: r.attendee, draw: r.draw, state: view(store.get()) });
  }));
  app.post('/api/admin/give', wrap(async (req, res) => {
    const draw = await store.mutate(draft => L.give(draft, req.body && req.body.who, req.body && req.body.prizeId));
    res.json({ draw, state: view(store.get()) });
  }));
  app.delete('/api/admin/attendee/:id', wrap(async (req, res) => {
    await store.mutate(draft => {
      const i = draft.attendees.findIndex(a => a.id === req.params.id && a.source === 'Staff');
      if (i < 0) throw new L.HttpError(404, 'Only staff check-ins can be removed here.');
      draft.attendees.splice(i, 1);
    });
    res.json(view(store.get()));
  }));
  app.post('/api/admin/tally', wrap(async (req, res) => {
    const delta = Math.max(-1000, Math.min(1000, parseInt(req.body && req.body.delta, 10) || 0));
    await store.mutate(draft => { draft.tally = Math.max(0, draft.tally + delta); });
    res.json(view(store.get()));
  }));
  app.post('/api/admin/reset', wrap(async (req, res) => {
    if (!req.body || req.body.confirm !== 'DELETE') throw new L.HttpError(400, 'Type DELETE to confirm.');
    const what = req.body.what;
    if (what !== 'draws' && what !== 'all') throw new L.HttpError(400, 'Unknown reset.');
    await store.mutate(draft => {
      draft.draws = []; draft.nextDraw = 1;
      if (what === 'all') { draft.attendees = []; draft.nextTicket = 1; draft.nextStaff = 1; draft.tally = 0; }
    });
    res.json(view(store.get()));
  }));
  app.post('/api/admin/sheets/sync', wrap(async (req, res) => {
    await sheets.syncNow();
    res.json(view(store.get()));
  }));
  app.get('/api/admin/export.csv', (req, res) => {
    const which = req.query.type === 'draws' ? 'draws' : 'attendance';
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + which + '.csv"' });
    res.send(which === 'draws' ? L.drawsCsv(store.get()) : L.attendanceCsv(store.get()));
  });

  app.use((req, res) => res.status(404).type('text').send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof L.HttpError) return res.status(err.status).json({ error: err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
    console.error(err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  });
  return app;
}

async function makeStore(env) {
  let backend;
  if (env.DATABASE_URL) {
    const { Pool } = require('pg');
    backend = new PgBackend(new Pool({ connectionString: env.DATABASE_URL, max: 5 }));
  } else {
    backend = new FileBackend(env.DATA_DIR || path.join(__dirname, 'data'));
  }
  const store = new Store(backend);
  await store.init();
  return store;
}

module.exports = { createApp, makeStore };

if (require.main === module) {
  (async () => {
    const store = await makeStore(process.env);
    const port = Number(process.env.PORT) || 3000;
    createApp(store, process.env).listen(port, '0.0.0.0', () => {
      console.log('Booth app listening on ' + port + ' (' + (process.env.DATABASE_URL ? 'Postgres' : 'file storage') + ')');
      if (!process.env.ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set: the staff area is disabled.');
      console.log('Google Sheet sync: ' + (process.env.SHEETS_WEBHOOK_URL ? (process.env.SHEETS_SECRET ? 'on' : 'off (SHEETS_SECRET is not set)') : 'off'));
      if (!process.env.DATABASE_URL) console.warn('DATABASE_URL is not set: data is kept in a local file and will be lost if the host resets its disk.');
    });
  })().catch(e => { console.error(e); process.exit(1); });
}

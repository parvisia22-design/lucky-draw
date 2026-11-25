'use strict';
/**
 * Storage: the whole app state is one small JSON document (a few hundred KB at most).
 * - With DATABASE_URL set (Railway Postgres) it lives in one Postgres row. This is the one to use on the day.
 * - Without it, it is a JSON file in DATA_DIR (good for trying the app on your own computer).
 * Every change is saved BEFORE the request is answered, and changes run one at a time.
 */
const fs = require('fs');
const path = require('path');

const IN_PACKAGE = /sleeve|multi ?cable|\bpen\b|usb/i;   // items preset as part of the "full package"
function defaultPrizes() {
  return ['Sleeve bag', 'Multicable', 'Pen', 'Notebook', 'USB'].map((n, i) => ({ id: 'p' + (i + 1), name: n, total: 50, pkg: IN_PACKAGE.test(n) }));
}
function emptyState() {
  return {
    v: 1, nextTicket: 1, nextStaff: 1, nextDraw: 1, nextPrize: 6,
    attendees: [], draws: [], prizes: defaultPrizes(),
    config: { odds: 'stock', onePer: true, needReg: true, pkgInit: true, bonus: '', selfSpin: true },
    tally: 0
  };
}

class FileBackend {
  constructor(dir) { this.dir = dir; this.file = path.join(dir, 'state.json'); }
  async init() { await fs.promises.mkdir(this.dir, { recursive: true }); }
  async load() {
    try { return JSON.parse(await fs.promises.readFile(this.file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async save(state) {
    const tmp = this.file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(state));
    await fs.promises.rename(tmp, this.file);
  }
}

class PgBackend {
  constructor(pool) { this.pool = pool; }
  async init() {
    await this.pool.query('create table if not exists app_state (id integer primary key, data jsonb not null, updated_at timestamptz not null default now())');
  }
  async load() {
    const r = await this.pool.query('select data from app_state where id = 1');
    return r.rows[0] ? r.rows[0].data : null;
  }
  async save(state) {
    await this.pool.query(
      'insert into app_state (id, data, updated_at) values (1, $1, now()) on conflict (id) do update set data = excluded.data, updated_at = now()',
      [JSON.stringify(state)]);
  }
}

class Store {
  constructor(backend) { this.backend = backend; this.state = null; this.queue = Promise.resolve(); this.listeners = []; }
  async init() {
    if (this.backend.init) await this.backend.init();
    const loaded = await this.backend.load();
    // data saved before the "full package" existed: preset its items once, by name
    const presetPackage = !!loaded && !(loaded.config && loaded.config.pkgInit);
    this.state = Object.assign(emptyState(), loaded || {});
    this.state.config = Object.assign(emptyState().config, this.state.config || {});
    if (presetPackage) this.state.prizes.forEach(p => { p.pkg = IN_PACKAGE.test(p.name); });
    if (!loaded || presetPackage) await this.backend.save(this.state);
  }
  get() { return this.state; }
  /** fn is called after every saved change */
  onChange(fn) { this.listeners.push(fn); }
  /** Run fn on a copy of the state; if it succeeds the copy is saved and becomes the state. If fn throws, nothing changes. */
  mutate(fn) {
    const run = async () => {
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      await this.backend.save(draft);
      this.state = draft;
      this.listeners.forEach(fn => fn());
      return result;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

module.exports = { Store, FileBackend, PgBackend, emptyState, defaultPrizes };

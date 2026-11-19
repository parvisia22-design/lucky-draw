'use strict';
/**
 * Google Sheet mirror. After every change, the attendee list, the draw log and a summary are sent to a small
 * Google Apps Script web app (google-sheets/Code.gs) that writes them into the sheet.
 * Changes are batched for a few seconds, failures are retried, and the booth never waits for Google.
 */
const BATCH_MS = 3000;
const RETRY_MS = 30000;
const TIMEOUT_MS = 20000;

/** Each table says its own columns, so the Apps Script never needs editing when a column is added. */
function payload(state, eventName) {
  const qr = state.attendees.filter(a => a.source === 'QR').length;
  return {
    event: eventName,
    updatedAt: new Date().toISOString(),
    tables: [
      { name: 'Attendees', headers: ['Ticket', 'Signed up', 'Name', 'Phone', 'Email', 'Company', 'Source'], text: [1, 4], time: 2,
        rows: state.attendees.map(a => [a.ticket, a.ts, a.name, a.phone, a.email || '', a.company, a.source]) },
      { name: 'Draws', headers: ['No', 'Time', 'Ticket', 'Name', 'Prize'], text: [3], time: 2,
        rows: state.draws.map((d, i) => [i + 1, d.ts, d.ticket, d.name, d.prizeName]) }
    ],
    summary: [
      ['Total attendees', state.attendees.length],
      ['QR sign-ups', qr],
      ['Staff check-ins', state.attendees.length - qr],
      ['Walk-by tally (no sign-up)', state.tally],
      ['Prizes given', state.draws.length]
    ],
    prizes: state.prizes.map(p => {
      const given = state.draws.filter(d => d.prizeId === p.id).length;
      return [p.name, p.total | 0, given, Math.max(0, (p.total | 0) - given)];
    })
  };
}

class SheetSync {
  constructor({ url, secret, eventName, getState }) {
    this.url = url || '';
    this.secret = secret || '';
    this.eventName = eventName;
    this.getState = getState;
    this.timer = null;
    this.running = false;
    this.again = false;
    this.lastSync = null;
    this.error = '';
    if (this.url && !this.secret) { this.error = 'SHEETS_SECRET is not set.'; this.url = ''; }
  }
  get enabled() { return !!this.url; }
  status() {
    return { enabled: this.enabled, lastSync: this.lastSync, error: this.error, pending: !!this.timer || this.running };
  }
  /** Ask for a sync soon. Many changes close together become one sync. */
  schedule(delay = BATCH_MS) {
    if (!this.enabled) return;
    if (this.running) { this.again = true; return; }
    if (this.timer) return;
    this.timer = setTimeout(() => this.run(), delay);
  }
  async syncNow() {
    if (!this.enabled) return;
    if (this.running) { this.again = true; return; }
    clearTimeout(this.timer);
    await this.run();
  }
  async run() {
    this.timer = null;
    this.running = true;
    let failed = false;
    try {
      await this.send();
      this.lastSync = new Date().toISOString();
      this.error = '';
    } catch (e) {
      failed = true;
      this.error = e.message;
      console.warn('Google Sheet sync failed: ' + e.message);
    } finally {
      this.running = false;
      if (this.again || failed) { this.again = false; this.schedule(failed ? RETRY_MS : BATCH_MS); }
    }
  }
  async send() {
    const body = JSON.stringify(Object.assign({ secret: this.secret }, payload(this.getState(), this.eventName)));
    const r = await fetch(this.url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body,
      redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); }
    catch (e) { throw new Error('The Google script did not answer (HTTP ' + r.status + '). Check the web app URL and that access is "Anyone".'); }
    if (!j.ok) throw new Error(j.error || 'The Google script reported an error.');
  }
}

module.exports = { SheetSync, payload };

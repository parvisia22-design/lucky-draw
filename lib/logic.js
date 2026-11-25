'use strict';
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const digits = s => String(s || '').replace(/\D/g, '');
/** comparison key for phone numbers: +62 812… and 0812… are the same Indonesian number */
const phoneKey = s => { const d = digits(s); return d.startsWith('62') ? '0' + d.slice(2) : d.replace(/^0062/, '0'); };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanEmail = s => clean(s, 120).replace(/\s/g, '').toLowerCase();
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const pad3 = d => String(parseInt(d, 10)).padStart(3, '0');
/**
 * Tickets the typed text could mean: "qr5"/"QR005" -> QR005, "m5" -> M005, a bare "5" -> QR005 or M005
 * (plus the older formats 0005 and A005). Anything that is not a ticket -> null.
 */
function ticketCandidates(s) {
  const t = String(s || '').trim().replace(/^#/, '').replace(/[\s-]/g, '');
  let m;
  if ((m = /^qr(\d{1,6})$/i.exec(t))) return ['QR' + pad3(m[1])];
  if ((m = /^m(\d{1,6})$/i.exec(t))) return ['M' + pad3(m[1])];
  if ((m = /^a(\d{1,4})$/i.exec(t))) return ['A' + pad3(m[1])];
  if (/^\d{1,6}$/.test(t)) return ['QR' + pad3(t), 'M' + pad3(t), t.padStart(4, '0')];
  return null;
}

function remaining(state, prize) {
  const used = state.draws.reduce((n, d) => n + (d.prizeId === prize.id ? 1 : 0), 0);
  return Math.max(0, (prize.total | 0) - used);
}
/** prizes still in stock, as wheel slices: weight = remaining stock (or 1 each in "equal" mode) */
function segments(state) {
  const segs = [];
  state.prizes.forEach((p, i) => {
    const rem = remaining(state, p);
    if (rem > 0) segs.push({ prizeId: p.id, name: p.name, ci: i, rem, w: state.config.odds === 'equal' ? 1 : rem });
  });
  return segs;
}
function pickIndex(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = crypto.randomInt(total);
  for (let i = 0; i < weights.length; i++) { if (r < weights[i]) return i; r -= weights[i]; }
  return weights.length - 1;
}

function parseVisitor(data) {
  const name = clean(data && data.name, 80);
  const phone = clean(data && data.phone, 30);
  const email = cleanEmail(data && data.email);
  const company = clean(data && data.company, 80);
  if (!name) throw new HttpError(400, 'Please enter your name.');
  const d = digits(phone);
  if (d.length < 8 || d.length > 15) throw new HttpError(400, 'Please enter a valid phone number.');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  return { name, phone, email, company };
}

/** QR sign-up from a visitor's phone. Same phone number -> same ticket, no new row. */
function register(draft, data) {
  if (!data || data.consent !== true) throw new HttpError(400, 'Please tick the consent box.');
  const v = parseVisitor(data);
  const existing = draft.attendees.find(a => phoneKey(a.phone) === phoneKey(v.phone));
  if (existing) return { attendee: existing, existing: true };
  const attendee = { id: 'a' + draft.nextTicket, ticket: 'QR' + pad3(draft.nextTicket++), name: v.name, phone: v.phone, email: v.email, company: v.company, source: 'QR', ts: new Date().toISOString() };
  draft.attendees.push(attendee);
  return { attendee, existing: false };
}

/** Staff check-in (phone optional) */
function staffCheckin(draft, data) {
  const name = clean(data && data.name, 80);
  const phone = clean(data && data.phone, 30);
  const email = cleanEmail(data && data.email);
  const company = clean(data && data.company, 80);
  if (!name) throw new HttpError(400, 'Enter a name.');
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'That email address does not look right.');
  if (phone && (digits(phone).length < 6 || digits(phone).length > 15)) throw new HttpError(400, 'That phone number does not look right.');
  const dup = draft.attendees.find(a => phone ? phoneKey(a.phone) === phoneKey(phone) : a.name.toLowerCase() === name.toLowerCase());
  if (dup) throw new HttpError(409, dup.name + ' is already checked in (ticket ' + dup.ticket + ').');
  const n = draft.nextStaff++;
  const attendee = { id: 'm' + n, ticket: 'M' + pad3(n), name, phone, email, company, source: 'Staff', ts: new Date().toISOString() };
  draft.attendees.push(attendee);
  return attendee;
}

/** Who is getting a prize (by ticket or name), checked against the "registered only" and "one per attendee" rules. */
function resolveVisitor(draft, input) {
  const who = clean(input, 80);
  let att = null, name = who;
  const cands = ticketCandidates(who);
  if (cands) {
    const hits = draft.attendees.filter(a => cands.includes(a.ticket));
    if (hits.length > 1) throw new HttpError(409, 'Both ' + hits.map(a => a.ticket).join(' and ') + ' exist. Type the full ticket, for example ' + hits[0].ticket + '.');
    att = hits[0] || null;
    if (att) name = att.name;
    else if (draft.attendees.length) throw new HttpError(404, 'Ticket ' + (cands.length === 1 ? cands[0] : who) + ' was not found.');
  }
  if (!att && name) att = draft.attendees.find(a => a.name.toLowerCase() === name.toLowerCase()) || null;
  if (draft.config.needReg && !att) {
    throw new HttpError(403, name ? '"' + name + '" is not on the attendee list.' : 'Enter the visitor\'s ticket number or name first.');
  }
  const key = att ? 'a:' + att.ticket : (name ? 'n:' + name.toLowerCase() : '');
  if (draft.config.onePer && key) {
    const prev = draft.draws.find(d => d.key === key);
    if (prev) throw new HttpError(409, prev.name + ' already got: ' + prev.prizeName + '.');
  }
  return { att, name, key };
}

function recordDraw(draft, v, prize, how, group) {
  const draw = { id: 'd' + draft.nextDraw++, key: v.key, ticket: v.att ? v.att.ticket : '', name: v.att ? v.att.name : v.name,
    prizeId: prize.id, prizeName: prize.name, how, ts: new Date().toISOString() };
  if (group) draw.group = group;
  draft.draws.push(draw);
  return draw;
}

/** One spin. The server picks the winner; the page only animates it. */
function spin(draft, input) {
  const v = resolveVisitor(draft, input);
  const segs = segments(draft);
  if (!segs.length) throw new HttpError(409, 'All prizes are gone.');
  const winner = pickIndex(segs.map(s => s.w));
  const prize = draft.prizes.find(p => p.id === segs[winner].prizeId);
  return { draw: recordDraw(draft, v, prize, 'Wheel'), segs, winner };
}

const PACKAGE = 'package';
/**
 * Staff hand over a chosen souvenir directly, without spinning. Uses the same stock and rules as the wheel.
 * prizeId "package" gives one of every item ticked "in package"; each item is its own draw row, sharing a group id.
 */
function give(draft, input, prizeId) {
  if (prizeId === PACKAGE) return givePackage(draft, input);
  const prize = draft.prizes.find(p => p.id === prizeId);
  if (!prize) throw new HttpError(400, 'Choose a souvenir.');
  if (remaining(draft, prize) <= 0) throw new HttpError(409, prize.name + ' is out of stock.');
  return recordDraw(draft, resolveVisitor(draft, input), prize, 'Given');
}
function givePackage(draft, input) {
  const items = draft.prizes.filter(p => p.pkg);
  if (!items.length) throw new HttpError(400, 'No items are ticked "in package" on the Prizes tab.');
  const out = items.find(p => remaining(draft, p) <= 0);
  if (out) throw new HttpError(409, 'Full package not available: ' + out.name + ' is out of stock.');
  const v = resolveVisitor(draft, input);
  const group = 'g' + draft.nextDraw;
  const draws = items.map(p => recordDraw(draft, v, p, 'Package', group));
  return Object.assign({}, draws[0], { prizeName: 'Full package (' + items.map(p => p.name).join(', ') + ')' });
}

function setPrizes(draft, list) {
  if (!Array.isArray(list) || list.length > 30) throw new HttpError(400, 'Invalid prize list.');
  const seen = new Set();
  const next = list.map(p => {
    const name = clean(p && p.name, 40);
    if (!name) throw new HttpError(400, 'Every prize needs a name.');
    const total = Math.max(0, Math.min(99999, parseInt(p && p.total, 10) || 0));
    let id = p && typeof p.id === 'string' && /^p\d+$/.test(p.id) && draft.prizes.some(q => q.id === p.id) ? p.id : null;
    if (!id || seen.has(id)) id = 'p' + draft.nextPrize++;
    seen.add(id);
    return { id, name, total, pkg: !!(p && p.pkg) };
  });
  draft.prizes = next;
}

function setConfig(draft, c) {
  if (c && (c.odds === 'stock' || c.odds === 'equal')) draft.config.odds = c.odds;
  if (c && typeof c.onePer === 'boolean') draft.config.onePer = c.onePer;
  if (c && typeof c.needReg === 'boolean') draft.config.needReg = c.needReg;
}

const csvCell = v => {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;           // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
function toCsv(rows) { return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

function attendanceCsv(state) {
  return toCsv([['Ticket', 'Timestamp', 'Name', 'Phone', 'Email', 'Company', 'Source']].concat(
    state.attendees.map(a => [a.ticket, a.ts, a.name, a.phone, a.email || '', a.company, a.source])));
}
function drawsCsv(state) {
  return toCsv([['No', 'Timestamp', 'Ticket', 'Name', 'Prize', 'How']].concat(
    state.draws.map((d, i) => [i + 1, d.ts, d.ticket, d.name, d.prizeName, d.how || 'Wheel'])));
}

module.exports = { HttpError, ticketCandidates, remaining, segments, pickIndex, register, staffCheckin, spin, give, setPrizes, setConfig, attendanceCsv, drawsCsv, digits, clean };

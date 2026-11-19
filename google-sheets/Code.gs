/** @OnlyCurrentDoc */
/**
 * Booth app -> Google Sheet.
 * Paste this whole file into your sheet (Extensions > Apps Script), set SECRET below to the same value as
 * SHEETS_SECRET on Railway, then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 *
 * The app owns these tabs: Summary (fully rewritten), Attendees columns A-F and Draws columns A-E.
 * Columns you add to the right of those (G onward in Attendees, F onward in Draws) are never touched.
 */
const SECRET = 'PASTE-THE-SECRET-HERE';

function doGet() {
  return reply({ ok: true, message: 'Booth sheet script is running.' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (SECRET === 'PASTE-THE-SECRET-HERE' || body.secret !== SECRET) {
      return reply({ ok: false, error: 'Wrong secret: SECRET in the Apps Script must match SHEETS_SECRET on Railway.' });
    }
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      writeTable(ss, 'Attendees', ['Ticket', 'Signed up', 'Name', 'Phone', 'Company', 'Source'], body.attendees, [1, 4], 2);
      writeTable(ss, 'Draws', ['No', 'Time', 'Ticket', 'Name', 'Prize'], body.draws, [3], 2);
      writeSummary(ss, body);
    } finally {
      lock.releaseLock();
    }
    return reply({ ok: true, attendees: body.attendees.length, draws: body.draws.length });
  } catch (err) {
    return reply({ ok: false, error: String((err && err.message) || err) });
  }
}

/** Rewrites the app's columns of one tab. textCols keep leading zeros and "+62"; timeCol becomes a real date. */
function writeTable(ss, name, headers, rows, textCols, timeCol) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  const w = headers.length;
  sh.getRange(1, 1, 1, w).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, w).clearContent();
  if (!rows.length) return;
  textCols.forEach(c => sh.getRange(2, c, rows.length, 1).setNumberFormat('@'));
  sh.getRange(2, timeCol, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  const values = rows.map(r => r.map((v, i) => {
    const col = i + 1;
    if (col === timeCol) return new Date(v);
    return textCols.indexOf(col) >= 0 ? String(v) : safe(v);
  }));
  sh.getRange(2, 1, rows.length, w).setValues(values);
}

function writeSummary(ss, b) {
  const sh = ss.getSheetByName('Summary') || ss.insertSheet('Summary', 0);
  sh.clearContents();
  const qr = b.attendees.filter(r => r[5] === 'QR').length;
  const top = [
    ['Event', safe(b.event)],
    ['Last updated', new Date(b.updatedAt)],
    ['Total attendees', b.attendees.length],
    ['QR sign-ups', qr],
    ['Staff check-ins', b.attendees.length - qr],
    ['Walk-by tally (no sign-up)', b.tally],
    ['Prizes given', b.draws.length]
  ];
  sh.getRange(1, 1, top.length, 2).setValues(top);
  sh.getRange(2, 2).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sh.getRange(1, 1, top.length, 1).setFontWeight('bold');
  const start = top.length + 2;
  const prizes = [['Prize', 'Stock', 'Given', 'Left']].concat(b.prizes.map(p => [safe(p[0]), p[1], p[2], Math.max(0, p[1] - p[2])]));
  sh.getRange(start, 1, prizes.length, 4).setValues(prizes);
  sh.getRange(start, 1, 1, 4).setFontWeight('bold');
  sh.autoResizeColumns(1, 4);
}

/** Stops visitor-typed text such as "=HYPERLINK(...)" from becoming a formula. */
function safe(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

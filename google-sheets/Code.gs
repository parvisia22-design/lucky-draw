/** @OnlyCurrentDoc */
/**
 * Booth app -> Google Sheet.
 * Paste this whole file into your sheet (Extensions > Apps Script), set SECRET below to the same value as
 * SHEETS_SECRET on Railway, then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 * After changing this code: Deploy > Manage deployments > Edit > Version: New version > Deploy (the URL stays the same).
 *
 * The app sends its own column layout, so this script does not need editing when the app adds a column.
 * The app owns the Summary tab (fully rewritten) and the first columns of Attendees and Draws.
 * Columns you add to the right of the app's columns are never touched.
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
    if (!Array.isArray(body.tables)) {
      return reply({ ok: false, error: 'The Apps Script is out of date: paste the latest google-sheets/Code.gs and deploy a new version.' });
    }
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      body.tables.forEach(t => writeTable(ss, t));
      writeSummary(ss, body);
    } finally {
      lock.releaseLock();
    }
    return reply({ ok: true, rows: body.tables.map(t => t.rows.length) });
  } catch (err) {
    return reply({ ok: false, error: String((err && err.message) || err) });
  }
}

/** Rewrites the app's columns of one tab. t.text columns keep leading zeros and "+62"; t.time becomes a real date. */
function writeTable(ss, t) {
  const sh = ss.getSheetByName(t.name) || ss.insertSheet(t.name);
  const w = t.headers.length, n = t.rows.length;
  sh.getRange(1, 1, 1, w).setValues([t.headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, w).clearContent();
  if (!n) return;
  t.text.forEach(c => sh.getRange(2, c, n, 1).setNumberFormat('@'));
  sh.getRange(2, t.time, n, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  const values = t.rows.map(r => r.map((v, i) => {
    const col = i + 1;
    if (col === t.time) return new Date(v);
    return t.text.indexOf(col) >= 0 ? String(v) : safe(v);
  }));
  sh.getRange(2, 1, n, w).setValues(values);
}

function writeSummary(ss, b) {
  const sh = ss.getSheetByName('Summary') || ss.insertSheet('Summary', 0);
  sh.clearContents();
  const top = [['Event', safe(b.event)], ['Last updated', new Date(b.updatedAt)]].concat(b.summary);
  sh.getRange(1, 1, top.length, 2).setValues(top);
  sh.getRange(2, 2).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sh.getRange(1, 1, top.length, 1).setFontWeight('bold');
  const start = top.length + 2;
  const prizes = [['Prize', 'Stock', 'Given', 'Left']].concat(b.prizes.map(p => [safe(p[0]), p[1], p[2], p[3]]));
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

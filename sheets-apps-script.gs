// TalentSafari — leads logger (Google Apps Script).
// Bind to the target Google Sheet: Extensions → Apps Script → paste → Deploy as
// Web App (Execute as: Me; Who has access: Anyone). Copy the /exec URL and set it
// as the Lua agent env var SHEETS_WEBHOOK_URL.
//
// Contract (POST JSON):
//   { action:'append', name, title, company, email, date, roleEvaluated, score,
//     ctaClicked, verdict, recommendedCta, jd, analysis }
//   { action:'updateCta', email, ctaClicked }   // ctaClicked: 'Lua' | 'Talent Safari'
//
// Columns: Name · Title · Company · Email · Date · Role Evaluated · Score · CTA Clicked
//          · Verdict · Recommended CTA · JD · Analysis
// CTA Clicked starts 'No' on append, flips to 'Lua'/'Talent Safari' on updateCta
// (matched by email, last matching row wins).

const HEADERS = ['Name', 'Title', 'Company', 'Email', 'Date', 'Role Evaluated', 'Score', 'CTA Clicked', 'Verdict', 'Recommended CTA', 'JD', 'Analysis'];
const EMAIL_COL = 4; // 1-based column index of "Email"
const CTA_COL = 8;   // 1-based column index of "CTA Clicked"

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    ensureHeaders_(sheet);

    if (body.action === 'append') {
      sheet.appendRow([
        body.name || '',
        body.title || '',
        body.company || '',
        body.email || '',
        body.date ? new Date(body.date) : new Date(),
        body.roleEvaluated || '',
        body.score != null ? body.score : '',
        body.ctaClicked || 'No',
        body.verdict || '',
        body.recommendedCta || '',
        body.jd || '',
        body.analysis || '',
      ]);
      return json_({ ok: true, action: 'append' });
    }

    if (body.action === 'updateCta') {
      const row = findLastRowByEmail_(sheet, body.email);
      if (row > 0) {
        sheet.getRange(row, CTA_COL).setValue(body.ctaClicked || body.ctaPath || 'No');
        return json_({ ok: true, action: 'updateCta', row: row });
      }
      return json_({ ok: false, reason: 'email_not_found' });
    }

    return json_({ ok: false, reason: 'unknown_action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
}

function findLastRowByEmail_(sheet, email) {
  if (!email) return -1;
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const values = sheet.getRange(2, EMAIL_COL, last - 1, 1).getValues();
  for (let i = values.length - 1; i >= 0; i--) { // last match wins
    if (String(values[i][0]).trim().toLowerCase() === email.trim().toLowerCase()) {
      return i + 2; // back to sheet row index
    }
  }
  return -1;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

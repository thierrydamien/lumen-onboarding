/**
 * Lumen onboarding -> Google Sheet (Apps Script Web App).
 *
 * WHY: this runs as YOUR Google account (like the survey script), so it can create
 * files in the Proserv folder on your quota. No service account / OAuth / domain-
 * wide delegation needed. The Netlify `sheet.js` function POSTs the brief here.
 *
 * DEPLOY:
 *   1. script.google.com > New project. Paste this file in.
 *   2. Editor > Services (+) > add "Drive API" (advanced service; used for the
 *      XLSX -> Google Sheet conversion below).
 *   3. Project Settings > Script Properties > add SHARED_SECRET = <a long random
 *      string>. Put the SAME value in Netlify env APPS_SCRIPT_SECRET.
 *   4. Deploy > New deployment > type Web app. Execute as: Me. Who has access:
 *      Anyone. Copy the /exec URL into Netlify env APPS_SCRIPT_WEBAPP_URL.
 *
 * SECURITY: "Anyone" means anyone with the URL can invoke it, so every request is
 * rejected unless it carries the shared secret. Keep the URL + secret server-side
 * (they live in Netlify env; the browser never sees them). Do NOT hardcode secrets
 * here — use Script Properties.
 */

// Destination folder (same one the survey script writes to).
const DEST_FOLDER_ID = "1BacQuILUAGSKcuUzEwY-iVCh37gt72rY";

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");

    const expected = PropertiesService.getScriptProperties().getProperty("SHARED_SECRET");
    if (!expected || body.secret !== expected) return json_({ error: "unauthorized" });
    if (!body.xlsxBase64) return json_({ error: "missing_xlsx" });

    const name = String(body.filename || "Lumen Setup Brief").replace(/\.xlsx$/i, "");
    const blob = Utilities.newBlob(
      Utilities.base64Decode(body.xlsxBase64),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      name + ".xlsx"
    );

    // Convert the uploaded XLSX into a native Google Sheet inside the folder.
    const file = Drive.Files.insert(
      { title: name, mimeType: "application/vnd.google-apps.spreadsheet", parents: [{ id: DEST_FOLDER_ID }] },
      blob,
      { convert: true, supportsAllDrives: true }
    );

    // Share with the client as editor (this sends them a Google notification email).
    if (body.clientEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.clientEmail)) {
      try { DriveApp.getFileById(file.id).addEditor(body.clientEmail); } catch (err) { /* non-fatal */ }
    }

    return json_({ url: "https://docs.google.com/spreadsheets/d/" + file.id + "/edit" });
  } catch (err) {
    return json_({ error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

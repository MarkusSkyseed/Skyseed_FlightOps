/**
 * Google Apps Script Web App für UAS Wetter-App
 * Speichert Daten in Google Sheets und erstellt PDFs in Google Drive.
 */

const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE'; // Hier ID der Google Tabelle einfügen
const FOLDER_ID = 'YOUR_FOLDER_ID_HERE'; // Hier ID des Zielordners für PDFs einfügen

function doPost(e) {
    try {
        const data = JSON.parse(e.postData.contents);
        const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
        const sheet = ss.getSheets()[0]; // Erstes Blatt nutzen

        // Daten in Tabelle schreiben
        sheet.appendRow([
            new Date(),
            data.project,
            data.area,
            data.copter,
            data.date,
            data.customer,
            data.location,
            data.flights,
            data.totalTime,
            data.operation,
            data.weather
        ]);

        // PDF Generieren
        createLogPdf(data);

        return ContentService.createTextOutput("Success").setMimeType(ContentService.MimeType.TEXT);
    } catch (err) {
        return ContentService.createTextOutput("Error: " + err.toString()).setMimeType(ContentService.MimeType.TEXT);
    }
}

function createLogPdf(data) {
    const folder = DriveApp.getFolderById(FOLDER_ID);
    const fileName = `Logbuch_${data.project || 'UAS'}_${data.date}.html`;

    // Einfaches HTML Template für das PDF
    const htmlRows = Object.entries(data)
        .filter(([key]) => key !== 'signature')
        .map(([key, val]) => `<tr><td><strong>${key}</strong></td><td>${val}</td></tr>`)
        .join('');

    const htmlContent = `
    <html>
      <body style="font-family: Arial, sans-serif;">
        <h1>Technisches Logbuch</h1>
        <h3>Projekt: ${data.project} ${data.area ? '(' + data.area + ')' : ''}</h3>
        <table border="1" style="width: 100%; border-collapse: collapse;">
          ${htmlRows}
        </table>
        <h4>Unterschrift:</h4>
        <img src="${data.signature}" style="max-width: 300px; border-bottom: 1px solid black;">
      </body>
    </html>
  `;

    const blob = Utilities.newBlob(htmlContent, 'text/html', fileName);
    const file = folder.createFile(blob);

    // In PDF konvertieren (optional, Google Drive macht das intern oft über Dokumente)
    // Hier eine einfache Version als HTML-Datei, die als PDF gedruckt werden kann.
}

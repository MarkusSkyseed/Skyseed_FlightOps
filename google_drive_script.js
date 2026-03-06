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
        
        // Tabellenblatt nach Copter-Namen wählen oder erstellen
        const sheetName = data.copter || "Unbekannter Copter";
        let sheet = ss.getSheetByName(sheetName);
        if (!sheet) {
            sheet = ss.insertSheet(sheetName);
            // Header setzen für neues Blatt
            sheet.appendRow([
                "ID", "Kunde", "Ort", "Datum", "Aufbau Checkliste", "Abbau Checkliste", 
                "Anz. Flüge", "Flugzeit in Minuten", "RPIC1", "RPIC2", 
                "Besondere Betriebsform", "Wetter", "Besondere Ereignisse", 
                "Reparaturen", "Sonstiges", "Eingetragen von", "Technical_ID"
            ]);
        }

        // Dublettenprüfung anhand der technischen App-ID (Spalte 17 / Q)
        if (data.id) {
            const lastRow = sheet.getLastRow();
            if (lastRow > 1) {
                // Die letzten 20 Einträge prüfen reicht meistens aus und ist performanter
                const startRow = Math.max(2, lastRow - 20);
                const checkRange = sheet.getRange(startRow, 17, (lastRow - startRow + 1), 1).getValues();
                for (let i = 0; i < checkRange.length; i++) {
                    if (checkRange[i][0] === data.id) {
                        return ContentService.createTextOutput("Duplicate").setMimeType(ContentService.MimeType.TEXT);
                    }
                }
            }
        }
        
        // Fortlaufende ID berechnen (Spalte 1 / A)
        const lastRow = sheet.getLastRow();
        let nextId = 1;
        if (lastRow > 1) {
            const lastIdValue = sheet.getRange(lastRow, 1).getValue();
            if (!isNaN(lastIdValue)) {
                nextId = Number(lastIdValue) + 1;
            }
        }

        // Daten vorbereiten
        const rowData = [
            nextId,                      // ID (fortlaufend)
            data.customer,               // Kunde
            data.location,               // Ort
            data.date,                   // Datum
            data.setupTime,              // Aufbau Checkliste
            data.teardownTime,           // Abbau Checkliste
            Number(data.flights) || 0,   // Anz. Flüge
            Number(data.totalTime) || 0, // Flugzeit in Minuten
            data.rpic1,                  // RPIC1
            data.rpic2,                  // RPIC2
            data.operation,              // Besondere Betriebsform
            data.weather,                // Wetter
            data.events,                 // Besondere Ereignisse
            data.reactions,              // Reparaturen
            data.misc,                   // Sonstiges
            "Ops_App",                   // Eingetragen von
            data.id                      // Technical_ID (für Dublettenprüfung)
        ];

        // In nächste freie Zeile schreiben
        sheet.appendRow(rowData);

        // PDF / Screenshot Generieren
        if (data.screenshot) {
            saveScreenshot(data);
        } else {
            createLogPdf(data);
        }

        return ContentService.createTextOutput("Success").setMimeType(ContentService.MimeType.TEXT);
    } catch (err) {
        return ContentService.createTextOutput("Error: " + err.toString()).setMimeType(ContentService.MimeType.TEXT);
    }
}

function saveScreenshot(data) {
    const folder = DriveApp.getFolderById(FOLDER_ID);
    
    // Dateiname sicher machen (Format: YYYY_MM_DD_Project_Customer_Location)
    const safeDate = (data.date || '').replace(/-/g, '_');
    const safeProject = (data.project || 'UAS').replace(/[^a-zA-Z0-9]/g, '_');
    const safeCustomer = (data.customer || 'Unbekannt').replace(/[^a-zA-Z0-9]/g, '_');
    const safeLocation = (data.location || 'Unbekannt').replace(/[^a-zA-Z0-9]/g, '_');
    
    const fileName = `${safeDate}_${safeProject}_${safeCustomer}_${safeLocation}.png`;

    // Base64 String bereinigen (Data-URL Header entfernen falls vorhanden)
    let base64Data = data.screenshot;
    if (base64Data.indexOf(',') > -1) {
        base64Data = base64Data.split(',')[1];
    }

    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), 'image/png', fileName);
    folder.createFile(blob);
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

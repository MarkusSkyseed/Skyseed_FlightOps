const APP_VERSION = "1.1.0";

// --- Defaults & Thresholds ---
const defaultThresholds = {
    condition: {
        type: 'categorical',
        mapping: {
            'clear-day': 'green', 'clear-night': 'green', 'partly-cloudy-day': 'green', 'partly-cloudy-night': 'green',
            'cloudy': 'green', 'fog': 'yellow', 'wind': 'yellow', 'rain': 'red',
            'sleet': 'red', 'snow': 'red', 'hail': 'red', 'thunderstorm': 'red'
        }
    },
    temperature: {
        greenMin: 5, greenMax: 35,
        yellowMin: 0, yellowMax: 40,
        unit: '°C'
    },
    wind: {
        greenMin: 0, greenMax: 20,
        yellowMin: 0, yellowMax: 35,
        unit: 'km/h'
    },
    gusts: { // Böen
        greenMin: 0, greenMax: 30,
        yellowMin: 0, yellowMax: 45,
        unit: 'km/h'
    },
    precipitation: { // Niederschlag
        greenMin: 0, greenMax: 0, // Nur bei null Regen grün
        yellowMin: 0, yellowMax: 1, // Leichter Nieselregen ist gelb
        unit: 'mm'
    },
    visibility: { // Sichtweite
        greenMin: 5, greenMax: 100, // Alles über 5km ist gut
        yellowMin: 2, yellowMax: 100, // Zwischen 2-5km gelb
        unit: 'km'
    },
    cloud_cover: { // Bewölkung
        greenMin: 0, greenMax: 70,
        yellowMin: 0, yellowMax: 90,
        unit: '%'
    },
    pressure: { // Luftdruck
        greenMin: 980, greenMax: 1050,
        yellowMin: 950, yellowMax: 1080,
        unit: 'hPa'
    },
    solar: { // Sonneneinstrahlung
        greenMin: 0, greenMax: 1000,
        yellowMin: 0, yellowMax: 1200,
        unit: 'W/m²'
    }
};

let userThresholds = JSON.parse(localStorage.getItem('uavThresholds')) || defaultThresholds;
// Ensure new properties from updates exist in userThresholds
if (!userThresholds.condition) userThresholds.condition = defaultThresholds.condition;
if (!userThresholds.solar) userThresholds.solar = defaultThresholds.solar;

let currentWeatherData = null;
let currentCoords = { lat: 0, lon: 0 };
let currentCityName = "Unbekannt";

// --- App Initialization ---
async function initApp() {
    updateLocationText("Standort wird gesucht...");
    document.querySelector('.app-version').innerText = `App Version: ${APP_VERSION}`;

    if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const lat = position.coords.latitude;
                const lon = position.coords.longitude;
                currentCoords = { lat, lon };
                fetchLocationName(lat, lon);
                fetchWeatherData(lat, lon);
            },
            (error) => {
                console.error("Geolokation Fehler:", error);
                let errMsg = "Standort konnte nicht ermittelt werden.";
                if (error.code === 1) errMsg = "Bitte erlaube den Standortzugriff im Browser.";
                updateLocationText(errMsg);
            }
        );
    } else {
        updateLocationText("Dein Browser unterstützt keine Standorterfassung.");
    }
}

async function fetchLocationName(lat, lon) {
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
        const data = await response.json();
        const city = data.address.city || data.address.town || data.address.village || data.address.county || "Unbekannter Ort";
        currentCityName = city;
        updateLocationText(city);
    } catch (e) {
        currentCityName = "Standort";
        updateLocationText(`${lat.toFixed(2)}, ${lon.toFixed(2)}`);
    }
}

function updateLocationText(text) {
    document.getElementById('locationText').innerText = text;
}

function updateMetadata() {
    const coordsEl = document.getElementById('geoCoords');
    const timeEl = document.getElementById('dateTime');

    if (coordsEl) {
        const lat = currentCoords.lat;
        const lon = currentCoords.lon;
        const latDir = lat >= 0 ? 'N' : 'S';
        const lonDir = lon >= 0 ? 'E' : 'W';
        coordsEl.innerText = `GPS: ${Math.abs(lat).toFixed(4)}° ${latDir}, ${Math.abs(lon).toFixed(4)}° ${lonDir}`;
    }

    if (timeEl) {
        const now = new Date();
        const formattedDate = now.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
        const formattedTime = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        timeEl.innerText = `Log vom: ${formattedDate}, ${formattedTime} Uhr`;
    }
}

// --- Reverse Geocoding ---
async function fetchLocationName(lat, lon) {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
        const response = await fetch(url, {
            headers: { 'Accept-Language': 'de-DE,de' }
        });
        const data = await response.json();
        const city = data.address.city || data.address.town || data.address.village || data.address.suburb || data.address.county || "Dein Standort";
        currentCityName = city;
        updateLocationText(city);
    } catch (e) {
        console.error('Fehler beim Abrufen des Ortsnamens:', e);
        currentCityName = "Standort";
        updateLocationText(`${lat.toFixed(2)}, ${lon.toFixed(2)}`);
    }
}

// --- Fetch Weather ---
async function fetchWeatherData(lat, lon) {
    const apiUrl = `https://api.brightsky.dev/current_weather?lat=${lat}&lon=${lon}`;
    try {
        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        currentWeatherData = data.weather;
        updateMetadata();
        renderApp(currentWeatherData);
    } catch (error) {
        console.error("Fehler beim Abrufen der Wetterdaten:", error);
        document.getElementById('weatherGrid').innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; color: var(--danger-color);">
                Fehler beim Laden der API.
            </div>
        `;
        document.getElementById('statusBanner').className = "status-banner danger";
        document.getElementById('statusBanner').innerHTML = "<h2>Fehler</h2><p>Daten konnten nicht geladen werden.</p>";
    }
}

// --- Color Evaluation Logic ---
function evaluateMetric(metricKey, value) {
    if (value === null || value === undefined) return 'neutral';

    const th = userThresholds[metricKey];
    if (!th) return 'neutral';

    if (th.type === 'categorical') {
        // value is the string condition name (e.g. 'clear-day')
        return th.mapping[value] || 'neutral';
    }

    let greenOk = false;
    let yellowOk = false;

    // We only care about boundaries if they are set (e.g., greenMin !== null)
    const gMin = th.greenMin !== null && th.greenMin !== "" ? th.greenMin : -Infinity;
    const gMax = th.greenMax !== null && th.greenMax !== "" ? th.greenMax : Infinity;
    const yMin = th.yellowMin !== null && th.yellowMin !== "" ? th.yellowMin : -Infinity;
    const yMax = th.yellowMax !== null && th.yellowMax !== "" ? th.yellowMax : Infinity;

    if (value >= gMin && value <= gMax) greenOk = true;
    if (value >= yMin && value <= yMax) yellowOk = true;

    if (greenOk) return 'green';
    if (yellowOk) return 'yellow';
    return 'red';
}

// --- Icons & Text ---
const conditionTranslations = {
    'clear-day': 'Sonnig', 'clear-night': 'Klar', 'partly-cloudy-day': 'Heiter', 'partly-cloudy-night': 'Teils wolkig',
    'cloudy': 'Bewölkt', 'fog': 'Nebel', 'wind': 'Windig', 'rain': 'Regen',
    'sleet': 'Schneeregen', 'snow': 'Schnee', 'hail': 'Hagel', 'thunderstorm': 'Gewitter'
};

function translateCondition(iconName) {
    return conditionTranslations[iconName] || iconName;
}

const weatherIcons = {
    'clear-day': '☀️', 'clear-night': '🌙', 'partly-cloudy-day': '⛅', 'partly-cloudy-night': '☁️',
    'cloudy': '☁️', 'fog': '🌫️', 'wind': '💨', 'rain': '🌧️', 'sleet': '🌨️', 'snow': '❄️', 'hail': '🧊', 'thunderstorm': '⛈️'
};

function getIcon(iconName) {
    return weatherIcons[iconName] || '🌡️';
}

function getCompassDirection(degrees) {
    if (degrees === null || degrees === undefined) return "-";
    const dirs = ["N", "NNO", "NO", "ONO", "O", "OSO", "SO", "SSO", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return dirs[Math.round(degrees / 22.5) % 16];
}

// --- Render Logic ---
function renderApp(weather) {
    const grid = document.getElementById('weatherGrid');
    const precipitation = weather.precipitation_60 || weather.precipitation_30 || weather.precipitation_10 || 0;
    const solarRad = weather.solar_60 || weather.solar_30 || weather.solar_10 || 0;

    const tilesData = [
        {
            key: 'condition', title: 'Wetterlage', icon: getIcon(weather.icon),
            value: translateCondition(weather.icon), rawValue: weather.icon, unit: ''
        },
        {
            key: 'temperature', title: 'Temperatur', icon: '🌡️',
            value: weather.temperature, rawValue: weather.temperature, unit: '°C'
        },
        {
            key: 'wind', title: 'Wind', icon: '💨',
            value: weather.wind_speed_10, rawValue: weather.wind_speed_10, unit: 'km/h',
            extraHtml: weather.wind_direction_10 != null ? `<div style="font-size: 1rem; margin-top:0.2rem; transform: rotate(${weather.wind_direction_10}deg); display:inline-block;" title="${getCompassDirection(weather.wind_direction_10)}">⬆️</div>` : ''
        },
        {
            key: 'gusts', title: 'Böen', icon: '🌪️',
            value: weather.wind_gust_speed_10 || weather.wind_speed_10, rawValue: weather.wind_gust_speed_10 || weather.wind_speed_10, unit: 'km/h'
        },
        // Replaced Wind Direction with Solar Radiation
        {
            key: 'solar', title: 'Solar Rad.', icon: '🌞',
            value: solarRad, rawValue: solarRad, unit: 'W/m²'
        },
        {
            key: 'precipitation', title: 'Niederschlag', icon: '🌧️',
            value: precipitation, rawValue: precipitation, unit: 'mm'
        },
        {
            key: 'visibility', title: 'Sichtweite', icon: '👁️',
            value: Math.round(weather.visibility / 1000), rawValue: Math.round(weather.visibility / 1000), unit: 'km'
        },
        {
            key: 'cloud_cover', title: 'Bewölkung', icon: '☁️',
            value: weather.cloud_cover, rawValue: weather.cloud_cover, unit: '%'
        },
        {
            key: 'pressure', title: 'Luftdruck', icon: '⏲️',
            value: weather.pressure_msl, rawValue: weather.pressure_msl, unit: 'hPa'
        }
    ];

    grid.innerHTML = '';
    let hasRed = false;
    let hasYellow = false;

    // Track precipitation for banner text
    const isRaining = evaluateMetric('precipitation', precipitation) === 'red';

    tilesData.forEach(tile => {
        const valToEval = tile.rawValue !== undefined ? tile.rawValue : tile.value;
        const status = evaluateMetric(tile.key, valToEval);
        if (status === 'red') hasRed = true;
        if (status === 'yellow') hasYellow = true;

        const tileEl = document.createElement('div');
        tileEl.className = `tile ${status !== 'neutral' ? 'status-' + status : ''}`;

        let valueHtml = tile.unit ?
            `<div class="value">${tile.value}<span class="unit">${tile.unit}</span> ${tile.extraHtml || ''}</div>` :
            `<div class="value" style="font-size: 1.5rem;">${tile.value}</div>`;

        let configBtnHtml = '';
        if (status !== 'neutral' && userThresholds[tile.key]) {
            tileEl.style.cursor = 'pointer';
            tileEl.onclick = () => openConfigModal(tile.key, tile.title);
            configBtnHtml = `<div style="font-size: 0.7rem; opacity: 0.5; margin-top: 5px;">⚙️ Anpassen</div>`;
        }

        tileEl.innerHTML = `
            <div class="icon">${tile.icon}</div>
            <div class="title">${tile.title}</div>
            ${valueHtml}
            ${configBtnHtml}
        `;
        grid.appendChild(tileEl);
    });

    updateBanner(hasRed, hasYellow, isRaining);
}

function updateBanner(hasRed, hasYellow, isRaining) {
    const banner = document.getElementById('statusBanner');
    if (hasRed) {
        banner.className = 'status-banner danger';
        banner.innerHTML = `<h2>Nicht Fliegen / Wetter Prüfen</h2><p>${isRaining ? "Es regnet oder regnet bald." : "Mindestens ein Wert ist im roten Bereich."}</p>`;
    } else if (hasYellow) {
        banner.className = 'status-banner warning';
        banner.innerHTML = '<h2>Flug mit Vorsicht</h2><p>Einige Werte erfordern Aufmerksamkeit.</p>';
    } else {
        banner.className = 'status-banner good';
        banner.innerHTML = '<h2>Gut Um Zu Fliegen</h2><p>Alle Bedingungen sind optimal.</p>';
    }
}

// --- Configuration Modal ---
let currentConfigKey = null;
const modal = document.getElementById('configModal');
const form = document.getElementById('configForm');

function openConfigModal(metricKey, title) {
    currentConfigKey = metricKey;
    const th = userThresholds[metricKey];

    document.getElementById('modalTitle').innerText = `Schwellenwerte anpassen`;
    document.getElementById('modalMetricName').innerText = title;

    // Remove any previous categorical UI
    const existingCat = document.getElementById('categoricalConfigWrapper');
    if (existingCat) existingCat.remove();

    const inputGroups = form.querySelectorAll('.input-group');

    if (th.type === 'categorical') {
        // Hide numerical inputs
        inputGroups.forEach(ig => ig.style.display = 'none');
        document.querySelector('.hint').style.display = 'none';

        // Generate categorical UI
        const catWrapper = document.createElement('div');
        catWrapper.id = 'categoricalConfigWrapper';
        catWrapper.className = 'categorical-options';

        Object.keys(conditionTranslations).forEach(conditionKey => {
            const currentStatus = th.mapping[conditionKey] || 'neutral';

            const optionDiv = document.createElement('div');
            optionDiv.className = 'cat-option';

            const nameSpan = document.createElement('span');
            nameSpan.innerText = conditionTranslations[conditionKey];

            const radiosDiv = document.createElement('div');
            radiosDiv.className = 'cat-radios';

            ['green', 'yellow', 'red'].forEach(color => {
                const id = `cat_${conditionKey}_${color}`;
                radiosDiv.innerHTML += `
                    <label>
                        <input type="radio" name="cat_${conditionKey}" value="${color}" ${currentStatus === color ? 'checked' : ''}>
                        <span class="dot ${color}" style="margin:0; width:10px; height:10px; display:inline-block; border-radius:50%; ${color === 'red' ? 'background:var(--danger-color);' : ''}"></span>
                    </label>
                `;
            });

            optionDiv.appendChild(nameSpan);
            optionDiv.appendChild(radiosDiv);
            catWrapper.appendChild(optionDiv);
        });

        // Insert before modal actions
        document.querySelector('.modal-actions').parentNode.insertBefore(catWrapper, document.querySelector('.modal-actions'));

    } else {
        // Show numerical inputs
        inputGroups.forEach(ig => ig.style.display = 'block');
        document.querySelector('.hint').style.display = 'block';

        // Load current threshold values into modal
        document.getElementById('greenMin').value = th.greenMin !== null ? th.greenMin : "";
        document.getElementById('greenMax').value = th.greenMax !== null ? th.greenMax : "";
        document.getElementById('yellowMin').value = th.yellowMin !== null ? th.yellowMin : "";
        document.getElementById('yellowMax').value = th.yellowMax !== null ? th.yellowMax : "";

        // Replace %UNIT% in labels
        const labels = form.querySelectorAll('.input-group label');
        labels[0].innerHTML = `<span class="dot green"></span> Grün (${th.unit}):`;
        labels[1].innerHTML = `<span class="dot yellow"></span> Gelb (${th.unit}):`;
    }

    modal.showModal();
}

form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!currentConfigKey) return;

    if (userThresholds[currentConfigKey].type === 'categorical') {
        const catMapping = {};
        Object.keys(conditionTranslations).forEach(conditionKey => {
            const selected = document.querySelector(`input[name="cat_${conditionKey}"]:checked`);
            if (selected) {
                catMapping[conditionKey] = selected.value;
            }
        });
        userThresholds[currentConfigKey].mapping = catMapping;
    } else {
        const parseNum = (val) => val === "" ? null : parseFloat(val);

        userThresholds[currentConfigKey] = {
            ...userThresholds[currentConfigKey],
            greenMin: parseNum(document.getElementById('greenMin').value),
            greenMax: parseNum(document.getElementById('greenMax').value),
            yellowMin: parseNum(document.getElementById('yellowMin').value),
            yellowMax: parseNum(document.getElementById('yellowMax').value),
        };
    }

    localStorage.setItem('uavThresholds', JSON.stringify(userThresholds));
    modal.close();

    // Re-evaluate limits immediately
    if (currentWeatherData) renderApp(currentWeatherData);
});

document.getElementById('cancelBtn').addEventListener('click', () => {
    modal.close();
});

// --- Refresh Button ---
document.getElementById('refreshBtn').addEventListener('click', () => {
    initApp();
});

// --- Export Logic ---
document.getElementById('exportBtn').addEventListener('click', async () => {
    const exportBtn = document.getElementById('exportBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const originalText = exportBtn.innerHTML;
    exportBtn.innerHTML = '⏳...';
    exportBtn.disabled = true;

    // Clear any text selection (prevents highlighted text in screenshot)
    window.getSelection().removeAllRanges();

    // Hide buttons for the screenshot
    exportBtn.style.display = 'none';
    refreshBtn.style.display = 'none';

    // Inject a temporary stylesheet that forces everything opaque for html2canvas.
    // This is the only reliable method because html2canvas cannot render:
    //   - backdrop-filter (glassmorphism)
    //   - CSS animations (elements stuck at opacity:0 initial state)
    //   - -webkit-background-clip: text (gradient titles)
    //   - rgba() backgrounds with low alpha
    const exportCSS = document.createElement('style');
    exportCSS.id = 'export-override';
    exportCSS.textContent = `
        /* Kill all animations and transitions */
        *, *::before, *::after {
            animation: none !important;
            transition: none !important;
        }

        /* Force tiles fully opaque with solid backgrounds */
        .tile {
            opacity: 1 !important;
            transform: none !important;
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
            background: #1e293b !important;
            border-color: rgba(255,255,255,0.15) !important;
        }

        /* Preserve status colors but make them opaque */
        /* Colors are rgba(x,y,z,0.2) blended over #0f172a */
        .tile.status-green {
            background: #133a34 !important;
            border-color: rgba(34, 197, 94, 0.5) !important;
        }
        .tile.status-yellow {
            background: #3b3623 !important;
            border-color: rgba(234, 179, 8, 0.5) !important;
        }
        .tile.status-red {
            background: #3c202f !important;
            border-color: rgba(239, 68, 68, 0.5) !important;
        }

        /* Fix gradient title - replace with solid white */
        header h1 {
            background: none !important;
            -webkit-background-clip: unset !important;
            -webkit-text-fill-color: #f8fafc !important;
            color: #f8fafc !important;
        }

        /* Force all text to be fully opaque */
        .title, .value, .unit, .icon, header p {
            opacity: 1 !important;
        }

        /* Status banner - make opaque */
        .status-banner.good {
            background: #133a34 !important;
            border-color: rgba(34, 197, 94, 0.5) !important;
        }
        .status-banner.warning {
            background: #3b3623 !important;
            border-color: rgba(234, 179, 8, 0.5) !important;
        }
        .status-banner.danger {
            background: #3c202f !important;
            border-color: rgba(239, 68, 68, 0.5) !important;
        }

        /* GPS badge */
        .gps-badge {
            background: #334155 !important;
        }
    `;
    document.head.appendChild(exportCSS);

    // Let the browser repaint with the new stylesheet
    await new Promise(resolve => setTimeout(resolve, 200));

    try {
        const appContainer = document.querySelector('.app-container');

        const canvas = await html2canvas(appContainer, {
            scale: 2,
            backgroundColor: '#0f172a',
            useCORS: true,
            allowTaint: true,
            logging: false,
        });

        // Filename: Wetter_Berlin_2026-02-27_12-30.png
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const timeStr = `${now.getHours().toString().padStart(2, '0')}-${now.getMinutes().toString().padStart(2, '0')}`;
        const cityNameSafe = currentCityName.replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `Wetter_${cityNameSafe}_${dateStr}_${timeStr}.png`;

        canvas.toBlob(async (blob) => {
            if (!blob) throw new Error("Canvas to Blob failed");

            const file = new File([blob], filename, { type: 'image/png' });

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({
                        files: [file],
                        title: 'UAV Flight Forecast',
                        text: `Aktuelle Flugbedingungen für ${currentCityName}`
                    });
                } catch (err) {
                    if (err.name !== 'AbortError') {
                        console.error('Share failed', err);
                        downloadBlob(blob, filename);
                    }
                }
            } else {
                downloadBlob(blob, filename);
            }
        }, 'image/png');

    } catch (e) {
        console.error("Fehler beim Exportieren", e);
        alert("Fehler beim Erstellen des Bildes: " + e.message);
    } finally {
        // Remove the temporary stylesheet — everything snaps back to normal
        const overrideSheet = document.getElementById('export-override');
        if (overrideSheet) overrideSheet.remove();

        // Restore buttons
        exportBtn.style.display = '';
        refreshBtn.style.display = '';
        exportBtn.innerHTML = originalText;
        exportBtn.disabled = false;
    }
});

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Start
initApp();

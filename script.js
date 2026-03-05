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

// --- Global Project State ---
let activeProject = {
    name: "Kein Projekt geladen",
    area: "",
    geofence: null // Array of [lat, lon]
};

// --- Map & Location State ---
let map, marker, permanentWms, notamWms, geofenceLayer;
let currentCoords = { lat: 0, lon: 0 }; // Browser Geolocation
let manualCoords = null;                // User Input
let activeCoords = { lat: 0, lon: 0 };  // Currently used for weather/ERP
let activeSource = "geolocation";       // 'geolocation', 'manual', 'polygon'
let currentCityName = "Unbekannt";
let isMapInitialized = false;

// --- App Initialization ---
// --- App Initialization ---
async function initApp() {
    updateLocationSourceBadge();
    updateProjectBanner();
    document.querySelector('.app-version').innerText = `App Version: ${APP_VERSION}`;

    if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                currentCoords = { lat: position.coords.latitude, lon: position.coords.longitude };
                if (activeSource === "geolocation") {
                    refreshAllData();
                }
            },
            (error) => {
                console.warn("Geolocation Error:", error);
                if (activeSource === "geolocation") {
                    updateLocationText("Standortzugriff erforderlich");
                }
            },
            { maximumAge: 15 * 60 * 1000 }
        );
    } else {
        updateLocationText("Browser unterstützt kein GPS");
    }

    // --- Service Worker Registration ---
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./service-worker.js')
                .then(reg => console.log('SW registered:', reg))
                .catch(err => console.error('SW registration failed:', err));
        });
    }

    initOfflineStorage();
    initSignaturePads();
    initPilotLogic();
}

function initPilotLogic() {
    const rpic1 = document.getElementById('lb_rpic1');
    const rpic2 = document.getElementById('lb_rpic2');
    const list2 = document.getElementById('pilot-list-2');
    const allPilots = ["Markus", "Daniel", "Raphael", "Leonard"];

    if (!rpic1 || !rpic2 || !list2) return;

    rpic1.addEventListener('input', () => {
        const val1 = rpic1.value.trim();
        if (val1) {
            rpic2.disabled = false;
            // Update list 2 to exclude val1
            list2.innerHTML = allPilots
                .filter(p => p !== val1)
                .map(p => `<option value="${p}">`)
                .join('');
        } else {
            rpic2.disabled = true;
            rpic2.value = "";
        }
    });
}

async function initOfflineStorage() {
    localforage.config({
        name: 'UAV_FlightForecast',
        storeName: 'offline_logs'
    });

    // Check for pending logs on startup
    checkPendingLogs();
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

// --- Fetch Orchestration ---
async function refreshAllData() {
    // 1. Determine active coordinates
    if (activeProject.geofence) {
        activeSource = "polygon";
        const center = calculateCentroid(activeProject.geofence);
        activeCoords = { lat: center.lat, lon: center.lng };
    } else if (manualCoords) {
        activeSource = "manual";
        activeCoords = manualCoords;
    } else if (currentCoords.lat !== 0) {
        activeSource = "geolocation";
        activeCoords = currentCoords;
    } else {
        return; // Wait for location
    }

    updateLocationSourceBadge();
    updateMap(activeCoords.lat, activeCoords.lon);
    fetchLocationName(activeCoords.lat, activeCoords.lon);

    // 2. Fetch all data in parallel
    const lat = activeCoords.lat;
    const lon = activeCoords.lon;

    const pWeather = fetch(`https://api.brightsky.dev/current_weather?lat=${lat}&lon=${lon}`).then(r => r.json());
    const pAlerts = fetch(`https://api.brightsky.dev/alerts?lat=${lat}&lon=${lon}`).then(r => r.json()).catch(() => ({ alerts: [] }));
    const pKp = fetchKpIndex();

    // Trigger ERP search proactively
    initErpData();

    // For dipul: use multipoint check for polygons
    let pDipul;
    if (activeSource === "polygon" && activeProject.geofence) {
        // Sample points: centroid + all corners
        const points = [
            calculateCentroid(activeProject.geofence)
        ];
        // Add all polygon points (if not too many) or at least the corners
        activeProject.geofence.forEach(pt => {
            points.push({ lat: pt[0], lon: pt[1] });
        });
        pDipul = fetchDipulMultiPoints(points);
    } else {
        pDipul = fetchDipulData(activeCoords, 'point');
    }

    try {
        const [weatherData, alertsData, kpIndex, dipulData] = await Promise.all([pWeather, pAlerts, pKp, pDipul]);
        currentWeatherData = weatherData.weather;
        const alerts = alertsData.alerts || [];
        updateMetadata();
        renderApp(currentWeatherData, kpIndex, dipulData, alerts);
    } catch (error) {
        console.error("Data Load Error:", error);
        document.getElementById('flight-status').className = "status-banner danger";
        document.getElementById('flight-status').innerHTML = "<h2>Fehler</h2><p>Daten konnten nicht geladen werden.</p>";
    }
}

async function fetchKpIndex() {
    try {
        const res = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
        const data = await res.json();
        // data[0] is header, take the last entry [timestamp, value]
        if (data && data.length > 1) {
            return parseFloat(data[data.length - 1][1]);
        }
    } catch (e) { console.warn("Kp fetch failed", e); }
    return null;
}

function updateLocationSourceBadge() {
    const label = document.getElementById('locationSourceLabel');
    if (!label) return;

    switch (activeSource) {
        case 'polygon':
            label.innerText = `Basis: .plan Projekt-Zentrum (${activeProject.name})`;
            label.style.color = "var(--accent-color)";
            break;
        case 'manual':
            label.innerText = `Basis: Manuelle GPS Koordinaten`;
            label.style.color = "var(--warning-color)";
            break;
        default:
            label.innerText = `Basis: Dein aktueller Standort (Browser)`;
            label.style.color = "var(--text-secondary)";
    }
}

// --- Fetch Weather (Legacy-ish, replaced by refreshAllData) ---
async function fetchWeatherData(lat, lon) {
    refreshAllData();
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

// --- Map & dipul Logic ---
const dipulLayerMapping = {
    'naturschutzgebiete': { category: 'Naturschutzgebiet', isPersistent: true },
    'nationalparks': { category: 'Nationalpark', isPersistent: true },
    'industrieanlagen': { category: 'Industrieanlage', isPersistent: true },
    'kraftwerke': { category: 'Kraftwerk', isPersistent: true },
    'militaerische_anlagen': { category: 'Militärische Anlage', isPersistent: true },
    'polizei': { category: 'Polizei/Behörde', isPersistent: true },
    'justizvollzugsanstalten': { category: 'Justizvollzugsanstalt', isPersistent: true },
    'internationale_organisationen': { category: 'Internationale Organisation', isPersistent: true },
    'flughaefen': { category: 'Flughafen', isPersistent: true },
    'flugplaetze': { category: 'Flugplatz', isPersistent: true },
    'krankenhaeuser': { category: 'Krankenhaus (Hubschrauberlandeplatz)', isPersistent: true },
    'flugbeschraenkungsgebiete': { category: 'Flugbeschränkungsgebiet (ED-R)', isPersistent: true },
    'kontrollzonen': { category: 'Kontrollzone (CTR)', isPersistent: true },
    'temporaere_betriebseinschraenkungen': { category: 'Temporäre Einschränkung (NOTAM)', isPersistent: false }
};

function initMap() {
    if (isMapInitialized) return;

    map = L.map('map', { attributionControl: true }).setView([activeCoords.lat || 51.16, activeCoords.lon || 10.45], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    const restrictionLayers = [
        'dipul:naturschutzgebiete', 'dipul:nationalparks', 'dipul:industrieanlagen', 'dipul:kraftwerke',
        'dipul:militaerische_anlagen', 'dipul:polizei', 'dipul:justizvollzugsanstalten',
        'dipul:internationale_organisationen', 'dipul:flughaefen', 'dipul:flugplaetze',
        'dipul:krankenhaeuser', 'dipul:flugbeschraenkungsgebiete', 'dipul:kontrollzonen'
    ].join(',');

    permanentWms = L.tileLayer.wms('https://uas-betrieb.de/geoservices/dipul/wms?', {
        layers: restrictionLayers,
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        attribution: 'Daten: DFS/BMDV'
    }).addTo(map);

    notamWms = L.tileLayer.wms('https://uas-betrieb.de/geoservices/dipul/wms?', {
        layers: 'dipul:temporaere_betriebseinschraenkungen',
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        attribution: 'Daten: DFS/BMDV'
    }).addTo(map);

    // Location toggle button
    const centerIcon = L.control({ position: 'topleft' });
    centerIcon.onAdd = function () {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom');
        div.innerHTML = '<button title="Auf meinen Standort zentrieren" style="background:#1e293b; border:none; color:white; padding:5px 8px; cursor:pointer; font-size:1.2rem; border-radius:4px;">🎯</button>';
        div.onclick = function (e) {
            e.stopPropagation();
            if (currentCoords.lat && currentCoords.lon) {
                map.setView([currentCoords.lat, currentCoords.lon], 14);
            }
        };
        return div;
    };
    centerIcon.addTo(map);

    // Polygon center button
    const polyCenterIcon = L.control({ position: 'topleft' });
    polyCenterIcon.onAdd = function () {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom');
        div.id = 'polyCenterBtn';
        div.style.display = activeProject.geofence ? 'block' : 'none';
        div.innerHTML = '<button title="Auf Projekt-Fläche zentrieren" style="background:#1e293b; border:none; color:white; padding:5px 8px; cursor:pointer; font-size:1.2rem; border-radius:4px;">🗺️</button>';
        div.onclick = function (e) {
            e.stopPropagation();
            if (geofenceLayer) {
                map.fitBounds(geofenceLayer.getBounds(), { padding: [50, 50] });
            }
        };
        return div;
    };
    polyCenterIcon.addTo(map);

    map.on('click', (e) => identifyFeature(e.latlng));
    isMapInitialized = true;
}

function updateMap(lat, lon) {
    initMap();
    if (!map) return;

    // Auto-centering only for manual/geo
    if (activeSource !== 'polygon') {
        map.setView([lat, lon], map.getZoom());
    }

    if (marker) {
        marker.setLatLng([lat, lon]);
    } else {
        marker = L.marker([lat, lon]).addTo(map);
    }
}

async function fetchDipulData(bboxOrPoint, type) {
    const layers = [
        'naturschutzgebiete', 'nationalparks', 'industrieanlagen', 'kraftwerke',
        'militaerische_anlagen', 'polizei', 'justizvollzugsanstalten',
        'internationale_organisationen', 'flughaefen', 'flugplaetze',
        'krankenhaeuser', 'flugbeschraenkungsgebiete', 'kontrollzonen',
        'temporaere_betriebseinschraenkungen'
    ].map(l => 'dipul:' + l).join(',');

    let url;
    if (type === 'bbox' || type === 'point') {
        const bbox = type === 'point'
            ? `${bboxOrPoint.lat - 0.0001},${bboxOrPoint.lon - 0.0001},${bboxOrPoint.lat + 0.0001},${bboxOrPoint.lon + 0.0001}`
            : bboxOrPoint;

        url = `https://uas-betrieb.de/geoservices/dipul/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo&LAYERS=${layers}&QUERY_LAYERS=${layers}&BBOX=${bbox}&FEATURE_COUNT=50&HEIGHT=1000&WIDTH=1000&INFO_FORMAT=application/json&I=500&J=500&CRS=EPSG:4326`;
    }

    try {
        const res = await fetch(url);
        return await res.json();
    } catch (e) {
        console.error("dipul check failed", e);
        return null;
    }
}

async function fetchDipulMultiPoints(points) {
    const promises = points.map(p => fetchDipulData(p, 'point'));
    const results = await Promise.all(promises);

    // Aggregate unique features
    const allFeatures = [];
    const seenIds = new Set();

    results.forEach(res => {
        if (res && res.features) {
            res.features.forEach(f => {
                if (!seenIds.has(f.id)) {
                    seenIds.add(f.id);
                    allFeatures.push(f);
                }
            });
        }
    });

    return { features: allFeatures };
}

function calculateCentroid(polygon) {
    if (!polygon || polygon.length === 0) return { lat: 0, lng: 0 };
    let lat = 0, lon = 0;
    polygon.forEach(p => {
        lat += p[0];
        lon += p[1];
    });
    return { lat: lat / polygon.length, lng: lon / polygon.length };
}

function getPolygonBBox(polygon) {
    if (!polygon || polygon.length === 0) return "0,0,0,0";
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    polygon.forEach(p => {
        minLat = Math.min(minLat, p[0]);
        maxLat = Math.max(maxLat, p[0]);
        minLon = Math.min(minLon, p[1]);
        maxLon = Math.max(maxLon, p[1]);
    });
    // WMS 1.3.0 expects minLat,minLon,maxLat,maxLon for CRS=EPSG:4326
    return `${minLat},${minLon},${maxLat},${maxLon}`;
}

async function identifyFeature(latlng) {
    const size = map.getSize();
    const point = map.latLngToContainerPoint(latlng, map.getZoom());
    const bounds = map.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const bbox = `${sw.lat},${sw.lng},${ne.lat},${ne.lng}`;

    const layers = [
        'dipul:naturschutzgebiete', 'dipul:nationalparks', 'dipul:industrieanlagen', 'dipul:kraftwerke',
        'dipul:militaerische_anlagen', 'dipul:polizei', 'dipul:justizvollzugsanstalten',
        'dipul:internationale_organisationen', 'dipul:flughaefen', 'dipul:flugplaetze',
        'dipul:krankenhaeuser', 'dipul:flugbeschraenkungsgebiete', 'dipul:kontrollzonen',
        'dipul:temporaere_betriebseinschraenkungen'
    ].join(',');

    const url = `https://uas-betrieb.de/geoservices/dipul/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo&LAYERS=${layers}&QUERY_LAYERS=${layers}&BBOX=${bbox}&FEATURE_COUNT=50&HEIGHT=${size.y}&WIDTH=${size.x}&INFO_FORMAT=application/json&I=${Math.floor(point.x)}&J=${Math.floor(point.y)}&CRS=EPSG:4326`;

    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.features && data.features.length > 0) {
            let content = '<div style="min-width: 200px; color: white; background: #1e293b; padding: 10px; border-radius: 8px;">';
            data.features.forEach(f => {
                const p = f.properties;
                const layerId = f.id.split('.')[0].replace('dipul:', '');
                const mapping = dipulLayerMapping[layerId] || { category: 'Luftraum', isPersistent: true };

                content += `<div style="margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:4px;">
                    <strong style="color:var(--accent-color);">${layerId.includes('temporaere') ? 'NOTAM: ' : ''}${p.name || mapping.category}</strong><br>
                    <span style="font-size:0.8rem; opacity:0.8;">Kategorie: ${mapping.category}</span>
                </div>`;
            });
            content += '</div>';
            L.popup().setLatLng(latlng).setContent(content).openOn(map);
        }
    } catch (e) { console.error(e); }
}

// --- Render Logic ---
function renderApp(weather, kpIndex, dipulData, alerts = []) {
    const grid = document.getElementById('weatherGrid');
    const windSpeed = weather.wind_speed || weather.wind_speed_10 || 0;
    const precipitation = weather.precipitation_60 || weather.precipitation_30 || weather.precipitation_10 || 0;
    const solarRad = weather.solar_60 || weather.solar_30 || weather.solar_10 || 0;

    // Process Kp Text
    let kpText = "k.A.";
    let kpColorClass = "bg-white";
    if (kpIndex !== null) {
        kpText = `Kp ${kpIndex.toFixed(1)}`;
        if (kpIndex < 4) { kpColorClass = "status-green"; kpText += " (Ruhig)"; }
        else if (kpIndex < 6) { kpColorClass = "status-yellow"; kpText += " (Unruhig)"; }
        else { kpColorClass = "status-red"; kpText += " (Sturm)"; }
    }

    // Process alerts
    let alertText = "Keine Warnungen";
    let alertColorClass = "status-green";
    if (alerts && alerts.length > 0) {
        alertColorClass = "status-yellow";
        let headlines = alerts.map(a => a.event_de || a.headline_de || "Warnung");
        alertText = [...new Set(headlines)].join(' & ');
    }

    // Process dipul status (names and types)
    let airStatusText = "Frei von Beschränkungen";
    let airColorClass = "status-green";
    if (dipulData && dipulData.features && dipulData.features.length > 0) {
        let details = [];
        let hasCritical = false;
        dipulData.features.forEach(f => {
            const p = f.properties;
            const layerId = f.id.split('.')[0].replace('dipul:', '');
            const mapping = dipulLayerMapping[layerId] || { category: 'Luftraum', isPersistent: true };

            const isNotam = !mapping.isPersistent || layerId.includes('temporaere');
            const isCritical = isNotam || layerId.includes('kontrollzonen') || layerId.includes('flugbeschraenk');

            if (isCritical) hasCritical = true;

            const name = p.name || mapping.category;
            const label = isCritical
                ? `⚠️ <strong>${isNotam ? 'NOTAM: ' : ''}${name}</strong>`
                : `• ${name} (${mapping.category})`;
            details.push(label);
        });
        airStatusText = [...new Set(details)].join('<br>');
        airColorClass = hasCritical ? "status-red" : "status-yellow";
    }

    const tilesData = [
        { label: 'Temperatur', value: `${Math.round(weather.temperature)}`, unit: '°C', icon: '🌡️', colorClass: getTileColor('temp', weather.temperature) },
        { label: 'Zustand', value: translateCondition(weather.icon), unit: '', icon: getIcon(weather.icon), colorClass: getTileColor('condition', weather.icon) },
        { label: 'Bewölkung', value: `${weather.cloud_cover}`, unit: '%', icon: '☁️', colorClass: 'status-green' },

        { label: 'Windgeschw.', value: `${Math.round(windSpeed)}`, unit: 'km/h', icon: '💨', extra: getCompassDirection(weather.wind_direction_10), colorClass: getTileColor('wind_speed', windSpeed) },
        { label: 'Solarstrahlung', value: `${Math.round(solarRad)}`, unit: 'W/m²', icon: '☀️', colorClass: getTileColor('solar', solarRad) },
        { label: 'Luftfeuchte', value: `${Math.round(weather.relative_humidity)}`, unit: '%', icon: '💧', colorClass: getTileColor('humidity', weather.relative_humidity) },

        { label: 'Niederschlag', value: `${precipitation.toFixed(1)}`, unit: 'mm', icon: '🌧️', colorClass: getTileColor('precip', precipitation) },
        { label: 'Kp-Index', value: kpText.split(' ')[1] || kpText, unit: kpText.includes('(') ? kpText.split('(')[1].replace(')', '') : '', icon: '🛰️', colorClass: kpColorClass },
        { label: 'Sichtweite', value: `${Math.round(weather.visibility / 1000)}`, unit: 'km', icon: '👁️', colorClass: getTileColor('visibility', weather.visibility) },

        { halfWide: true, label: 'Wetterwarnungen', value: alertText, icon: '🚨', colorClass: alertColorClass },
        { halfWide: true, label: 'Luftraum (dipul)', value: airStatusText, icon: '✈️', colorClass: airColorClass }
    ];

    grid.innerHTML = '';
    let hasRed = false;
    let hasYellow = false;

    tilesData.forEach(item => {
        if (item.colorClass === 'status-red') hasRed = true;
        if (item.colorClass === 'status-yellow') hasYellow = true;

        const tile = document.createElement('div');
        tile.className = `tile ${item.colorClass || 'status-white'}`;
        if (item.wide) tile.classList.add('wide');
        if (item.halfWide) tile.classList.add('half-wide');

        tile.innerHTML = `
            <div class="icon">${item.icon}</div>
            <div class="title">${item.label}</div>
            <div class="value">
                ${item.value} <span class="unit">${item.unit || ''}</span>
            </div>
            ${item.extra ? `<div style="font-size: 0.7rem; opacity: 0.7; margin-top: 0.25rem;">${item.extra}</div>` : ''}
        `;
        grid.appendChild(tile);
    });

    updateBanner(hasRed, hasYellow, precipitation > 0);
    autoFillLogbookWeather(
        translateCondition(weather.icon),
        Math.round(weather.temperature),
        windSpeed, // Use calculated windSpeed instead of weather.wind_speed
        precipitation,
        kpIndex,
        weather.visibility
    );
    autoFillLogbookMisc(airStatusText);
}

function autoFillLogbookMisc(airStatusHtml) {
    const miscField = document.getElementById('lb_misc');
    if (!miscField) return;

    // Extract names from labels like "⚠️ <strong>NAME</strong>" or "• NAME (Category)"
    // We only want the warnings (with ⚠️)
    const parser = new DOMParser();
    const doc = parser.parseFromString(airStatusHtml, 'text/html');

    // Extract both warnings (strong) and normal ones (li/div)
    // We try to get all names.
    const allItems = Array.from(doc.body.innerText.split('\n'))
        .map(line => line.replace('⚠️', '').replace('•', '').trim())
        .filter(line => line.length > 0 && line !== "Frei von Beschränkungen");

    if (allItems.length > 0) {
        const text = `Betroffene Lufträume: ${allItems.join(', ')}`;
        if (!miscField.value || miscField.value.includes('Betroffene Lufträume:')) {
            miscField.value = text;
        }
    } else if (miscField.value.includes('Betroffene Lufträume:')) {
        miscField.value = ""; // Clear if no longer applicable and was auto-filled
    }
}

function autoFillLogbookWeather(condition, temp, wind, precip, kp, visibility) {
    const weatherField = document.getElementById('lb_weather');
    if (weatherField) {
        const kpText = kp !== null ? `Kp: ${kp.toFixed(1)}` : "Kp: k.A.";
        const visText = visibility !== null ? `Sicht: ${Math.round(visibility / 1000)}km` : "Sicht: k.A.";
        const windText = `Wind: ${Math.round(wind)}km/h`;
        const precipText = `Regen: ${precip.toFixed(1)}mm`;

        const fullText = `${condition}, ${temp}°C, ${windText}, ${precipText}, ${kpText}, ${visText}`;

        // Update if empty or contains our automated pattern
        if (!weatherField.value || weatherField.value.includes('Kp:')) {
            weatherField.value = fullText;
        }
    }
}

function setNow(fieldId) {
    const el = document.getElementById(fieldId);
    if (!el) return;

    const now = new Date();
    if (el.type === 'date') {
        el.value = now.toISOString().split('T')[0];
    } else if (el.type === 'time') {
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        el.value = `${hh}:${mm}`;
    }
}

// Logic Alignment to Alternative App
function getTileColor(type, value) {
    if (value === null || value === undefined) return 'status-white';
    switch (type) {
        case 'temp':
            if (value >= 5 && value <= 35) return 'status-green';
            if (value >= 0 && value < 5 || value > 35 && value <= 40) return 'status-yellow';
            return 'status-red';
        case 'condition':
            if (['clear-day', 'clear-night', 'partly-cloudy-day', 'partly-cloudy-night', 'cloudy'].includes(value)) return 'status-green';
            if (['fog', 'wind'].includes(value)) return 'status-yellow';
            return 'status-red';
        case 'wind_speed':
            if (value <= 20) return 'status-green';
            if (value > 20 && value <= 35) return 'status-yellow';
            return 'status-red';
        case 'precip':
            if (value === 0) return 'status-green';
            if (value < 1) return 'status-yellow';
            return 'status-red';
        case 'solar':
            if (value <= 1000) return 'status-green';
            return 'status-yellow';
        case 'humidity':
            return 'status-green';
        case 'visibility':
            if (value >= 5000) return 'status-green';
            if (value >= 2000) return 'status-yellow';
            return 'status-red';
        default:
            return 'status-green';
    }
}

function getStatusColorClass(key, value) {
    const status = evaluateMetric(key, value);
    if (status === 'red') return 'bg-red';
    if (status === 'yellow') return 'bg-yellow';
    if (status === 'green') return 'bg-green';
    return 'bg-white';
}

function updateBanner(hasRed, hasYellow, isRaining) {
    const banner = document.getElementById('flight-status');
    const sub = document.getElementById('flight-status-sub');

    if (hasRed) {
        banner.className = 'status-banner danger';
        banner.querySelector('h2').innerText = 'Nicht Fliegen / Bedingungen Prüfen';
        sub.innerText = isRaining ? "Es regnet oder regnet bald." : "Mindestens ein Wert ist im roten Bereich.";
    } else if (hasYellow) {
        banner.className = 'status-banner warning';
        banner.querySelector('h2').innerText = 'Flug mit Vorsicht';
        sub.innerText = 'Einige Werte erfordern Aufmerksamkeit.';
    } else {
        banner.className = 'status-banner good';
        banner.querySelector('h2').innerText = 'Gut Um Zu Fliegen';
        sub.innerText = 'Alle Bedingungen sind optimal.';
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

// --- Manual Coordinate Input ---
document.getElementById('manualCoordsInput').addEventListener('change', function (e) {
    const val = e.target.value.trim();
    if (val) {
        const parts = val.split(',');
        if (parts.length === 2) {
            const lat = parseFloat(parts[0].trim());
            const lon = parseFloat(parts[1].trim());
            if (!isNaN(lat) && !isNaN(lon)) {
                manualCoords = { lat, lon };
                activeSource = "manual";
                refreshAllData();
                return;
            }
        }
        alert("Format: Lat, Lon (z.B. 48.35, 11.73)");
    } else {
        manualCoords = null;
        activeSource = activeProject.geofence ? "polygon" : "geolocation";
        refreshAllData();
    }
});

// --- Refresh Button ---
document.getElementById('refreshBtn').addEventListener('click', () => {
    refreshAllData();
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

// --- Navigation & View Switching ---
function switchTab(viewId) {
    // Hide all views
    document.querySelectorAll('.view-section').forEach(view => {
        view.classList.remove('active');
        // A little delay on display none to allow fade out if we decide to add it, but block is fine for now
        view.style.display = 'none';
    });

    // Show target view
    const targetView = document.getElementById(viewId);
    if (targetView) {
        targetView.style.display = 'block';
        // Small timeout to allow display:block to apply before adding active class for animation
        setTimeout(() => targetView.classList.add('active'), 10);
    }

    // Update bottom nav buttons state
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    // Find the button that called this and make it active
    const activeBtn = Array.from(document.querySelectorAll('.nav-btn')).find(btn => btn.getAttribute('onclick').includes(viewId));
    if (activeBtn) {
        activeBtn.classList.add('active');
    }

    // Update Header Context based on View
    const exportBtn = document.getElementById('exportBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const erpWarnBtn = document.getElementById('erpWarnBtn');

    if (viewId === 'logbook-view') {
        autoFillWeatherLog();
    } else if (viewId === 'erp-view') {
        exportBtn.style.display = 'flex'; // Keep visible
        refreshBtn.style.display = 'flex'; // Keep visible
        erpWarnBtn.style.display = 'none'; // hide the warning btn when already in ERP
        initErpData(); // Fetch POIs when ERP tab is opened
    } else {
        exportBtn.style.display = 'flex';
        refreshBtn.style.display = 'flex';
        erpWarnBtn.style.display = 'flex';
    }
}

// --- Weather Log Auto-fill ---
function autoFillWeatherLog() {
    if (!currentWeatherData) return;
    const weatherField = document.getElementById('lb_weather');
    if (weatherField && !weatherField.value) {
        // Build a readable summary string
        const temp = currentWeatherData.temperature;
        const wind = currentWeatherData.wind_speed_10;
        const condition = translateCondition(currentWeatherData.icon);
        const clouds = currentWeatherData.cloud_cover;

        weatherField.value = `${condition}, ${temp} °C, Wind: ${wind} km/h, Bewölkung: ${clouds}%`;
    }
}

// --- Signature Pad Logic ---
let signatureCtx1, signatureCtx2;
let isDrawing1 = false, isDrawing2 = false;
let lastX1 = 0, lastY1 = 0;
let lastX2 = 0, lastY2 = 0;

function initSignaturePads() {
    const canvas1 = document.getElementById('signaturePad1');
    const canvas2 = document.getElementById('signaturePad2');

    if (canvas1) {
        signatureCtx1 = canvas1.getContext('2d');
        setupCanvas(canvas1, signatureCtx1, (id) => isDrawing1 = id, (val) => isDrawing1 = val, () => isDrawing1, (x, y) => { lastX1 = x; lastY1 = y; }, () => [lastX1, lastY1]);
    }
    if (canvas2) {
        signatureCtx2 = canvas2.getContext('2d');
        setupCanvas(canvas2, signatureCtx2, (id) => isDrawing2 = id, (val) => isDrawing2 = val, () => isDrawing2, (x, y) => { lastX2 = x; lastY2 = y; }, () => [lastX2, lastY2]);
    }
}

function setupCanvas(canvas, ctx, setIsDrawing, getIsDrawingSet, getIsDrawing, setLastPos, getLastPos) {
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#000000';

    const getCoords = (evt) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const clientX = evt.clientX || (evt.touches && evt.touches[0].clientX);
        const clientY = evt.clientY || (evt.touches && evt.touches[0].clientY);
        return [(clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY];
    };

    const start = (e) => {
        setIsDrawing(true);
        const [x, y] = getCoords(e);
        setLastPos(x, y);
    };

    const move = (e) => {
        if (!getIsDrawing()) return;
        const [x, y] = getCoords(e);
        ctx.beginPath();
        const [lx, ly] = getLastPos();
        ctx.moveTo(lx, ly);
        ctx.lineTo(x, y);
        ctx.stroke();
        setLastPos(x, y);
    };

    const stop = () => setIsDrawing(false);

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', stop);
    canvas.addEventListener('mouseout', stop);

    canvas.addEventListener('touchstart', (e) => { e.preventDefault(); start(e); }, { passive: false });
    canvas.addEventListener('touchmove', (e) => { e.preventDefault(); move(e); }, { passive: false });
    canvas.addEventListener('touchend', stop, { passive: false });
}

function clearSignature(num) {
    const canvas = document.getElementById(`signaturePad${num}`);
    const ctx = num === 1 ? signatureCtx1 : signatureCtx2;
    if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

// --- ERP Logic (Overpass API & Distance) ---
let erpDataFetched = false;

let lastErpCoords = { lat: 0, lon: 0 };

function initErpData() {
    const lat = activeCoords.lat;
    const lon = activeCoords.lon;

    // Skip if we already have data for these approximate coordinates (within 100m)
    if (lat === 0 || (Math.abs(lastErpCoords.lat - lat) < 0.001 && Math.abs(lastErpCoords.lon - lon) < 0.001)) return;

    const poiTable = document.getElementById('erpPoiList');
    if (!poiTable) return;

    poiTable.innerHTML = '<tr><td colspan="4" style="text-align: center;">Suche nach Kliniken und Flughäfen im Umkreis von 50km...</td></tr>';

    lastErpCoords = { lat, lon };

    // Overpass QL to find hospitals, aeroways (airports, helipads) within 50km
    const query = `
        [out:json][timeout:25];
        (
          node["amenity"="hospital"](around:50000,${lat},${lon});
          way["amenity"="hospital"](around:50000,${lat},${lon});
          node["aeroway"~"aerodrome|heliport"](around:50000,${lat},${lon});
          way["aeroway"~"aerodrome|heliport"](around:50000,${lat},${lon});
        );
        out center;
    `;

    const url = "https://overpass-api.de/api/interpreter";

    fetch(url, {
        method: "POST",
        body: query
    })
        .then(res => res.json())
        .then(data => {
            let pois = [];

            data.elements.forEach(el => {
                if (!el.tags || !el.tags.name) return;

                const pLat = el.lat || el.center.lat;
                const pLon = el.lon || el.center.lon;

                const distance = calculateHaversineDistance(lat, lon, pLat, pLon);
                const direction = getCompassDirectionFromBearing(lat, lon, pLat, pLon);

                let type = el.tags.amenity === 'hospital' ? 'Klinik' :
                    (el.tags.aeroway === 'heliport' ? 'Heliport' : 'Flugplatz');

                let phone = el.tags['contact:phone'] || el.tags.phone || 'Unbekannt';

                pois.push({
                    name: el.tags.name,
                    type: type,
                    phone: phone,
                    distance: distance,
                    direction: direction
                });
            });

            // Sort by distance
            pois.sort((a, b) => a.distance - b.distance);

            // Take top 6
            pois = pois.slice(0, 6);

            if (pois.length === 0) {
                poiTable.innerHTML = '<tr><td colspan="4" style="text-align: center;">Keine Einträge im 50km Umkreis gefunden.</td></tr>';
                return;
            }

            poiTable.innerHTML = '';
            pois.forEach(poi => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                <td>${poi.name}</td>
                <td>${poi.type}</td>
                <td>${poi.phone !== 'Unbekannt' ? '<a href="tel:' + poi.phone.replace(/[^0-9+]/g, '') + '" style="color: var(--accent-color);">' + poi.phone + '</a>' : 'Unbekannt'}</td>
                <td>${poi.distance.toFixed(1)} km ${poi.direction}</td>
            `;
                poiTable.appendChild(tr);
            });

            erpDataFetched = true;
        })
        .catch(err => {
            console.error("Overpass API Error:", err);
            poiTable.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--danger-color);">Fehler beim Laden der Umgebungsdaten. (Offline?)</td></tr>';
        });
}

function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function getCompassDirectionFromBearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const l1 = lat1 * Math.PI / 180;
    const l2 = lat2 * Math.PI / 180;

    const y = Math.sin(dLon) * Math.cos(l2);
    const x = Math.cos(l1) * Math.sin(l2) - Math.sin(l1) * Math.cos(l2) * Math.cos(dLon);
    let brng = Math.atan2(y, x) * 180 / Math.PI;
    brng = (brng + 360) % 360;

    return getCompassDirection(brng);
}

document.getElementById('erpWarnBtn').addEventListener('click', () => {
    switchTab('erp-view');
});

// --- Plan File Parsing ---
document.getElementById('planFileInput').addEventListener('change', function (e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const planData = JSON.parse(e.target.result);

            // Extract from standard QGroundControl .plan format
            // Often Mission files don't have explicit project names in the root, 
            // but might be named after the file. We'll use the file name as fallback.
            let filename = file.name.replace('.plan', '');
            activeProject.name = filename;

            // Attempt to find a polygon or survey area name if it exists inside the mission items
            activeProject.area = "";
            // Extraction of Geofence Polygons from QGroundControl .plan
            if (planData.geoFence && planData.geoFence.polygons) {
                if (geofenceLayer) map.removeLayer(geofenceLayer);

                const polygons = planData.geoFence.polygons.filter(p => p.inclusion === true);
                if (polygons.length > 0) {
                    const polyCoords = polygons[0].polygon; // Assuming first inclusion polygon
                    geofenceLayer = L.polygon(polyCoords, {
                        color: '#38bdf8',
                        weight: 3,
                        fillOpacity: 0.2,
                        dashArray: '5, 10'
                    }).addTo(map);

                    // Re-center map to the geofence
                    map.fitBounds(geofenceLayer.getBounds(), { padding: [50, 50] });
                    activeProject.geofence = polyCoords;
                    activeProject.area = "Geofence aktiv";
                }
            }

            updateProjectBanner();
            refreshAllData();
        } catch (error) {
            console.error("Error parsing .plan file:", error);
            alert("Fehler beim Einlesen der .plan Datei. Ist es ein gültiges QGroundControl JSON Format?");
        }
    };
    reader.readAsText(file);
});

document.getElementById('clearProjectBtn').addEventListener('click', clearActiveProject);

function clearActiveProject() {
    activeProject.name = "Kein Projekt geladen";
    activeProject.area = "";
    activeProject.geofence = null;
    if (geofenceLayer) {
        map.removeLayer(geofenceLayer);
        geofenceLayer = null;
    }
    document.getElementById('planFileInput').value = "";
    updateProjectBanner();
    refreshAllData();
}

function updateProjectBanner() {
    const display = document.getElementById('projectNameDisplay');
    const clearBtn = document.getElementById('clearProjectBtn');
    const polyBtn = document.getElementById('polyCenterBtn');

    if (display) {
        display.innerText = activeProject.name + (activeProject.area ? ` (${activeProject.area})` : "");
    }

    if (clearBtn) {
        clearBtn.style.display = (activeProject.name !== "Kein Projekt geladen") ? "block" : "none";
    }

    if (polyBtn) {
        polyBtn.style.display = activeProject.geofence ? "block" : "none";
    }
}

// --- Sync & Drive Export Logic ---
const GOOGLE_SCRIPT_URL = ""; // Hier kommt die URL des Google Apps Scripts hin

async function saveLogbook() {
    const form = document.getElementById('logbookForm');
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }

    const formData = {
        project: activeProject.name,
        area: activeProject.area,
        rpic1: document.getElementById('lb_rpic1').value,
        rpic2: document.getElementById('lb_rpic2').value,
        copter: document.getElementById('lb_copter').value,
        date: document.getElementById('lb_date').value,
        customer: document.getElementById('lb_customer').value,
        location: document.getElementById('lb_location').value,
        setupTime: document.getElementById('lb_setup_time').value,
        flights: document.getElementById('lb_flights').value,
        teardownTime: document.getElementById('lb_teardown_time').value,
        totalTime: document.getElementById('lb_total_time').value,
        events: document.getElementById('lb_events').value,
        operation: document.getElementById('lb_operation').value,
        reactions: document.getElementById('lb_reactions').value,
        weather: document.getElementById('lb_weather').value,
        misc: document.getElementById('lb_misc').value,
        signature1: document.getElementById('signaturePad1').toDataURL(),
        signature2: document.getElementById('signaturePad2').toDataURL(),
        timestamp: new Date().toISOString()
    };

    try {
        if (!navigator.onLine) {
            throw new Error("Offline");
        }

        await sendToGoogleDrive(formData);
        alert("Logbuch erfolgreich synchronisiert!");
        form.reset();
        document.getElementById('lb_rpic2').disabled = true;
        clearSignature(1);
        clearSignature(2);
    } catch (err) {
        console.warn("Sync failed or offline. Saving locally...", err);
        const pendingLogs = await localforage.getItem('pending_logs') || [];
        pendingLogs.push(formData);
        await localforage.setItem('pending_logs', pendingLogs);
        alert("Offline: Logbuch wurde lokal gespeichert und wird bei Verbindung synchronisiert.");
        form.reset();
        document.getElementById('lb_rpic2').disabled = true;
        clearSignature(1);
        clearSignature(2);
    }
}

async function sendToGoogleDrive(data) {
    if (!GOOGLE_SCRIPT_URL) {
        console.error("Google Script URL not set. Cannot sync.");
        return;
    }

    const response = await fetch(GOOGLE_SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors', // Apps Script web apps often require no-cors for simple posts
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    });
    return response;
}

async function checkPendingLogs() {
    if (!navigator.onLine || !GOOGLE_SCRIPT_URL) return;

    const pendingLogs = await localforage.getItem('pending_logs') || [];
    if (pendingLogs.length === 0) return;

    console.log(`Found ${pendingLogs.length} pending logs. Syncing...`);

    const successfullySynced = [];
    for (const log of pendingLogs) {
        try {
            await sendToGoogleDrive(log);
            successfullySynced.push(log);
        } catch (e) {
            console.error("Sync failed for log", log, e);
        }
    }

    const remainingLogs = pendingLogs.filter(log => !successfullySynced.includes(log));
    await localforage.setItem('pending_logs', remainingLogs);

    if (successfullySynced.length > 0) {
        console.log(`${successfullySynced.length} logs synced successfully.`);
    }
}

// Global scope injection
window.saveLogbook = saveLogbook;

// Listen for online status to trigger sync
window.addEventListener('online', checkPendingLogs);

// Start
initApp();


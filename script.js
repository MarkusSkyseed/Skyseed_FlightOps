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

    map = L.map('map', { 
        attributionControl: true, 
        zoomControl: false,
        preferCanvas: true // Render geofence and other vectors on canvas for better screenshotting
    }).setView([activeCoords.lat || 51.16, activeCoords.lon || 10.45], 12); // Default zoom 12
    L.control.zoom({ position: 'topright' }).addTo(map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        crossOrigin: true // Ensure CORS for screenshotting
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

// Handle mobile viewport changes (keyboard open/close, rotation, etc.)
window.addEventListener('resize', () => {
    if (map && isMapInitialized) {
        // Delay slightly to ensure DOM has updated
        setTimeout(() => {
            map.invalidateSize({ animate: false });
        }, 100);
    }
});

function updateMap(lat, lon) {
    initMap();
    if (!map) return;

    // Zentrierung: Geofence hat Priorität, sonst Punkt-Koordinaten
    if (activeProject.geofence && geofenceLayer) {
        map.fitBounds(geofenceLayer.getBounds(), { padding: [50, 50] });
    } else {
        map.setView([lat, lon], 12); // Festgelegter Zoom 12
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

function incrementValue(id, amount = 1) {
    const el = document.getElementById(id);
    if (!el) return;
    let val = parseInt(el.value) || 0;
    val += amount;
    if (val < 0) val = 0;
    el.value = val;
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
    exportAppAsImage();
});

async function exportAppAsImage() {
    const exportBtn = document.getElementById('exportBtn');
    const originalText = exportBtn.innerHTML;
    exportBtn.innerHTML = '⏳...';
    exportBtn.disabled = true;

    try {
        const canvas = await generateScreenshotCanvas();
        
        // Dateiname nach Format: YYYY_MM_DD_Project_Customer_Location
        const dateInput = document.getElementById('lb_date').value || new Date().toISOString().split('T')[0];
        const safeDate = dateInput.replace(/-/g, '_');
        const safeProject = (activeProject.name || 'UAS').replace(/[^a-zA-Z0-9]/g, '_');
        const safeCustomer = (document.getElementById('lb_customer').value || 'Unbekannt').replace(/[^a-zA-Z0-9]/g, '_');
        const safeLocation = (document.getElementById('lb_location').value || 'Unbekannt').replace(/[^a-zA-Z0-9]/g, '_');
        
        const filename = `${safeDate}_${safeProject}_${safeCustomer}_${safeLocation}.png`;

        canvas.toBlob(async (blob) => {
            if (!blob) throw new Error("Canvas failure");
            const file = new File([blob], filename, { type: 'image/png' });

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({
                        files: [file],
                        title: 'UAV Flight Documentation',
                        text: `Dokumentation für ${safeProject}`
                    });
                } catch (err) {
                    if (err.name !== 'AbortError') downloadBlob(blob, filename);
                }
            } else {
                downloadBlob(blob, filename);
            }
        }, 'image/png');
    } catch (err) {
        console.error("Export failed", err);
        alert("Export fehlgeschlagen.");
    } finally {
        exportBtn.innerHTML = originalText;
        exportBtn.disabled = false;
    }
}

async function generateScreenshotCanvas() {
    // FIX: Scroll to top to prevent offset issues with html2canvas
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    window.scrollTo(0, 0);

    window.getSelection().removeAllRanges();

    const buttonsToHide = document.querySelectorAll('#exportBtn, #refreshBtn, #historyBtn, #planImportBtn, .nav-btn, .bottom-nav, .signature-tools, .btn-small');
    const originalOpacities = Array.from(buttonsToHide).map(b => b.style.opacity);
    buttonsToHide.forEach(b => b.style.opacity = '0');

    const exportCSS = document.createElement('style');
    exportCSS.id = 'portfolio-export-style';
    exportCSS.textContent = `
        *, *::before, *::after { animation: none !important; transition: none !important; }
        .tile { opacity: 1 !important; transform: none !important; background: #1e293b !important; border-color: rgba(255,255,255,0.15) !important; }
        .tile.status-green { background: #133a34 !important; border-color: rgba(34, 197, 94, 0.5) !important; }
        .tile.status-yellow { background: #3b3623 !important; border-color: rgba(234, 179, 8, 0.5) !important; }
        .tile.status-red { background: #3c202f !important; border-color: rgba(239, 68, 68, 0.5) !important; }
        header h1 { background: none !important; -webkit-text-fill-color: #f8fafc !important; color: #f8fafc !important; }
        .title, .value, .unit, .icon, header p, .log-input { opacity: 1 !important; color: white !important; }
        .log-input { background: rgba(255,255,255,0.05) !important; border: 1px solid rgba(255,255,255,0.1) !important; }
        .status-banner.good { background: #133a34 !important; }
        .status-banner.warning { background: #3b3623 !important; }
        .status-banner.danger { background: #3c202f !important; }
        .export-section-title { 
            font-size: 1.5rem; font-weight: 800; color: var(--accent-color); 
            margin: 2rem 0 1rem 0; padding-bottom: 0.5rem; border-bottom: 2px solid var(--accent-color);
            text-transform: uppercase; letter-spacing: 0.1em;
        }
    `;
    document.head.appendChild(exportCSS);

    const originalDashboard = document.getElementById('dashboard-view');
    const wasDashboardHidden = originalDashboard.style.display === 'none';
    if (wasDashboardHidden) {
        originalDashboard.style.display = 'block';
        originalDashboard.style.opacity = '0';
    }

    let mapDataUrl = null;
    try {
        const liveMap = document.getElementById('map');
        
        // FIX: Karte vor dem Screenshot explizit zentrieren
        if (map) {
            if (activeProject.geofence && geofenceLayer) {
                map.fitBounds(geofenceLayer.getBounds(), { padding: [50, 50], animate: false });
            } else if (activeCoords.lat !== 0) {
                map.setView([activeCoords.lat, activeCoords.lon], 11, { animate: false });
            }
            map.invalidateSize({ animate: false });
            // Längere Wartezeit für Kacheln und Marker-Ausrichtung
            await new Promise(r => setTimeout(r, 500));
        }

        const mapCanvas = await html2canvas(liveMap, { 
            useCORS: true, 
            logging: false,
            allowTaint: true,
            scale: 2,
            scrollX: 0,
            scrollY: 0,
            backgroundColor: null
        });
        mapDataUrl = mapCanvas.toDataURL('image/png');
    } catch (e) { console.warn("Karte konnte nicht gerendert werden", e); }

    if (wasDashboardHidden) {
        originalDashboard.style.display = 'none';
        originalDashboard.style.opacity = '1';
    }

    const wrapper = document.createElement('div');
    wrapper.style.position = 'absolute';
    wrapper.style.left = '-9999px';
    wrapper.style.top = '0';
    wrapper.style.width = '900px';
    wrapper.style.background = '#0f172a';
    wrapper.style.padding = '40px';
    wrapper.style.color = 'white';
    document.body.appendChild(wrapper);

    try {
        const headerClone = document.querySelector('header').cloneNode(true);
        wrapper.appendChild(headerClone);

        const statusTitle = document.createElement('div');
        statusTitle.className = 'export-section-title';
        statusTitle.innerText = 'I. AKTUELLER STATUS & WETTER';
        wrapper.appendChild(statusTitle);

        const dashboardView = document.getElementById('dashboard-view').cloneNode(true);
        dashboardView.style.display = 'block';
        dashboardView.style.opacity = '1';

        // FIX: Die fehlerhafte geklonte Map durch unser statisches Bild ersetzen
        const clonedMap = dashboardView.querySelector('#map');
        if (clonedMap && mapDataUrl) {
            clonedMap.innerHTML = `<img src="${mapDataUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 1rem;" />`;
            clonedMap.style.background = 'none';
            clonedMap.className = ""; // Remove leaflet classes
        }
        wrapper.appendChild(dashboardView);

        const erpTitle = document.createElement('div');
        erpTitle.className = 'export-section-title';
        erpTitle.innerText = 'II. NOTFALLPLAN (ERP)';
        wrapper.appendChild(erpTitle);

        const erpView = document.getElementById('erp-view').cloneNode(true);
        erpView.style.display = 'block';
        wrapper.appendChild(erpView);

        const logTitle = document.createElement('div');
        logTitle.className = 'export-section-title';
        logTitle.innerText = 'III. LOGBUCH-DOKUMENTATION';
        wrapper.appendChild(logTitle);

        const logbookView = document.getElementById('logbook-view').cloneNode(true);
        logbookView.style.display = 'block';

        const originalInputs = document.getElementById('logbook-view').querySelectorAll('input, textarea, select');
        const clonedInputs = logbookView.querySelectorAll('input, textarea, select');
        originalInputs.forEach((inp, idx) => {
            if (clonedInputs[idx]) clonedInputs[idx].value = inp.value;
        });

        const sig1 = document.getElementById('signaturePad1');
        const sig2 = document.getElementById('signaturePad2');
        const canvasClones = logbookView.querySelectorAll('canvas');
        if (canvasClones[0]) {
            const ctx = canvasClones[0].getContext('2d');
            ctx.drawImage(sig1, 0, 0);
        }
        if (canvasClones[1]) {
            const ctx = canvasClones[1].getContext('2d');
            ctx.drawImage(sig2, 0, 0);
        }

        wrapper.appendChild(logbookView);

        const metaClone = document.querySelector('.app-metadata').cloneNode(true);
        wrapper.appendChild(metaClone);

        await new Promise(r => setTimeout(r, 600));

        const canvas = await html2canvas(wrapper, {
            scale: 2,
            backgroundColor: '#0f172a',
            useCORS: true,
            logging: false,
            width: 900,
            windowWidth: 900,
            height: wrapper.scrollHeight,
            windowHeight: wrapper.scrollHeight,
            scrollX: 0,
            scrollY: 0
        });

        return canvas;
    } finally {
        document.body.removeChild(wrapper);
        const style = document.getElementById('portfolio-export-style');
        if (style) style.remove();
        buttonsToHide.forEach((b, i) => b.style.opacity = originalOpacities[i]);
        // Restore scroll position
        window.scrollTo(scrollX, scrollY);
    }
}

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

        // Refresh History list if switching to history view
        if (viewId === 'history-view') {
            renderHistory();
        }
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

    if (viewId === 'logbook-view') {
        autoFillWeatherLog();
    } else if (viewId === 'erp-view') {
        exportBtn.style.display = 'flex'; // Keep visible
        refreshBtn.style.display = 'flex'; // Keep visible
        initErpData(); // Fetch POIs when ERP tab is opened
    } else if (viewId === 'dashboard-view') {
        exportBtn.style.display = 'flex';
        refreshBtn.style.display = 'flex';
        // Fix for mobile: recalculate map size after viewport changes (keyboard)
        if (map && isMapInitialized) {
            setTimeout(() => {
                map.invalidateSize({ animate: false });
            }, 100);
        }
    } else {
        exportBtn.style.display = 'flex';
        refreshBtn.style.display = 'flex';
    }

    // Scroll to top when switching tabs
    window.scrollTo({ top: 0, behavior: 'smooth' });
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

// --- ERP Logic (Offline: Local erp_database.js) ---
let erpDataFetched = false;
let lastErpCoords = { lat: 0, lon: 0 };

async function initErpData() {
    const lat = activeCoords.lat;
    const lon = activeCoords.lon;

    // Skip if coordinates are invalid
    if (!lat || !lon) return;

    // Skip if we already have data for these approximate coordinates (within 100m)
    if (Math.abs(lastErpCoords.lat - lat) < 0.001 && Math.abs(lastErpCoords.lon - lon) < 0.001 && erpDataFetched) return;

    const poiTable = document.getElementById('erpPoiList');
    if (!poiTable) return;

    poiTable.innerHTML = '<tr><td colspan="4" style="text-align: center;">Lade Notfalldaten aus lokaler Datenbank...</td></tr>';
    lastErpCoords = { lat, lon };

    // Get Static Data (Filtered by type-specific distances)
    let staticResults = [];
    if (typeof ERP_STATIC_DATA !== 'undefined') {
        const manualPhones = await localforage.getItem('erp_manual_phones') || {};
        
        staticResults = ERP_STATIC_DATA.map(entry => {
            const dist = calculateHaversineDistance(lat, lon, entry.lat, entry.lon);
            const dir = getCompassDirectionFromBearing(lat, lon, entry.lat, entry.lon);
            
            // Check for manual override
            const key = `${entry.lat.toFixed(5)}_${entry.lon.toFixed(5)}`;
            const phone = manualPhones[key] || entry.phone;

            return {
                ...entry,
                phone: phone,
                distance: dist,
                direction: dir,
                source: manualPhones[key] ? 'Manual' : 'Offline-DB'
            };
        }).filter(item => {
            if (item.type === 'Flughafen (International)') return item.distance <= 25;
            if (item.type === 'Flugplatz') return item.distance <= 20;
            return item.distance <= 15; // All other types (Clinics, Heliports, etc.)
        });
    } else {
        console.warn("ERP_STATIC_DATA is not defined. Make sure erp_database.js is loaded.");
    }

    // Sort & Render
    staticResults.sort((a, b) => a.distance - b.distance);
    const finalResults = staticResults.slice(0, 10); // Show top 10

    renderErpTable(finalResults, poiTable);
    erpDataFetched = true;
}

function renderErpTable(items, tableEl) {
    if (items.length === 0) {
        tableEl.innerHTML = '<tr><td colspan="4" style="text-align: center;">Keine relevanten Einträge im 25km Umkreis gefunden.</td></tr>';
        return;
    }

    tableEl.innerHTML = '';
    items.forEach(poi => {
        const tr = document.createElement('tr');
        
        // Highlight International Airports with red background
        if (poi.type === 'Flughafen (International)') {
            tr.style.backgroundColor = 'rgba(239, 68, 68, 0.15)'; // Light red tint
            tr.style.borderLeft = '4px solid var(--danger-color)';
        }

        // Highlight phone number if available, otherwise offer search link
        let phoneHtml = '';
        const hasPhone = poi.phone && poi.phone !== 'Unbekannt';
        
        if (hasPhone) {
            const cleanPhone = poi.phone.replace(/[^0-9+]/g, '');
            phoneHtml = `<a href="tel:${cleanPhone}" style="color: var(--accent-color); font-weight: bold;">${poi.phone}</a>`;
        } else {
            const searchQuery = encodeURIComponent(`${poi.name} ${poi.type} Telefonnummer`);
            const searchUrl = `https://www.google.com/search?q=${searchQuery}`;
            phoneHtml = `<a href="${searchUrl}" target="_blank" style="color: var(--accent-color); font-size: 0.9em; text-decoration: underline;">🔍 Suchen</a>`;
        }

        // Add edit button
        phoneHtml += ` <span onclick="editErpPhone('${poi.lat}', '${poi.lon}', '${poi.name}')" style="cursor: pointer; opacity: 0.5; font-size: 0.8em;" title="Nummer bearbeiten">✏️</span>`;

        tr.innerHTML = `
            <td>${poi.name} ${poi.source === 'Manual' ? '<span title="Manuell ergänzt">✍️</span>' : ''}</td>
            <td>${poi.type}</td>
            <td>${phoneHtml}</td>
            <td>${poi.distance.toFixed(1)} km ${poi.direction}</td>
        `;
        tableEl.appendChild(tr);
    });
}

async function editErpPhone(lat, lon, name) {
    const newPhone = prompt(`Telefonnummer für ${name} eingeben:`);
    if (newPhone === null) return; // Cancelled

    const manualPhones = await localforage.getItem('erp_manual_phones') || {};
    const key = `${parseFloat(lat).toFixed(5)}_${parseFloat(lon).toFixed(5)}`;
    
    if (newPhone.trim() === "") {
        delete manualPhones[key];
    } else {
        manualPhones[key] = newPhone.trim();
    }
    
    await localforage.setItem('erp_manual_phones', manualPhones);
    
    // Force refresh the table
    erpDataFetched = false;
    initErpData();
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
        display.innerText = activeProject.name;
    }

    if (clearBtn) {
        clearBtn.style.display = (activeProject.name !== "Kein Projekt geladen") ? "block" : "none";
    }

    if (polyBtn) {
        polyBtn.style.display = activeProject.geofence ? "block" : "none";
    }
}

// --- Sync & Drive Export Logic ---
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw7rbH4X1HCnvTXfYPJuhu0hboBVeBiHECaVmTXpaunO_iJC-jJAUGFZxgig90_I1Uv/exec"; // Hier kommt die URL des Google Apps Scripts hin

async function saveLogbook() {
    const form = document.getElementById('logbookForm');
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }

    const saveBtn = document.querySelector('button[onclick="saveLogbook()"]');
    const originalBtnText = saveBtn.innerHTML;
    saveBtn.innerHTML = '⏳ Erstelle Portfolio & Sync...';
    saveBtn.disabled = true;

    try {
        // Portfolio Screenshot generieren (wie beim Export)
        let screenshotDataUrl = null;
        try {
            const canvas = await generateScreenshotCanvas();
            screenshotDataUrl = canvas.toDataURL('image/png');
        } catch (screenshotErr) {
            console.warn("Screenshot konnte für Sync nicht erstellt werden", screenshotErr);
        }

        const formData = {
            project: activeProject.name,
            rpic1: document.getElementById('lb_rpic1').value,
            rpic2: document.getElementById('lb_rpic2').value,
            copter: document.getElementById('lb_copter').value,
            date: document.getElementById('lb_date').value,
            customer: document.getElementById('lb_customer').value,
            location: document.getElementById('lb_location').value,
            lat: activeCoords.lat, // Store lat
            lon: activeCoords.lon, // Store lon
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
            screenshot: screenshotDataUrl, // Der Portfolio-Screenshot
            timestamp: new Date().toISOString(),
            id: Date.now() + Math.random().toString(36).substr(2, 9), // Unique ID for duplication check
            synced: false // Default to false
        };

        try {
            if (!navigator.onLine) {
                throw new Error("Offline");
            }

            const responseText = await sendToGoogleDrive(formData);
            
            if (responseText.startsWith("Error")) {
                throw new Error(responseText);
            }
            if (responseText === "Duplicate") {
                alert("Dieser Eintrag wurde bereits hochgeladen (Dublette erkannt).");
                formData.synced = true; // Mark as synced anyway to avoid re-upload loops
            } else {
                formData.synced = true;
                alert("Logbuch & Portfolio erfolgreich synchronisiert!");
            }
            
            form.reset();
            document.getElementById('lb_rpic2').disabled = true;
            clearSignature(1);
            clearSignature(2);
        } catch (err) {
            console.warn("Sync failed or offline. Saving as offline...", err);
            formData.synced = false;
            alert("Aktuell keine Verbindung oder Upload-Fehler. Logbuch wurde im Verlauf als 'Offline' markiert und kann später hochgeladen werden.");
            form.reset();
            document.getElementById('lb_rpic2').disabled = true;
            clearSignature(1);
            clearSignature(2);
        }

        // Always save to persistent history after attempting sync
        try {
            const historyLogs = await localforage.getItem('uav_history_logs') || [];
            historyLogs.unshift(formData); // Add to beginning of history
            await localforage.setItem('uav_history_logs', historyLogs);
            console.log("Log added to history with sync status:", formData.synced);
        } catch (hErr) {
            console.error("Failed to save to history", hErr);
        }
    } catch (globalErr) {
        console.error("Fehler beim Speichern:", globalErr);
        alert("Fehler beim Speichern des Logbuchs.");
    } finally {
        saveBtn.innerHTML = originalBtnText;
        saveBtn.disabled = false;
    }
}

async function sendToGoogleDrive(data) {
    if (!GOOGLE_SCRIPT_URL) {
        throw new Error("Google Script URL nicht konfiguriert.");
    }

    // Wir müssen die Daten als Text/Plain oder via FormData senden, 
    // um CORS-Preflight-Probleme bei Apps Scripts zu minimieren, 
    // aber wir wollen die Antwort lesen können.
    const response = await fetch(GOOGLE_SCRIPT_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain;charset=utf-8' 
        },
        body: JSON.stringify(data)
    });

    if (!response.ok) {
        throw new Error(`Server-Fehler: ${response.status}`);
    }

    return await response.text();
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

// --- History Management ---
async function renderHistory() {
    const historyList = document.getElementById('historyList');
    if (!historyList) return;

    try {
        const historyLogs = await localforage.getItem('uav_history_logs') || [];
        
        if (historyLogs.length === 0) {
            historyList.innerHTML = '<p style="text-align: center; opacity: 0.6; padding: 2rem;">Keine Einträge im Verlauf gefunden.</p>';
            return;
        }

        historyList.innerHTML = historyLogs.map((log, index) => {
            const dateStr = new Date(log.timestamp).toLocaleString('de-DE');
            const syncStatus = log.synced ? 
                '<span style="color: #4ade80; font-weight: bold; font-size: 0.8rem; margin-left: 0.5rem;">● SYNC</span>' : 
                '<span style="color: #f87171; font-weight: bold; font-size: 0.8rem; margin-left: 0.5rem;">● OFFLINE</span>';
                
            return `
                <div class="history-card">
                    <div class="history-header">
                        <div class="history-info">
                            <h3>${log.project || 'Unbenanntes Projekt'}${syncStatus}</h3>
                            <p>${log.customer ? log.customer + ' - ' : ''}${log.location || 'Kein Standort'}</p>
                        </div>
                        <div class="history-date">${dateStr}</div>
                    </div>
                    <div class="history-details">
                        <div class="detail-item"><span class="detail-label">RPIC 1:</span> ${log.rpic1 || '---'}</div>
                        ${log.rpic2 ? `<div class="detail-item"><span class="detail-label">RPIC 2:</span> ${log.rpic2}</div>` : ''}
                        <div class="detail-item"><span class="detail-label">Copter:</span> ${log.copter}</div>
                        <div class="detail-item"><span class="detail-label">Dauer:</span> ${log.totalTime || '0'} min</div>
                    </div>
                    <div class="history-actions">
                        <button class="btn btn-primary btn-history" onclick="loadHistoricalData(${index})">
                            👁️ Anzeigen
                        </button>
                        <button class="btn btn-secondary btn-history" onclick="exportHistoricalLog(${index})">
                            📤 Exportieren
                        </button>
                        <button class="btn btn-secondary btn-history" onclick="reUploadHistoricalLog(${index})">
                            ☁️ Hochladen
                        </button>
                        <button class="btn btn-icon btn-history" style="background-color:rgba(239, 68, 68, 0.1); color:#fca5a5;" onclick="deleteHistoricalLog(${index})">
                            🗑️ Löschen
                        </button>
                    </div>
                </div>
            `;
        }).join('');

    } catch (err) {
        console.error("Failed to render history", err);
        historyList.innerHTML = '<p style="text-align: center; color: var(--danger-color);">Fehler beim Laden des Verlaufs.</p>';
    }
}

async function loadHistoricalData(index) {
    return new Promise(async (resolve, reject) => {
        try {
            const historyLogs = await localforage.getItem('uav_history_logs') || [];
            const log = historyLogs[index];
            if (!log) return resolve();

            // Map data back to form fields
            document.getElementById('lb_rpic1').value = log.rpic1 || '';
            document.getElementById('lb_rpic2').value = log.rpic2 || '';
            document.getElementById('lb_copter').value = log.copter || '';
            document.getElementById('lb_date').value = log.date || '';
            document.getElementById('lb_customer').value = log.customer || '';
            document.getElementById('lb_location').value = log.location || '';
            document.getElementById('lb_setup_time').value = log.setupTime || '';
            document.getElementById('lb_flights').value = log.flights || '';
            document.getElementById('lb_teardown_time').value = log.teardownTime || '';
            document.getElementById('lb_total_time').value = log.totalTime || '';
            document.getElementById('lb_events').value = log.events || '';
            document.getElementById('lb_operation').value = log.operation || '';
            document.getElementById('lb_reactions').value = log.reactions || '';
            document.getElementById('lb_weather').value = log.weather || '';
            document.getElementById('lb_misc').value = log.misc || '';

            // Bestehenden Geofence/Projekt löschen, um Fokus auf den Log-Standort zu setzen
            if (geofenceLayer) {
                map.removeLayer(geofenceLayer);
                geofenceLayer = null;
            }
            activeProject.geofence = null;
            activeProject.name = "Historischer Eintrag";

            // Update map if coordinates are available
            if (log.lat && log.lon) {
                activeCoords = { lat: log.lat, lon: log.lon };
                activeSource = "manual";
                updateMap(log.lat, log.lon);
            }

            // Switch tab first so canvases are visible and have proper dimensions
            switchTab('logbook-view');

            let sigsToLoad = 0;
            if (log.signature1) sigsToLoad++;
            if (log.signature2) sigsToLoad++;

            if (sigsToLoad === 0) {
                console.log("Daten aus dem Verlauf geladen (keine Signaturen).");
                return resolve();
            }

            let loaded = 0;
            const checkDone = () => {
                loaded++;
                if (loaded >= sigsToLoad) {
                    console.log("Daten aus dem Verlauf geladen (mit Signaturen).");
                    resolve();
                }
            };

            // Handle signatures if possible (this requires redrawing on the canvas)
            if (log.signature1) {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.getElementById('signaturePad1');
                    if (canvas) {
                        const ctx = canvas.getContext('2d');
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0);
                    }
                    checkDone();
                };
                img.onerror = checkDone;
                img.src = log.signature1;
            }
            
            if (log.signature2) {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.getElementById('signaturePad2');
                    if (canvas) {
                        const ctx = canvas.getContext('2d');
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0);
                        document.getElementById('lb_rpic2').disabled = false;
                    }
                    checkDone();
                };
                img.onerror = checkDone;
                img.src = log.signature2;
            }

        } catch (err) {
            console.error("Failed to load historical data", err);
            reject(err);
        }
    });
}

async function exportHistoricalLog(index) {
    try {
        await loadHistoricalData(index);
        // Wait a small moment for layout and signatures to fully stabilize
        setTimeout(() => {
            exportAppAsImage();
        }, 500);
    } catch (err) {
        console.error("Historical export failed", err);
    }
}

async function reUploadHistoricalLog(index) {
    try {
        const historyLogs = await localforage.getItem('uav_history_logs') || [];
        const log = historyLogs[index];
        if (!log) return;

        if (!navigator.onLine) {
            alert("Du bist offline. Upload zur Zeit nicht möglich.");
            return;
        }

        const btn = event.target;
        const originalText = btn.innerHTML;
        btn.innerHTML = '⏳...';
        btn.disabled = true;

        try {
            // Falls keine ID vorhanden ist (für alte Einträge), eine generieren
            if (!log.id) {
                log.id = Date.now() + Math.random().toString(36).substr(2, 9);
            }

            const responseText = await sendToGoogleDrive(log);
            if (responseText.startsWith("Error")) {
                throw new Error(responseText);
            }

            if (responseText === "Duplicate") {
                alert("Dieser Eintrag wurde bereits hochgeladen.");
            } else {
                alert("Logbuch erfolgreich hochgeladen!");
            }
            
            log.synced = true;
            await localforage.setItem('uav_history_logs', historyLogs);
            renderHistory();
        } catch (err) {
            throw err;
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    } catch (err) {
        console.error("Re-upload failed", err);
        alert("Fehler beim Hochladen: " + err.message);
    }
}

async function deleteHistoricalLog(index) {
    if (!confirm("Diesen Eintrag wirklich aus dem Verlauf löschen?")) return;
    
    try {
        const historyLogs = await localforage.getItem('uav_history_logs') || [];
        historyLogs.splice(index, 1);
        await localforage.setItem('uav_history_logs', historyLogs);
        renderHistory();
    } catch (err) {
        console.error("Failed to delete log", err);
    }
}

// Global scope injection
window.saveLogbook = saveLogbook;
window.loadHistoricalData = loadHistoricalData;
window.exportHistoricalLog = exportHistoricalLog;
window.reUploadHistoricalLog = reUploadHistoricalLog;
window.deleteHistoricalLog = deleteHistoricalLog;
window.renderHistory = renderHistory;

// Listen for online status to trigger sync
window.addEventListener('online', checkPendingLogs);

// Start
initApp();


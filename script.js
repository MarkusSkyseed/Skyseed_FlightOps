const APP_VERSION = "1.1.0";

// --- Defaults & Thresholds ---
const defaultThresholds = {
    condition: {
        type: 'categorical',
        mapping: {
            'clear-day': 'green', 'clear-night': 'green', 'partly-cloudy-day': 'green', 'partly-cloudy-night': 'green',
            'cloudy': 'green', 'fog': 'yellow', 'wind': 'yellow', 'rain': 'yellow',
            'sleet': 'yellow', 'snow': 'yellow', 'hail': 'red', 'thunderstorm': 'red'
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
        greenMin: 0, greenMax: 2.5,
        yellowMin: 2.5, yellowMax: 10,
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

// --- Global App State ---
let isOnline = navigator.onLine;
let selectedDateTime = null; // null means "now"

// --- Global Project State ---
let activeProject = {
    name: "Kein Projekt geladen",
    area: "",
    plans: [] // Array of { name, geofence, areaHa }
};

// --- Debug Logic ---
let versionClickCount = 0;
function logDebug(msg, data = null) {
    const out = document.getElementById('debugOutput');
    if (!out) return;
    const timestamp = new Date().toLocaleTimeString();
    out.innerHTML = `[${timestamp}] ${msg}\n` + (data ? JSON.stringify(data, null, 2) + '\n' : '') + out.innerHTML;
}

async function fetchWfsDetails(featureId) {
    if (!featureId) return null;
    const layerName = featureId.split('.')[0];
    const url = `https://uas-betrieb.de/geoservices/dipul/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=dipul:${layerName}&featureID=${featureId}&outputFormat=application/json`;
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.features && data.features.length > 0) {
            return data.features[0].properties;
        }
    } catch (e) {
        console.error("WFS detail fetch failed", e);
    }
    return null;
}

document.addEventListener('DOMContentLoaded', () => {
    const ver = document.querySelector('.app-version');
    if (ver) {
        ver.style.cursor = 'pointer';
        ver.addEventListener('click', () => {
            versionClickCount++;
            if (versionClickCount >= 5) {
                document.getElementById('debugOverlay').style.display = 'block';
                versionClickCount = 0;
                logDebug("Debug Modus aktiviert.");
            }
        });
    }
});

// --- Map & Location State ---
let map, marker, userMarker, userCircle, permanentWms, notamWms, geofenceLayer, pisLayerGroup, planListControl;
// geofenceLayer will be initialized as a FeatureGroup to hold multiple polygons
geofenceLayer = L.featureGroup();
let currentCoords = { lat: 0, lon: 0 }; // Browser Geolocation
let manualCoords = null;                // User Input
let activeCoords = { lat: 0, lon: 0 };  // Currently used for weather/ERP
let activeSource = "geolocation";       // 'geolocation', 'manual', 'polygon'
let currentCityName = "Unbekannt";
let isMapInitialized = false;
let pisData = [];                       // Hospital Heliports from PIS_parsed_final.json

// --- App Initialization ---
// --- App Initialization ---
async function initApp() {
    updateMetadata(); // Initial call
    updateLocationSourceBadge();
    updateProjectBanner();
    document.querySelector('.app-version').innerText = `App Version: ${APP_VERSION}`;

    // Load PIS Data
    try {
        const response = await fetch('Data/PIS_parsed_final.json');
        pisData = await response.json();
        console.log(`Geladene PIS Standorte: ${pisData.length}`);
        if (isMapInitialized) updatePisMarkers();
    } catch (e) {
        console.error("Fehler beim Laden der PIS Daten:", e);
    }

    if ("geolocation" in navigator) {
        const updateGPS = () => {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    currentCoords = { lat: position.coords.latitude, lon: position.coords.longitude };
                    updateMetadata(); // Update immediately once position is found
                    updateUserLocationMarker();
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
                { maximumAge: 10 * 1000, timeout: 5000, enableHighAccuracy: true }
            );
        };

        updateGPS();
        // Background update every minute
        setInterval(updateGPS, 60000);
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

    // --- Network Status ---
    window.addEventListener('online', () => {
        isOnline = true;
        updateOfflineBadge();
        refreshAllData(); // Auto-refresh when back online
    });
    window.addEventListener('offline', () => {
        isOnline = false;
        updateOfflineBadge();
    });
    updateOfflineBadge();

    // --- Forecast Time Logic ---
    const datePicker = document.getElementById('forecastDatePicker');
    const resetBtn = document.getElementById('resetDateBtn');
    const prevDayBtn = document.getElementById('prevDayBtn');
    const nextDayBtn = document.getElementById('nextDayBtn');
    
    // Set initial date
    if (datePicker) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        datePicker.value = `${year}-${month}-${day}T${hours}:${minutes}`;
        updateDatePickerBorder();
    }
    
    if (datePicker) {
        datePicker.addEventListener('change', (e) => {
            selectedDateTime = e.target.value;
            updateDatePickerBorder();
            refreshAllData();
        });
    }
    
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            selectedDateTime = null;
            if (datePicker) {
                const now = new Date();
                const year = now.getFullYear();
                const month = String(now.getMonth() + 1).padStart(2, '0');
                const day = String(now.getDate()).padStart(2, '0');
                const hours = String(now.getHours()).padStart(2, '0');
                const minutes = String(now.getMinutes()).padStart(2, '0');
                datePicker.value = `${year}-${month}-${day}T${hours}:${minutes}`;
            }
            updateDatePickerBorder();
            refreshAllData();
        });
    }

    if (prevDayBtn) {
        prevDayBtn.addEventListener('click', () => adjustDate(-1));
    }
    if (nextDayBtn) {
        nextDayBtn.addEventListener('click', () => adjustDate(1));
    }
}

function adjustDate(days) {
    const datePicker = document.getElementById('forecastDatePicker');
    if (!datePicker) return;

    let current = selectedDateTime ? new Date(selectedDateTime) : new Date();
    current.setDate(current.getDate() + days);
    
    const year = current.getFullYear();
    const month = String(current.getMonth() + 1).padStart(2, '0');
    const day = String(current.getDate()).padStart(2, '0');
    const hours = String(current.getHours()).padStart(2, '0');
    const minutes = String(current.getMinutes()).padStart(2, '0');
    
    const newVal = `${year}-${month}-${day}T${hours}:${minutes}`;
    datePicker.value = newVal;
    selectedDateTime = newVal;
    updateDatePickerBorder();
    refreshAllData();
}

function updateDatePickerBorder() {
    const datePicker = document.getElementById('forecastDatePicker');
    if (!datePicker) return;

    if (!selectedDateTime) {
        datePicker.style.borderColor = '#22c55e'; // Green for "Now"
        return;
    }

    const selected = new Date(selectedDateTime);
    const now = new Date();
    
    const isToday = selected.toDateString() === now.toDateString();
    
    // Calculate difference in days
    const diffTime = selected.getTime() - now.getTime();
    const diffDays = diffTime / (1000 * 60 * 60 * 24);

    if (isToday) {
        datePicker.style.borderColor = '#22c55e'; // Green
    } else if (diffDays > 0 && diffDays <= 7) {
        datePicker.style.borderColor = '#f59e0b'; // Orange
    } else if (diffDays > 7) {
        datePicker.style.borderColor = '#ef4444'; // Red
    } else {
        datePicker.style.borderColor = 'var(--card-border)'; // Default for past or other
    }
}

function updateOfflineBadge() {
    let badge = document.getElementById('offline-map-badge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'offline-map-badge';
        badge.innerHTML = '<span>⚠️ Offline-Daten (Luftraum)</span>';
        const mapContainer = document.getElementById('map');
        if (mapContainer) mapContainer.appendChild(badge);
    }
    
    if (badge) {
        badge.style.display = isOnline ? 'none' : 'flex';
    }
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
            // Update list 2 to exclude val1 and add N/A
            list2.innerHTML = allPilots
                .filter(p => p !== val1)
                .map(p => `<option value="${p}">`)
                .join('') + '<option value="N/A">';
        } else {
            rpic2.disabled = true;
            rpic2.value = "";
        }
    });
}

async function initOfflineStorage() {
    // Main Log Store
    localforage.config({
        name: 'UAV_FlightForecast',
        storeName: 'offline_logs'
    });

    // Secondary Airspace Cache
    window.airspaceCache = localforage.createInstance({
        name: "UAV_FlightForecast",
        storeName: "dipul_cache"
    });

    // Check for pending logs on startup
    checkPendingLogs();
}

function updateLocationText(text) {
    document.getElementById('locationText').innerText = text;
}

function updateMetadata() {
    const coordsEl = document.getElementById('geoCoords');
    const timeEl = document.getElementById('dateTime');

    if (coordsEl) {
        // Use activeCoords if available (manual or polygon), otherwise device coords
        const lat = activeCoords.lat || currentCoords.lat;
        const lon = activeCoords.lon || currentCoords.lon;
        
        if (lat !== 0 || lon !== 0) {
            const latDir = lat >= 0 ? 'N' : 'S';
            const lonDir = lon >= 0 ? 'E' : 'W';
            coordsEl.innerText = `GPS: ${Math.abs(lat).toFixed(4)}° ${latDir}, ${Math.abs(lon).toFixed(4)}° ${lonDir}`;
        } else {
            coordsEl.innerText = `GPS: Suche Standort...`;
        }
    }

    if (timeEl) {
        const now = selectedDateTime ? new Date(selectedDateTime) : new Date();
        const formattedDate = now.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
        const formattedTime = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const prefix = selectedDateTime ? "Vorhersage für" : "Log vom";
        timeEl.innerText = `${prefix}: ${formattedDate}, ${formattedTime} Uhr`;
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
    updateMetadata(); // Always update metadata first (local)

    // 1. Determine active coordinates
    if (activeProject.plans && activeProject.plans.length > 0) {
        activeSource = "polygon";
        // Use center of the FIRST plan for weather/ERP as requested
        const center = calculateCentroid(activeProject.plans[0].geofence);
        activeCoords = { lat: center.lat, lon: center.lon };
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

    let pWeather;
    // Open-Meteo with best_match (includes ICON for DE) to ensure 14 days availability
    const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,relative_humidity_2m,precipitation,cloud_cover,visibility,wind_speed_10m,wind_gusts_10m,wind_direction_10m,shortwave_radiation,weather_code&timezone=auto&forecast_days=14`;

    pWeather = fetch(omUrl)
        .then(r => r.json())
        .then(data => {
            if (!data.hourly) throw new Error("Keine stündlichen Daten von Open-Meteo erhalten");
            
            let idx = 0;
            const target = selectedDateTime ? new Date(selectedDateTime).getTime() : new Date().getTime();
            
            // Find index closest to target time
            let minDiff = Infinity;
            data.hourly.time.forEach((t, i) => {
                const diff = Math.abs(new Date(t).getTime() - target);
                if (diff < minDiff) {
                    minDiff = diff;
                    idx = i;
                }
            });

            // Threshold for "stale" data (3 hours) OR missing data at that index
            const isStale = minDiff > 3 * 3600 * 1000 || data.hourly.temperature_2m[idx] === null;

            // Map Open-Meteo response to internal format
            return {
                isStale,
                temperature: data.hourly.temperature_2m[idx],
                icon: wmoToCondition(data.hourly.weather_code[idx]),
                cloud_cover: data.hourly.cloud_cover[idx] ?? 0,
                wind_speed_10: data.hourly.wind_speed_10m[idx] ?? 0,
                wind_gusts_10: data.hourly.wind_gusts_10m[idx] ?? 0,
                wind_direction_10: data.hourly.wind_direction_10m[idx] ?? 0,
                solar_60: data.hourly.shortwave_radiation[idx] ?? 0,
                relative_humidity: data.hourly.relative_humidity_2m[idx] ?? 0,
                precipitation_60: data.hourly.precipitation[idx] ?? 0,
                visibility: data.hourly.visibility[idx] ?? 0
            };
        })
        .catch(err => {
            console.warn("Open-Meteo Fehler, wechsle zu Bright Sky Fallback:", err);
            if (selectedDateTime) {
                const dateIso = new Date(selectedDateTime).toISOString();
                return fetch(`https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}&date=${dateIso}`).then(r => r.json()).then(d => d.weather[0]);
            } else {
                return fetch(`https://api.brightsky.dev/current_weather?lat=${lat}&lon=${lon}`).then(r => r.json()).then(d => d.weather);
            }
        });

    const pAlerts = fetch(`https://api.brightsky.dev/alerts?lat=${lat}&lon=${lon}`).then(r => r.json()).catch(() => ({ alerts: [] }));
    const pKp = fetchKpIndex(selectedDateTime);
    
    let pPis = [];
    if (activeProject.plans && activeProject.plans.length > 0) {
        const allPis = [];
        activeProject.plans.forEach(plan => {
            allPis.push(...checkPisIntersections(lat, lon, plan.geofence));
        });
        // Unique PIS by ID
        pPis = [...new Map(allPis.map(item => [item.id, item])).values()];
    } else {
        pPis = checkPisIntersections(lat, lon, null);
    }

    // Trigger ERP search proactively
    initErpData();

    // For dipul: use combined BBOX check for all polygons
    let pDipul;
    if (activeSource === "polygon" && activeProject.plans && activeProject.plans.length > 0) {
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        
        activeProject.plans.forEach(plan => {
            plan.geofence.forEach(pt => {
                if (pt[0] < minLat) minLat = pt[0];
                if (pt[0] > maxLat) maxLat = pt[0];
                if (pt[1] < minLon) minLon = pt[1];
                if (pt[1] > maxLon) maxLon = pt[1];
            });
        });

        // Use the combined BBOX for the DIPUL request
        const bboxString = `${minLat},${minLon},${maxLat},${maxLon}`;
        pDipul = fetchDipulData(bboxString, 'bbox');
    } else {
        pDipul = fetchDipulData(activeCoords, 'point');
    }

    try {
        const [weatherData, alertsData, kpIndex, dipulData] = await Promise.all([pWeather, pAlerts, pKp, pDipul]);
        
        // Ensure we have currentWeatherData (from Open-Meteo or Fallback)
        currentWeatherData = weatherData;

        let alerts = alertsData.alerts || [];

        // Filter alerts by time/date to ensure they only show when active for the selected forecast period
        const targetTime = selectedDateTime ? new Date(selectedDateTime).getTime() : new Date().getTime();
        alerts = alerts.filter(a => {
            const onset = new Date(a.onset).getTime();
            const expires = new Date(a.expires).getTime();
            return targetTime >= onset && targetTime <= expires;
        });

        renderApp(currentWeatherData, kpIndex, dipulData, alerts, pPis);
    } catch (error) {
        console.error("Data Load Error:", error);
        const banner = document.getElementById('flight-status');
        const sub = document.getElementById('flight-status-sub');
        banner.className = "status-banner danger";
        banner.querySelector('h2').innerText = "Fehler";
        if (sub) {
            sub.innerText = "Daten konnten nicht geladen werden.";
        } else {
            banner.innerHTML = "<h2>Fehler</h2><p id='flight-status-sub'>Daten konnten nicht geladen werden.</p>";
        }
    }
}

async function fetchKpIndex(targetDate = null) {
    if (targetDate) {
        return await fetchKpForecast(targetDate);
    }

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

async function fetchKpForecast(targetDate) {
    try {
        const target = new Date(targetDate).getTime();
        const res = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json');
        const data = await res.json();
        
        if (!data || data.length <= 1) return null;
        
        // Header: ["time_tag", "kp", "observed", "noaa_scale"]
        // We look for the entry closest to our target time
        let closestEntry = null;
        let minDiff = Infinity;
        
        for (let i = 1; i < data.length; i++) {
            const entryTime = new Date(data[i][0]).getTime();
            const diff = Math.abs(target - entryTime);
            if (diff < minDiff) {
                minDiff = diff;
                closestEntry = data[i];
            }
        }
        
        // Return if it's reasonably close (within 4 hours, as Kp is 3h resolution)
        if (minDiff < 4 * 60 * 60 * 1000) {
            return parseFloat(closestEntry[1]);
        }
    } catch (e) { console.warn("Kp forecast fetch failed", e); }
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

const wmoMapping = {
    0: 'clear-day',
    1: 'partly-cloudy-day', 2: 'partly-cloudy-day', 3: 'partly-cloudy-day',
    45: 'fog', 48: 'fog',
    51: 'rain', 53: 'rain', 55: 'rain',
    61: 'rain', 63: 'rain', 65: 'rain',
    71: 'snow', 73: 'snow', 75: 'snow',
    80: 'rain', 81: 'rain', 82: 'rain',
    95: 'thunderstorm', 96: 'thunderstorm', 99: 'thunderstorm'
};

function wmoToCondition(code) {
    return wmoMapping[code] || 'cloudy';
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

function formatDipulHeight(p, prefix) {
    if (!p) return null;
    
    const keys = Object.keys(p);
    // Find keys that start with prefix and have a non-null value
    const candidateKeys = keys.filter(k => {
        const kl = k.toLowerCase();
        return kl.startsWith(prefix) && (
            kl.includes('limit_altitude') || 
            kl.includes('limit_value') || 
            kl.endsWith('limit') ||
            kl.includes('altitude')
        );
    });

    // Pick the first key that actually has a value (including 0)
    const valKey = candidateKeys.find(k => p[k] !== null && p[k] !== undefined && p[k] !== "");
    if (!valKey) return null;

    let val = p[valKey];
    let num = parseFloat(val);
    if (isNaN(num)) return val;

    const kl = valKey.toLowerCase();
    
    // Determine reference
    let ref = '';
    if (kl.includes('_msl')) ref = 'MSL';
    else if (kl.includes('_agl')) ref = 'GND';
    else if (kl.includes('_pa')) ref = 'STD';
    else {
        const refKey = keys.find(k => k.toLowerCase().includes(prefix) && (k.toLowerCase().includes('ref') || k.toLowerCase().includes('reference')));
        if (refKey) {
            const r = String(p[refKey]).toUpperCase();
            ref = (r === 'AGL' || r === 'SURFACE') ? 'GND' : r;
        }
    }

    // Determine unit (aviation default is feet if not specified in altitude fields)
    let unit = 'm';
    const unitKey = keys.find(k => k.toLowerCase().includes(prefix) && (k.toLowerCase().includes('unit') || k.toLowerCase().includes('uom')));
    
    if (unitKey && p[unitKey]) {
        unit = String(p[unitKey]).toLowerCase();
    } else if (kl.includes('altitude') || kl.includes('limit')) {
        unit = 'ft';
    }

    let displayValue = num;
    if (unit.includes('ft') || unit === 'f') {
        displayValue = Math.round(num * 0.3048);
    } else {
        displayValue = Math.round(num);
    }
    
    return `${displayValue}m ${ref}`.trim();
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

    // Initialize geofenceLayer as a FeatureGroup and add to map
    geofenceLayer = L.featureGroup().addTo(map);

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

    pisLayerGroup = L.layerGroup().addTo(map);

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
        div.style.display = (activeProject.plans && activeProject.plans.length > 0) ? 'block' : 'none';
        div.innerHTML = '<button title="Auf Projekt-Fläche zentrieren" style="background:#1e293b; border:none; color:white; padding:5px 8px; cursor:pointer; font-size:1.2rem; border-radius:4px;">🗺️</button>';
        div.onclick = function (e) {
            e.stopPropagation();
            if (geofenceLayer && geofenceLayer.getLayers().length > 0) {
                map.fitBounds(geofenceLayer.getBounds(), { padding: [50, 50] });
            }
        };
        return div;
    };
    polyCenterIcon.addTo(map);

    map.on('click', (e) => identifyFeature(e.latlng));
    
    // Initialize Plan List Control
    initPlanListControl();
    
    isMapInitialized = true;
}

/**
 * Initializes the Plan List Control on the map.
 */
function initPlanListControl() {
    planListControl = L.control({ position: 'bottomleft' });
    planListControl.onAdd = function () {
        const div = L.DomUtil.create('div', 'plan-list-overlay');
        div.id = 'mapPlanList';
        div.style.backgroundColor = 'rgba(15, 23, 42, 0.85)';
        div.style.padding = '8px';
        div.style.borderRadius = '8px';
        div.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        div.style.color = 'white';
        div.style.fontSize = '0.75rem';
        div.style.maxHeight = '150px';
        div.style.overflowY = 'auto';
        div.style.pointerEvents = 'auto';
        div.style.display = 'none';
        div.style.marginBottom = '20px';
        div.style.marginLeft = '10px';
        div.style.backdropFilter = 'blur(4px)';
        return div;
    };
    planListControl.addTo(map);
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
    if (activeProject.plans && activeProject.plans.length > 0 && geofenceLayer) {
        map.fitBounds(geofenceLayer.getBounds(), { padding: [50, 50] });
    } else {
        map.setView([lat, lon], 12); // Festgelegter Zoom 12
    }

    if (marker) {
        marker.setLatLng([lat, lon]);
    } else {
        marker = L.marker([lat, lon]).addTo(map);
    }

    updateUserLocationMarker();
    updatePisMarkers();
}

/**
 * Updates the user's current GPS position marker on the map.
 * Distinguished by a blue circle style.
 */
function updateUserLocationMarker() {
    if (!map || !currentCoords.lat) return;

    const latlng = [currentCoords.lat, currentCoords.lon];

    if (userMarker) {
        userMarker.setLatLng(latlng);
        userCircle.setLatLng(latlng);
    } else {
        // User marker (blue dot)
        userMarker = L.circleMarker(latlng, {
            radius: 7,
            fillColor: "#3b82f6",
            color: "#ffffff",
            weight: 2,
            opacity: 1,
            fillOpacity: 0.9,
            pane: 'markerPane'
        }).addTo(map);

        // Accuracy circle (faint blue)
        userCircle = L.circle(latlng, {
            radius: 20, // Static 20m or dynamic if available
            fillColor: "#3b82f6",
            fillOpacity: 0.1,
            weight: 0,
            pane: 'markerPane'
        }).addTo(map);
        
        userMarker.bindPopup("Ihr aktueller Standort");
    }
}

function updatePisMarkers() {
    if (!map || !pisLayerGroup || !pisData || !pisData.length) return;
    
    pisLayerGroup.clearLayers();
    
    pisData.forEach(pis => {
        if (!pis.lat || !pis.lon) return;

        // Lila 300m Schutzbereich (durchgehende Linie, kein Mittelpunkt)
        L.circle([pis.lat, pis.lon], {
            radius: 300,
            color: '#800080',
            fillColor: '#800080',
            fillOpacity: 0.15,
            weight: 2,
            interactive: false // Disabled individual popup to handle via unified identifyFeature
        }).addTo(pisLayerGroup);
    });
}

function checkPisIntersections(lat, lon, geofence = null) {
    const criticalPis = [];
    const PROTECTION_RADIUS = 300; // Meter

    pisData.forEach(pis => {
        const pisLatLng = L.latLng(pis.lat, pis.lon);
        let isIntersecting = false;

        if (geofence && geofence.length > 0) {
            // 1. Check if any polygon corner is within radius
            for (let pt of geofence) {
                if (pisLatLng.distanceTo(L.latLng(pt[0], pt[1])) <= PROTECTION_RADIUS) {
                    isIntersecting = true;
                    break;
                }
            }
            
            // 2. Check if the centroid is within radius
            if (!isIntersecting) {
                const centroid = calculateCentroid(geofence);
                if (pisLatLng.distanceTo(L.latLng(centroid.lat, centroid.lon)) <= PROTECTION_RADIUS) {
                    isIntersecting = true;
                }
            }
            
            // 3. Optional: Check if PIS center is inside polygon (rough check via bounds)
            if (!isIntersecting && geofenceLayer) {
                // Leaflet's contains check for points is not directly on the polygon object without a plugin
                // but we can use the bounds as a heuristic or the geofenceLayer if it's rendered
                const bounds = geofenceLayer.getBounds();
                if (bounds.contains(pisLatLng)) {
                    // This is still just a box check, but better than nothing
                    // For now, centroid and corners cover most cases for 300m
                }
            }
        } else {
            // Check distance from active point
            if (pisLatLng.distanceTo(L.latLng(lat, lon)) <= PROTECTION_RADIUS) {
                isIntersecting = true;
            }
        }

        if (isIntersecting) {
            criticalPis.push(pis);
        }
    });

    return criticalPis;
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
    let cacheKey;

    if (type === 'bbox' || type === 'point') {
        const bbox = type === 'point'
            ? `${bboxOrPoint.lat - 0.0001},${bboxOrPoint.lon - 0.0001},${bboxOrPoint.lat + 0.0001},${bboxOrPoint.lon + 0.0001}`
            : bboxOrPoint;

        url = `https://uas-betrieb.de/geoservices/dipul/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo&LAYERS=${layers}&QUERY_LAYERS=${layers}&BBOX=${bbox}&FEATURE_COUNT=50&HEIGHT=1000&WIDTH=1000&INFO_FORMAT=application/json&I=500&J=500&CRS=EPSG:4326`;
        
        // Cache Key based on rounded coords for points or raw string for bbox
        cacheKey = type === 'point' 
            ? `pt_${bboxOrPoint.lat.toFixed(4)}_${bboxOrPoint.lon.toFixed(4)}`
            : `bbox_${bbox}`;
    }

    // Try cache first if offline
    if (!isOnline && cacheKey && window.airspaceCache) {
        const cached = await window.airspaceCache.getItem(cacheKey);
        if (cached) return cached;
    }

    try {
        const res = await fetch(url);
        const data = await res.json();
        
        // Save to cache if successful
        if (data && cacheKey && window.airspaceCache) {
            window.airspaceCache.setItem(cacheKey, data);
        }
        
        return data;
    } catch (e) {
        console.error("dipul check failed", e);
        // Fallback to cache even if online fetch fails
        if (cacheKey && window.airspaceCache) {
            return await window.airspaceCache.getItem(cacheKey);
        }
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
    if (!polygon || polygon.length === 0) return { lat: 0, lon: 0 };
    let lat = 0, lon = 0;
    polygon.forEach(p => {
        lat += p[0];
        lon += p[1];
    });
    return { lat: lat / polygon.length, lon: lon / polygon.length };
}

/**
 * Calculates the area of a polygon in hectares (ha).
 * Uses a planar approximation suitable for UAV flight areas.
 * @param {Array} latlngs Array of [lat, lon] coordinates
 * @returns {number} Area in hectares
 */
function calculatePolygonArea(latlngs) {
    if (!latlngs || latlngs.length < 3) return 0;
    
    let area = 0;
    const points = latlngs.map(p => {
        const lat = p[0];
        const lon = p[1];
        return {
            x: lon * Math.cos(lat * Math.PI / 180) * 111320,
            y: lat * 111320
        };
    });
    
    for (let i = 0; i < points.length; i++) {
        const p1 = points[i];
        const p2 = points[(i + 1) % points.length];
        area += (p1.x * p2.y) - (p2.x * p1.y);
    }
    
    return Math.abs(area) / 2 / 10000;
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
        
        logDebug(`IDENTIFY (${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)})`, data);

        let content = '<div style="min-width: 200px; color: white; background: #1e293b; padding: 10px; border-radius: 8px;">';
        let foundAny = false;

        // 1. Check local PIS data
        const PROTECTION_RADIUS = 300;
        pisData.forEach(pis => {
            const pisLatLng = L.latLng(pis.lat, pis.lon);
            if (latlng.distanceTo(pisLatLng) <= PROTECTION_RADIUS) {
                foundAny = true;
                content += `<div style="margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:4px;">
                    <strong style="color:#e879f9;">📍 PIS: ${pis.name}</strong><br>
                    <div style="font-size:0.8rem; opacity:0.9;">Code: ${pis.code}</div>
                    <div style="font-size:0.8rem; opacity:0.8;">Typ: ${pis.type}</div>
                    <div style="font-size:0.75rem; opacity:0.7; margin-top:4px;">(300m Schutzbereich)</div>
                </div>`;
            }
        });

        // 2. Process DIPUL WMS Features
        if (data.features && data.features.length > 0) {
            foundAny = true;
            // Parallel fetch details for all clicked features
            const detailedPropsList = await Promise.all(
                data.features.map(f => fetchWfsDetails(f.id))
            );

            logDebug(`ENRICHED PROPS`, detailedPropsList);

            data.features.forEach((f, idx) => {
                // Merge WMS properties with WFS details (WFS is more complete)
                const p = { ...f.properties, ...(detailedPropsList[idx] || {}) };
                const keys = Object.keys(p);
                const nameKey = keys.find(k => k.toLowerCase() === 'name');
                const name = p[nameKey] || p.name || p.NAME || '';

                const layerId = f.id.split('.')[0].replace('dipul:', '');
                const mapping = dipulLayerMapping[layerId] || { category: 'Luftraum', isPersistent: true };

                const lower = formatDipulHeight(p, 'lower');
                const upper = formatDipulHeight(p, 'upper') || 'unbegrenzt';
                const heightInfo = lower ? `${lower} - ${upper}` : upper;

                let timeInfo = '';
                const beginKey = keys.find(k => k.toLowerCase().includes('begin') || k.toLowerCase().includes('valid_from') || k.toLowerCase().includes('start'));
                const endKey = keys.find(k => k.toLowerCase().includes('end') || k.toLowerCase().includes('valid_to'));
                
                if (p[beginKey]) {
                    const options = { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
                    const start = new Date(p[beginKey]).toLocaleString('de-DE', options);
                    const end = p[endKey] ? new Date(p[endKey]).toLocaleString('de-DE', options) : 'unbekannt';
                    timeInfo = `<div style="font-size:0.75rem; opacity:0.7; margin-top:4px;">📅 Start: ${start}<br>📅 Ende: ${end}</div>`;
                }

                content += `<div style="margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:4px;">
                    <strong style="color:var(--accent-color);">${layerId.includes('temporaere') ? '⚠️ ' : ''}${name || mapping.category}</strong><br>
                    <div style="font-size:0.8rem; opacity:0.9;">↕️ ${heightInfo}</div>
                    <div style="font-size:0.8rem; opacity:0.8;">Kategorie: ${mapping.category}</div>
                    ${timeInfo}
                </div>`;
            });
        }

        if (foundAny) {
            content += '</div>';
            L.popup().setLatLng(latlng).setContent(content).openOn(map);
        }
    } catch (e) { console.error(e); }
}

// --- Render Logic ---
function renderApp(weather, kpIndex, dipulData, alerts = [], criticalPis = []) {
    const grid = document.getElementById('weatherGrid');
    
    // Check for stale or missing data (requested time outside forecast range)
    if (!weather || weather.isStale) {
        const banner = document.getElementById('flight-status');
        const sub = document.getElementById('flight-status-sub');
        banner.className = 'status-banner danger';
        banner.querySelector('h2').innerText = 'Keine Vorhersagedaten';
        sub.innerText = 'Der gewählte Zeitraum liegt außerhalb der verfügbaren Vorhersage (max. 14 Tage).';
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 2rem; opacity: 0.6;">Wetterdaten für diesen Zeitpunkt nicht verfügbar.</div>';
        return;
    }

    const windSpeed = weather.wind_speed || weather.wind_speed_10 || 0;
    const windGusts = weather.wind_gusts_10 || 0;
    const precipitation = weather.precipitation_60 || weather.precipitation_30 || weather.precipitation_10 || 0;
    const solarRad = weather.solar_60 || weather.solar_30 || weather.solar_10 || 0;

    // Wind Logic with Gusts and Color-Thresholds
    let windColorClass = getTileColor('wind_speed', windSpeed);
    const windMaxThreshold = 35; // Red limit for normal wind speed

    if (windColorClass !== 'status-red') {
        if (windGusts > windMaxThreshold * 1.5) {
            windColorClass = 'status-red';
        } else if (windGusts > windMaxThreshold) {
            windColorClass = 'status-yellow';
        }
    }

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
    
    let details = [];
    let hasCritical = false;

    // Add PIS warnings
    if (criticalPis && criticalPis.length > 0) {
        hasCritical = true;
        criticalPis.forEach(pis => {
            details.push(`⚠️ <strong>PIS: ${pis.name}</strong> (300m Schutzbereich)`);
        });
    }

    if (dipulData && dipulData.features && dipulData.features.length > 0) {
        dipulData.features.forEach(f => {
            const p = f.properties;
            const keys = Object.keys(p);
            const nameKey = keys.find(k => k.toLowerCase() === 'name');
            
            const layerId = f.id.split('.')[0].replace('dipul:', '');
            const mapping = dipulLayerMapping[layerId] || { category: 'Luftraum', isPersistent: true };

            const isNotam = !mapping.isPersistent || layerId.includes('temporaere');
            const isCritical = isNotam || layerId.includes('kontrollzonen') || layerId.includes('flugbeschraenk');

            if (isCritical) hasCritical = true;

            const lower = formatDipulHeight(p, 'lower');
            const upper = formatDipulHeight(p, 'upper') || 'unbegrenzt';
            const hStr = lower ? `${lower}-${upper}` : upper;

            const name = p[nameKey] || p.name || p.NAME || mapping.category;
            const label = isCritical
                ? `⚠️ <strong>${isNotam ? 'NOTAM: ' : ''}${name}</strong> (${hStr})`
                : `• ${name} (${hStr})`;
            details.push(label);
        });
    }

    if (details.length > 0) {
        airStatusText = [...new Set(details)].join('<br>');
        airColorClass = hasCritical ? "status-red" : "status-yellow";
    }

    const tilesData = [
        { label: 'Temperatur', value: `${Math.round(weather.temperature)}`, unit: '°C', icon: '🌡️', colorClass: getTileColor('temp', weather.temperature) },
        { label: 'Zustand', value: translateCondition(weather.icon), unit: '', icon: getIcon(weather.icon), colorClass: getTileColor('condition', weather.icon) },
        { label: 'Bewölkung', value: `${weather.cloud_cover}`, unit: '%', icon: '☁️', colorClass: 'status-green' },

        { 
            label: 'Windgeschw.', 
            value: `${Math.round(windSpeed)}`, 
            unit: 'km/h', 
            icon: '💨', 
            extra: `${getCompassDirection(weather.wind_direction_10)}<br><span style="font-size: 0.8rem; opacity: 0.9;">Böen: ${Math.round(windGusts)} km/h</span>`, 
            colorClass: windColorClass 
        },
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
        windSpeed,
        windGusts,
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

function autoFillLogbookWeather(condition, temp, wind, gusts, precip, kp, visibility) {
    const weatherField = document.getElementById('lb_weather');
    if (weatherField) {
        const kpText = kp !== null ? `Kp: ${kp.toFixed(1)}` : "Kp: k.A.";
        const visText = visibility !== null ? `Sicht: ${Math.round(visibility / 1000)}km` : "Sicht: k.A.";
        const windText = `Wind: ${Math.round(wind)} (${Math.round(gusts)}) km/h`;
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
            if (['fog', 'wind', 'rain', 'sleet', 'snow'].includes(value)) return 'status-yellow';
            return 'status-red';
        case 'wind_speed':
            if (value <= 20) return 'status-green';
            if (value > 20 && value <= 35) return 'status-yellow';
            return 'status-red';
        case 'precip':
            if (value <= 2.5) return 'status-green';
            if (value > 2.5 && value <= 10) return 'status-yellow';
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
        activeSource = (activeProject.plans && activeProject.plans.length > 0) ? "polygon" : "geolocation";
        refreshAllData();
    }
});

// --- Refresh Button ---
// (Entfernt, da nicht mehr benötigt)

// --- Export Logic ---
async function triggerExport() {
    updateStatusProgress("Export wird vorbereitet...", 5);
    try {
        const canvas = await generateScreenshotCanvas((msg, p) => updateStatusProgress(msg, p));
        updateStatusProgress("Bereit zum Teilen/Speichern...", 95);
        
        canvas.toBlob(async (blob) => {
            const fileName = `Skyseed_FlightLog_${activeProject.name || 'Export'}_${new Date().toISOString().split('T')[0]}.png`;
            const file = new File([blob], fileName, { type: 'image/png' });

            // Bevorzugt natives Teilen-Menü öffnen
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({
                        files: [file],
                        title: 'Skyseed Flug-Logbuch',
                        text: `Logbuch-Export für Projekt: ${activeProject.name || 'Export'}`
                    });
                    hideStatusProgress();
                    return; // Erfolgreich geteilt
                } catch (shareErr) {
                    console.warn("Teilen abgebrochen oder fehlgeschlagen, weiche auf Download aus.", shareErr);
                }
            }

            // Fallback: Direkter Download, falls Teilen nicht unterstützt oder abgebrochen wurde
            downloadBlob(blob, fileName);
            hideStatusProgress();
        }, 'image/png');
    } catch (e) {
        console.error("Export Error:", e);
        hideStatusProgress();
        alert("Export fehlgeschlagen.");
    }
}

document.getElementById('exportBtn').addEventListener('click', triggerExport);

async function updateStatusProgress(message, percentage) {
    let overlay = document.getElementById('status-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'status-overlay';
        overlay.innerHTML = `
            <div class="status-overlay-content">
                <div class="status-spinner"></div>
                <div id="status-message">Vorbereiten...</div>
                <div class="progress-bar-container">
                    <div id="status-progress-bar"></div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        
        const style = document.createElement('style');
        style.textContent = `
            #status-overlay {
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(15, 23, 42, 0.85); display: flex; align-items: center; justify-content: center;
                z-index: 10000; backdrop-filter: blur(8px); font-family: 'Outfit', sans-serif;
            }
            .status-overlay-content { text-align: center; width: 80%; max-width: 400px; }
            #status-message { color: white; margin-bottom: 1rem; font-size: 1.2rem; font-weight: 600; }
            .progress-bar-container { width: 100%; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; }
            #status-progress-bar { width: 0%; height: 100%; background: var(--accent-color, #38bdf8); transition: width 0.3s ease; }
            .status-spinner { 
                width: 40px; height: 40px; border: 4px solid rgba(255,255,255,0.1); border-top-color: var(--accent-color, #38bdf8);
                border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 1.5rem; 
            }
            @keyframes spin { to { transform: rotate(360deg); } }
        `;
        document.head.appendChild(style);
    }
    overlay.style.display = 'flex';
    document.getElementById('status-message').innerText = message;
    document.getElementById('status-progress-bar').style.width = percentage + '%';
}

function hideStatusProgress() {
    const overlay = document.getElementById('status-overlay');
    if (overlay) overlay.style.display = 'none';
}

async function generateScreenshotCanvas(onProgress) {
    if (onProgress) onProgress("Initialisiere Export...", 10);
    // FIX: Scroll to top to prevent offset issues with html2canvas
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    window.scrollTo(0, 0);

    window.getSelection().removeAllRanges();

    const buttonsToHide = document.querySelectorAll('#exportBtn, #historyBtn, #planImportBtn, .nav-btn, .bottom-nav, .signature-tools, .btn-small, #prevDayBtn, #nextDayBtn, #resetDateBtn');
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
        .log-input { background: rgba(255,255,255,0.05) !important; }
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
        if (onProgress) onProgress("Erfasse Karte...", 25);
        const liveMap = document.getElementById('map');
        
        // FIX: Karte vor dem Screenshot explizit zentrieren
        if (map) {
            if (activeProject.plans && activeProject.plans.length > 0 && geofenceLayer) {
                map.fitBounds(geofenceLayer.getBounds(), { padding: [50, 50], animate: false });
            } else if (activeCoords.lat !== 0) {
                map.setView([activeCoords.lat, activeCoords.lon], 11, { animate: false });
            }
            map.invalidateSize({ animate: false });
            // Längere Wartezeit für Kacheln und Marker-Ausrichtung
            await new Promise(r => setTimeout(r, 400));
        }

        // Get map dimensions for proper rendering
        const mapCanvas = await html2canvas(liveMap, { 
            useCORS: true, 
            logging: false,
            allowTaint: true,
            scale: 1, // Höhere Auflösung für den Export
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
        if (onProgress) onProgress("Baue Dokument zusammen...", 50);
        const headerClone = document.querySelector('header').cloneNode(true);
        
        // Remove interactive elements from header clone
        headerClone.querySelectorAll('button, label, #manualInputContainer').forEach(el => el.remove());
        wrapper.appendChild(headerClone);

        const statusTitle = document.createElement('div');
        statusTitle.className = 'export-section-title';
        statusTitle.innerText = 'I. AKTUELLER STATUS & WETTER';
        wrapper.appendChild(statusTitle);

        const dashboardView = document.getElementById('dashboard-view').cloneNode(true);
        dashboardView.style.display = 'block';
        dashboardView.style.opacity = '1';

        // Improve date display in export
        const dateInput = dashboardView.querySelector('#forecastDatePicker');
        if (dateInput) {
            const originalInput = document.getElementById('forecastDatePicker');
            const dateValue = originalInput.value;
            const borderColor = originalInput.style.borderColor;
            
            let displayText = "Live-Daten / Jetzt";
            if (dateValue) {
                const d = new Date(dateValue);
                displayText = d.toLocaleString('de-DE', { 
                    day: '2-digit', month: '2-digit', year: 'numeric', 
                    hour: '2-digit', minute: '2-digit' 
                }) + " Uhr";
            }
            
            const replacement = document.createElement('div');
            replacement.className = 'log-input';
            replacement.style.cssText = dateInput.style.cssText;
            replacement.style.borderColor = borderColor;
            replacement.style.display = 'flex';
            replacement.style.alignItems = 'center';
            replacement.style.paddingLeft = '2.5rem';
            replacement.style.color = 'white';
            replacement.style.width = '100%';
            replacement.innerText = displayText;
            
            // Remove the +/- buttons and "Jetzt" button from the clone in its new location
            const buttonsInClone = dateInput.parentNode.querySelectorAll('button');
            buttonsInClone.forEach(b => b.remove());
            
            dateInput.parentNode.replaceChild(replacement, dateInput);
        }

        // FIX: Die fehlerhafte geklonte Map durch unser statisches Bild ersetzen
        const clonedMap = dashboardView.querySelector('#map');
        if (clonedMap && mapDataUrl) {
            clonedMap.style.height = '360px'; // Deutlich tiefer für den Export
            clonedMap.style.width = '100%';
            clonedMap.style.border = 'none';
            clonedMap.style.margin = '1.5rem 0';
            clonedMap.innerHTML = `<img src="${mapDataUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 1rem; display: block;" />`;
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

        await new Promise(r => setTimeout(r, 400));

        if (onProgress) onProgress("Generiere finales Bild...", 75);
        const canvas = await html2canvas(wrapper, {
            scale: 1.5,
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
let hasSignature1 = false, hasSignature2 = false; // Neu: Status für Unterschriften
let lastX1 = 0, lastY1 = 0;
let lastX2 = 0, lastY2 = 0;

function initSignaturePads() {
    const canvas1 = document.getElementById('signaturePad1');
    const canvas2 = document.getElementById('signaturePad2');

    if (canvas1) {
        signatureCtx1 = canvas1.getContext('2d');
        setupCanvas(canvas1, signatureCtx1, (id) => isDrawing1 = id, (val) => isDrawing1 = val, () => isDrawing1, (x, y) => { lastX1 = x; lastY1 = y; }, () => [lastX1, lastY1], () => hasSignature1 = true);
    }
    if (canvas2) {
        signatureCtx2 = canvas2.getContext('2d');
        setupCanvas(canvas2, signatureCtx2, (id) => isDrawing2 = id, (val) => isDrawing2 = val, () => isDrawing2, (x, y) => { lastX2 = x; lastY2 = y; }, () => [lastX2, lastY2], () => hasSignature2 = true);
    }
}

function setupCanvas(canvas, ctx, setIsDrawing, getIsDrawingSet, getIsDrawing, setLastPos, getLastPos, onDraw) {
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
        if (onDraw) onDraw(); // Markiert das Feld als unterschrieben
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
        // Status zurücksetzen
        if (num === 1) hasSignature1 = false;
        if (num === 2) hasSignature2 = false;
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
    updateDfsInfo(lat, lon);
    erpDataFetched = true;
}

function updateDfsInfo(lat, lon) {
    const dfsInfoEl = document.getElementById('closestDfsInfo');
    if (!dfsInfoEl) return;

    // DFS Centres Data
    const dfsCentres = [
        {
            name: "DFS Bremen Control Centre",
            region: "Norddeutschland",
            desc: "Zuständig für den norddeutschen Luftraum",
            lat: 53.0500,
            lon: 8.7833,
            phone: "+49 421 53720"
        },
        {
            name: "DFS Munich Control Centre",
            region: "Süddeutschland",
            desc: "Zuständig für den süddeutschen Luftraum (Nordallee München-Flughafen)",
            lat: 48.3538,
            lon: 11.7861,
            phone: "+49 89 97800"
        },
        {
            name: "DFS Langen Control Centre",
            region: "Mitte Deutschlands",
            desc: "Zuständig für die Mitte Deutschlands (DFS-Campus/Frankfurter Raum)",
            lat: 49.9917,
            lon: 8.6631,
            phone: "+49 6103 7070"
        }
    ];

    // Find closest based on latitude primarily for North/Central/South distinction,
    // or just use Haversine to find the geometrically closest.
    let closest = dfsCentres[0];
    let minDist = Infinity;

    dfsCentres.forEach(centre => {
        const dist = calculateHaversineDistance(lat, lon, centre.lat, centre.lon);
        if (dist < minDist) {
            minDist = dist;
            closest = centre;
        }
    });

    dfsInfoEl.innerHTML = `
        <div style="color: var(--accent-color);">${closest.name} (${closest.region})</div>
        <div style="font-size: 0.85rem; font-weight: normal; opacity: 0.9; margin: 0.25rem 0;">${closest.desc}</div>
        <div style="margin-top: 0.4rem;">📞 <a href="tel:${closest.phone.replace(/\s/g, '')}" style="color: white; text-decoration: none;">${closest.phone}</a></div>
    `;
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
document.getElementById('planFileInput').addEventListener('change', async function (e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    for (const file of files) {
        await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = function (event) {
                try {
                    const planData = JSON.parse(event.target.result);
                    let filename = file.name.replace('.plan', '');

                    // Check if a plan with the same name is already loaded
                    if (activeProject.plans.some(p => p.name === filename)) {
                        resolve();
                        return;
                    }

                    // Extraction of Geofence Polygons from QGroundControl .plan
                    if (planData.geoFence && planData.geoFence.polygons) {
                        const polygons = planData.geoFence.polygons.filter(p => p.inclusion === true);
                        if (polygons.length > 0) {
                            const polyCoords = polygons[0].polygon; // Assuming first inclusion polygon
                            const areaHa = calculatePolygonArea(polyCoords);

                            activeProject.plans.push({
                                name: filename,
                                geofence: polyCoords,
                                areaHa: areaHa
                            });
                        }
                    }
                } catch (error) {
                    console.error("Error parsing .plan file:", error);
                }
                resolve();
            };
            reader.readAsText(file);
        });
    }

    if (activeProject.plans.length > 0) {
        // Update project name for logging
        if (activeProject.plans.length === 1) {
            activeProject.name = activeProject.plans[0].name;
        } else {
            activeProject.name = `${activeProject.plans.length} Teilflächen Projekt`;
        }
        
        updatePolygonsOnMap();
        map.fitBounds(geofenceLayer.getBounds(), { padding: [50, 50] });
        updateProjectBanner();
        refreshAllData();
    }
    // Reset to allow re-importing same files if needed
    e.target.value = "";
});

document.getElementById('clearProjectBtn').addEventListener('click', clearActiveProject);

function clearActiveProject() {
    activeProject.name = "Kein Projekt geladen";
    activeProject.area = "";
    activeProject.plans = [];
    
    updatePolygonsOnMap();
    document.getElementById('planFileInput').value = "";
    updateProjectBanner();
    refreshAllData();
}

/**
 * Updates the polygons on the map and binds popups with area information.
 */
function updatePolygonsOnMap() {
    if (!geofenceLayer) return;
    geofenceLayer.clearLayers();
    
    const totalArea = activeProject.plans.reduce((sum, p) => sum + p.areaHa, 0);
    const planListDiv = document.getElementById('mapPlanList');
    
    if (planListDiv) {
        if (activeProject.plans.length > 0) {
            planListDiv.style.display = 'block';
            let html = '<div style="font-weight: 600; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 2px;">Flächen</div>';
            activeProject.plans.forEach((p, idx) => {
                html += `<div onclick="jumpToPlan('${p.name.replace(/'/g, "\\'")}')" style="cursor: pointer; padding: 2px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${p.name} (${p.areaHa.toFixed(2)} ha)">
                            <span style="color: #38bdf8;">•</span> ${p.name}
                         </div>`;
            });
            planListDiv.innerHTML = html;
        } else {
            planListDiv.style.display = 'none';
        }
    }
    
    activeProject.plans.forEach((p, idx) => {
        const poly = L.polygon(p.geofence, {
            color: '#38bdf8', // Unified Sky Blue
            weight: 3,
            fillOpacity: 0.2,
            dashArray: '5, 10' // Unified dashed style for all
        }).addTo(geofenceLayer);

        const popupContent = `
            <div style="font-family: inherit; min-width: 150px;">
                <strong style="display: block; margin-bottom: 0.25rem;">${p.name}</strong>
                <span style="font-size: 0.9rem; opacity: 0.8;">Teilfläche: ${p.areaHa.toFixed(2)} ha</span><br>
                ${activeProject.plans.length > 1 ? `<span style="font-size: 0.8rem; opacity: 0.6;">Gesamt: ${totalArea.toFixed(2)} ha</span><br>` : ''}
                <button onclick="removePlan('${p.name.replace(/'/g, "\\'")}')" class="btn btn-secondary btn-small" style="width: 100%; margin-top: 0.5rem; padding: 0.2rem; font-size: 0.75rem;">🗑️ Entfernen</button>
            </div>
        `;
        poly.bindPopup(popupContent);
    });
}

/**
 * Puts the focus on a specific plan on the map.
 */
window.jumpToPlan = function(name) {
    const plan = activeProject.plans.find(p => p.name === name);
    if (plan && geofenceLayer) {
        const bounds = L.polygon(plan.geofence).getBounds();
        map.fitBounds(bounds, { padding: [100, 100], maxZoom: 16 });
        
        // Find and open popup for this plan
        geofenceLayer.eachLayer(layer => {
            if (layer instanceof L.Polygon) {
                const layerBounds = layer.getBounds();
                if (layerBounds.equals(bounds)) {
                    layer.openPopup();
                }
            }
        });
    }
};

/**
 * Removes a specific plan from the project.
 * @param {string} name Name of the plan to remove
 */
window.removePlan = function(name) {
    activeProject.plans = activeProject.plans.filter(p => p.name !== name);
    
    if (activeProject.plans.length === 1) {
        activeProject.name = activeProject.plans[0].name;
    } else if (activeProject.plans.length > 1) {
        activeProject.name = `${activeProject.plans.length} Teilflächen Projekt`;
    } else {
        activeProject.name = "Kein Projekt geladen";
    }

    updatePolygonsOnMap();
    updateProjectBanner();
    refreshAllData();
};

function updateProjectBanner() {
    const display = document.getElementById('projectNameDisplay');
    const clearBtn = document.getElementById('clearProjectBtn');
    const polyBtn = document.getElementById('polyCenterBtn');

    if (display) {
        if (activeProject.plans && activeProject.plans.length > 0) {
            const totalArea = activeProject.plans.reduce((sum, p) => sum + p.areaHa, 0);
            
            let html = `<span style="margin-right: 0.25rem; font-weight: 700; color: var(--accent-color);">${activeProject.plans.length} Teile:</span>`;
            
            activeProject.plans.forEach(p => {
                html += `
                    <div class="plan-tag" style="display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0.75rem; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--card-border); border-radius: 0.5rem; font-size: 0.85rem; color: var(--text-primary); transition: all 0.2s ease;">
                        <span onclick="jumpToPlan('${p.name.replace(/'/g, "\\'")}')" style="cursor: pointer;" title="Zu dieser Fläche springen: ${p.areaHa.toFixed(2)} ha">${p.name}</span>
                        <button onclick="removePlan('${p.name.replace(/'/g, "\\'")}')" style="background: none; border: none; color: var(--danger-color); cursor: pointer; padding: 0; font-size: 1.1rem; line-height: 1; display: flex; align-items: center; justify-content: center; opacity: 0.7;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.7">×</button>
                    </div>
                `;
            });

            // Add "Clear All" button as a tag
            html += `
                <button onclick="clearActiveProject()" class="plan-tag" style="display: flex; align-items: center; justify-content: center; padding: 0.3rem 0.75rem; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 0.5rem; font-size: 0.85rem; color: var(--danger-color); cursor: pointer; transition: all 0.2s ease; font-weight: bold;" title="Alle Projekte löschen">
                    Alle löschen ✖
                </button>
            `;
            
            display.innerHTML = `<div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; width: 100%;">${html}</div>`;
            display.title = `Gesamtfläche: ${totalArea.toFixed(2)} ha`;
        } else {
            display.innerText = "Kein Projekt geladen";
            display.title = "";
        }
    }

    // Hide original clearBtn as it's now integrated into the display
    if (clearBtn) {
        clearBtn.style.display = "none";
    }

    if (polyBtn) {
        polyBtn.style.display = (activeProject.plans && activeProject.plans.length > 0) ? "block" : "none";
    }
}

// --- Sync & Drive Export Logic ---
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyXwdjzkx3jGk2KItRjCB_EoxSnSYUPxPWeXgbW9FLbQ5HbIXHohtzd6e4Nq34_IbyW/exec"; // Hier kommt die URL des Google Apps Scripts hin
const AUTH_STORE_KEY = 'uav_sync_auth';

function getStoredPassword() {
    const encoded = localStorage.getItem(AUTH_STORE_KEY);
    return encoded ? atob(encoded) : null;
}

function setStoredPassword(password) {
    if (password) {
        localStorage.setItem(AUTH_STORE_KEY, btoa(password));
    } else {
        localStorage.removeItem(AUTH_STORE_KEY);
    }
}

async function sendToGoogleDrive(data) {
    if (!GOOGLE_SCRIPT_URL) {
        throw new Error("Google Script URL nicht konfiguriert.");
    }

    // Passwort-Abfrage falls nicht vorhanden
    let pwd = getStoredPassword();
    if (!pwd) {
        pwd = window.prompt("Bitte geben Sie das Sync-Passwort ein:");
        if (pwd) {
            setStoredPassword(pwd);
        } else {
            throw new Error("Passwort erforderlich für den Cloud-Upload.");
        }
    }

    // Passwort mitsenden
    data.password = pwd;

    // Wir nutzen Content-Type text/plain um CORS Preflight Probleme zu minimieren
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

    const responseText = await response.text();

    // Falls das Passwort falsch war (Error: Unauthorized vom GAS), lokal löschen
    if (responseText.includes("Unauthorized")) {
        setStoredPassword(null);
        throw new Error("Ungültiges Passwort. Bitte erneut versuchen.");
    }

    return responseText;
}

async function saveLogbook() {
    const form = document.getElementById('logbookForm');
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }

    // Validierung der Unterschriften
    if (!hasSignature1) {
        alert("Bitte unterschreiben Sie als RPIC 1.");
        return;
    }

    const rpic2Value = document.getElementById('lb_rpic2').value.trim();
    if (rpic2Value !== "" && !hasSignature2) {
        alert("Bitte unterschreiben Sie als RPIC 2, da ein zweiter Pilot eingetragen wurde.");
        return;
    }

    const operationValue = document.getElementById('lb_operation').value;
    if (operationValue === "Dual Operator VLOS") {
        if (rpic2Value === "" || rpic2Value === "N/A") {
            alert("Für die Betriebsform 'Dual Operator VLOS' muss ein RPIC 2 angegeben werden (nicht leer oder N/A).");
            document.getElementById('lb_rpic2').focus();
            return;
        }
    }

    updateStatusProgress("Portfolio wird erstellt...", 5);
    const saveBtn = document.querySelector('button[onclick="saveLogbook()"]');
    const originalBtnText = saveBtn.innerHTML;
    saveBtn.disabled = true;

    try {
        // Portfolio Screenshot generieren (wie beim Export)
        let screenshotDataUrl = null;
        try {
            const canvas = await generateScreenshotCanvas((msg, p) => updateStatusProgress(msg, p * 0.8));
            updateStatusProgress("Komprimiere Daten...", 85);
            screenshotDataUrl = canvas.toDataURL('image/jpeg', 0.8);
        } catch (screenshotErr) {
            console.warn("Screenshot konnte für Sync nicht erstellt werden", screenshotErr);
        }

        const formData = {
            project: activeProject.name,
            plans: activeProject.plans, // Save all plans
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
            events: document.getElementById('lb_events').value.trim() || "keine",
            operation: document.getElementById('lb_operation').value,
            areaType: document.getElementById('lb_area_type').value,
            reactions: document.getElementById('lb_reactions').value.trim() || "keine",
            weather: document.getElementById('lb_weather').value,
            misc: document.getElementById('lb_misc').value.trim() || "keine",
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

            updateStatusProgress("Übertragung zur Cloud...", 90);
            const responseText = await sendToGoogleDrive(formData);
            
            if (responseText.startsWith("Error")) {
                throw new Error(responseText);
            }

            if (responseText === "Duplicate") {
                formData.synced = true;
                updateStatusProgress("Dublette erkannt - bereits gesichert!", 100);
            } else {
                formData.synced = true;
                updateStatusProgress("Erfolgreich gespeichert!", 100);
            }
            setTimeout(hideStatusProgress, 1000);
        } catch (syncErr) {
            console.warn("Sync fehlgeschlagen, speichere lokal", syncErr);
            formData.synced = false;
            hideStatusProgress();
            alert("Offline / Fehler: Log wurde lokal gespeichert und kann später synchronisiert werden.");
        }

        // Always save to persistent history after attempting sync
        try {
            const historyLogs = await localforage.getItem('uav_history_logs') || [];
            historyLogs.unshift(formData); // Add to beginning of history
            await localforage.setItem('uav_history_logs', historyLogs);
        } catch (hErr) {
            console.error("Failed to save to history", hErr);
        }

        form.reset();
        document.getElementById('lb_rpic2').disabled = true;
        // Clear signatures
        clearSignature(1);
        clearSignature(2);
    } catch (err) {
        console.error("Save Error:", err);
        hideStatusProgress();
        alert("Fehler beim Speichern des Logbuchs.");
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = originalBtnText;
    }
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

            // Restore plans if available in the log
            if (log.plans || log.geofence) {
                if (geofenceLayer) geofenceLayer.clearLayers();
                activeProject.plans = [];

                const loadedPlans = log.plans || [{
                    name: log.project || "Historisches Projekt",
                    geofence: log.geofence,
                    areaHa: calculatePolygonArea(log.geofence)
                }];

                activeProject.plans = loadedPlans;
                updatePolygonsOnMap();

                activeProject.name = log.project || "Historischer Eintrag";
                activeSource = "polygon";
                updateProjectBanner();
                map.fitBounds(geofenceLayer.getBounds(), { padding: [50, 50] });
            } else {
                clearActiveProject();
            }

            // Update map if coordinates are available
            if (log.lat && log.lon) {
                activeCoords = { lat: log.lat, lon: log.lon };
                activeSource = "manual";
                updateMap(log.lat, log.lon);
            }

            // Metadata aktualisieren, um die Koordinaten in der Fußzeile zu zeigen
            updateMetadata();

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
            triggerExport();
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


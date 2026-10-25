'use strict';

const { app, BrowserWindow, ipcMain, shell, session, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const APP_NAME = 'Earth Online';
const UA = 'EarthOnline/1.0 (desktop digital twin; contact: operator@earth.online)';
const CACHE_FILE = () => path.join(app.getPath('userData'), 'earth-online-cache.json');

/* ------------------------------------------------------------------ */
/* tiny HTTP client                                                    */
/* ------------------------------------------------------------------ */

function fetchText(url, { timeout = 18000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/xml, */*',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchText(new URL(res.headers.location, url).toString(), { timeout, headers }).then(resolve, reject);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`Timeout ${url}`)));
  });
}

async function fetchJSON(url, opts) {
  const body = await fetchText(url, opts);
  return JSON.parse(body);
}

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ------------------------------------------------------------------ */
/* cache                                                               */
/* ------------------------------------------------------------------ */

let CACHE = { sources: {} };
try {
  CACHE = JSON.parse(fs.readFileSync(CACHE_FILE(), 'utf8')) || { sources: {} };
} catch { /* first run */ }

let saveTimer = null;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(CACHE_FILE(), JSON.stringify(CACHE)); } catch { /* ignore */ }
  }, 800);
}

/* ------------------------------------------------------------------ */
/* normalisers                                                         */
/* ------------------------------------------------------------------ */

const US_STATE = {
  AL: [32.8, -86.8], AK: [63.6, -152.5], AZ: [34.3, -111.7], AR: [34.9, -92.4],
  CA: [37.2, -119.5], CO: [39.0, -105.5], CT: [41.6, -72.7], DE: [39.0, -75.5],
  FL: [28.6, -82.4], GA: [32.6, -83.4], HI: [20.8, -156.3], ID: [44.4, -114.6],
  IL: [40.0, -89.2], IN: [39.9, -86.3], IA: [42.1, -93.5], KS: [38.5, -98.4],
  KY: [37.5, -85.3], LA: [31.1, -92.0], ME: [45.4, -69.2], MD: [39.0, -76.8],
  MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3], MS: [32.7, -89.7],
  MO: [38.4, -92.5], MT: [47.0, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6],
  NH: [43.7, -71.6], NJ: [40.2, -74.7], NM: [34.4, -106.1], NY: [43.0, -75.5],
  NC: [35.5, -79.4], ND: [47.4, -100.5], OH: [40.3, -82.8], OK: [35.6, -97.5],
  OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.6], SC: [33.9, -80.9],
  SD: [44.4, -100.2], TN: [35.8, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7],
  VT: [44.1, -72.7], VA: [37.5, -78.9], WA: [47.4, -120.5], WV: [38.6, -80.6],
  WI: [44.6, -89.7], WY: [43.0, -107.6], DC: [38.9, -77.0], PR: [18.2, -66.5],
  GU: [13.4, 144.8], VI: [18.3, -64.9], AS: [-14.3, -170.7], MP: [15.2, 145.8],
};

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

function stateFromArea(area) {
  if (!area) return null;
  const m = area.match(/,\s*([A-Z]{2})\b/);
  return m && US_STATE[m[1]] ? m[1] : null;
}

function ringCentroid(coords) {
  let x = 0, y = 0, n = 0;
  const walk = (c) => {
    if (typeof c[0] === 'number') { x += c[0]; y += c[1]; n++; return; }
    c.forEach(walk);
  };
  walk(coords);
  return n ? [y / n, x / n] : null;
}

function normaliseQuake(f) {
  const p = f.properties || {};
  const [lon, lat, depth] = f.geometry?.coordinates || [0, 0, 0];
  const mag = num(p.mag);
  return {
    id: 'q' + f.id,
    cat: 'seismic',
    title: p.title || `M ${mag.toFixed(1)} earthquake`,
    subtitle: p.place || 'Unknown region',
    place: p.place || 'Unknown region',
    lat, lon,
    depth: Math.round(depth),
    mag,
    severity: clamp((mag - 2) / 6, 0.06, 1),
    time: p.time || Date.now(),
    url: p.url || '',
    source: 'USGS',
  };
}

function normaliseEonet(ev) {
  const cat = ev.categories?.[0]?.id || 'other';
  const geo = (ev.geometry || []).filter((g) => g.type === 'Point');
  const last = geo[geo.length - 1] || (ev.geometry || [])[ev.geometry.length - 1];
  if (!last) return null;
  let lon, lat;
  if (last.type === 'Point') { [lon, lat] = last.coordinates; }
  else {
    const c = ringCentroid(last.coordinates);
    if (!c) return null;
    [lat, lon] = c;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const catMap = {
    wildfires: 'fire', severeStorms: 'storm', volcanoes: 'volcano',
    floods: 'flood', drought: 'disaster', dustHaze: 'disaster',
    seaLakeIce: 'disaster', landslides: 'disaster', snow: 'disaster',
    temperature: 'disaster', waterColor: 'disaster', manmade: 'disaster',
    earthquakes: 'seismic', other: 'disaster',
  };
  const mag = last.magnitudeValue;
  const unit = last.magnitudeUnit || '';
  let subtitle = (ev.categories?.[0]?.title || 'Natural event');
  if (mag != null) subtitle += ` · ${mag}${unit ? ' ' + unit : ''}`;
  return {
    id: 'e' + ev.id + '-' + cat,
    cat: catMap[cat] || 'disaster',
    title: ev.title,
    subtitle,
    place: ev.title,
    lat, lon,
    severity: clamp((mag ? mag / 120 : 0.42) + (cat === 'volcano' ? 0.2 : 0), 0.2, 1),
    time: Date.parse(last.date) || Date.now(),
    url: ev.sources?.[0]?.url || ev.link || '',
    source: 'NASA EONET',
    eonet: true,
  };
}

function normaliseNws(f) {
  const p = f.properties || {};
  const geometries = f.geometry;
  let lat = null, lon = null, approx = false;
  if (geometries) {
    const c = ringCentroid(geometries.coordinates);
    if (c) [lat, lon] = c;
  }
  if (lat === null) {
    const st = stateFromArea(p.areaDesc || '') || stateFromArea(p.senderName || '');
    if (st) {
      const [slat, slon] = US_STATE[st];
      const j = hashStr(p.id || p.areaDesc || 'x');
      lat = slat + (hashStr(st + 'a') - 0.5) * 2.4;
      lon = slon + (hashStr(st + 'b') - 0.5) * 2.4;
      approx = true;
    }
  }
  if (lat === null) return null;
  const sev = (p.severity || 'Moderate').toLowerCase();
  const isTsunami = /tsunami/i.test(p.event || '');
  const sevWeight = { extreme: 1, severe: 0.78, moderate: 0.5, minor: 0.3, unknown: 0.4 }[sev] ?? 0.4;
  return {
    id: 'w' + (p.id || f.id),
    cat: isTsunami ? 'tsunami' : 'warning',
    title: p.event || 'Weather warning',
    subtitle: p.areaDesc || '',
    place: p.areaDesc || '',
    lat, lon,
    severity: sevWeight,
    time: Date.parse(p.onset || p.effective || p.sent) || Date.now(),
    url: p['@id'] || '',
    source: p.senderName || 'NWS',
    headline: p.headline || '',
    description: (p.description || '').slice(0, 400),
    instruction: (p.instruction || '').slice(0, 300),
    expires: Date.parse(p.expires || p.ends || 0) || null,
    approx,
    priority: isTsunami ? 5 : sev === 'extreme' ? 4 : sev === 'severe' ? 3 : 2,
  };
}

function normaliseFireball(row, fields) {
  const idx = (n) => fields.indexOf(n);
  const lat = +row[idx('lat')];
  const lonRaw = +row[idx('lon')];
  const lon = ((lonRaw + 540) % 360) - 180;
  const energy = +row[idx('energy')] || 0.1;
  const date = row[idx('date')];
  const alt = row[idx('alt')];
  return {
    id: 'f' + date + lat + lon,
    cat: 'fireball',
    title: `Fireball · ${lat.toFixed(1)}°, ${lon.toFixed(1)}°`,
    subtitle: `${energy.toFixed(1)} × 10¹⁰ J${alt ? ` · ${alt} km` : ''}`,
    place: 'Atmospheric impact',
    lat, lon,
    severity: clamp(energy / 30, 0.15, 1),
    time: Date.parse(date + 'Z') || Date.now(),
    source: 'NASA CNEOS',
  };
}

/* ------------------------------------------------------------------ */
/* feed loaders                                                        */
/* ------------------------------------------------------------------ */

async function loadUsgs(at) {
  if (!at) {
    const j = await fetchJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson');
    return (j.features || []).map(normaliseQuake);
  }
  const end = new Date(at);
  const start = new Date(end.getTime() - 26 * 3600e3);
  const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=2.2'
    + `&starttime=${start.toISOString().slice(0, 19)}&endtime=${end.toISOString().slice(0, 19)}&limit=900`;
  const j = await fetchJSON(url);
  return (j.features || []).map(normaliseQuake);
}

async function loadEonet(at) {
  let url = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=10&limit=250';
  if (at) {
    const d = new Date(at);
    const s = new Date(d.getTime() - 4 * 86400e3);
    const e = new Date(d.getTime() + 86400e3);
    const fmt = (x) => x.toISOString().slice(0, 10);
    url = `https://eonet.gsfc.nasa.gov/api/v3/events?status=all&start=${fmt(s)}&end=${fmt(e)}&limit=250`;
  }
  const j = await fetchJSON(url);
  return (j.events || []).map(normaliseEonet).filter(Boolean);
}

async function loadNws() {
  const j = await fetchJSON('https://api.weather.gov/alerts/active?status=actual&message_type=alert', { timeout: 22000 });
  const seen = new Set();
  const out = [];
  for (const f of j.features || []) {
    const p = f.properties || {};
    const key = (p.event || '') + '|' + (p.areaDesc || '') + '|' + (p.senderName || '');
    if (seen.has(key)) continue;
    if ((p.severity || '') === 'Minor' || (p.severity || '') === 'Unknown') continue;
    seen.add(key);
    const n = normaliseNws(f);
    if (n) out.push(n);
  }
  out.sort((a, b) => (b.priority || 0) - (a.priority || 0) || b.time - a.time);
  return out.slice(0, 90);
}

async function loadIss() {
  const cur = await fetchJSON('https://api.wheretheiss.at/v1/satellites/25544');
  const now = Math.floor(cur.timestamp || Date.now() / 1000);
  const stamps = [];
  for (let i = -5; i <= 5; i++) stamps.push(now + i * 300);
  let track = [];
  try {
    const arr = await fetchJSON('https://api.wheretheiss.at/v1/satellites/25544/positions?units=kilometers&timestamps=' + stamps.join(','));
    track = arr.map((p) => ({ lat: num(p.latitude), lon: num(p.longitude), t: p.timestamp * 1000, vis: p.visibility }));
  } catch { /* track is optional */ }
  return {
    lat: num(cur.latitude), lon: num(cur.longitude),
    altitude: Math.round(num(cur.altitude)), velocity: Math.round(num(cur.velocity)),
    visibility: cur.visibility, footprint: Math.round(num(cur.footprint)),
    track, updated: (cur.timestamp || Date.now() / 1000) * 1000,
  };
}

async function loadAurora() {
  const j = await fetchJSON('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json', { timeout: 25000 });
  const coords = j.coordinates || [];
  const pts = [];
  // grid is roughly 1 degree; sample every 3rd cell to keep the point cloud light
  for (let i = 0; i < coords.length; i += 3) {
    const [lon, lat, v] = coords[i];
    if (v >= 12) pts.push([lat, lon > 180 ? lon - 360 : lon, v]);
  }
  return { points: pts, updated: Date.parse(j['Observation Time'] || '') || Date.now() };
}

async function loadFireballs() {
  const j = await fetchJSON('https://ssd-api.jpl.nasa.gov/fireball.api?limit=25', { timeout: 18000 });
  const fields = j.fields || [];
  return (j.data || []).map((r) => normaliseFireball(r, fields));
}

/* ------------------------------------------------------------------ */
/* snapshot assembly                                                   */
/* ------------------------------------------------------------------ */

const LIVE_SOURCES = ['usgs', 'eonet', 'nws', 'iss', 'aurora', 'fireballs'];

async function guarded(name, fn, { live = false } = {}) {
  try {
    const data = await fn();
    if (live) {
      CACHE.sources[name] = { ts: Date.now(), data };
      saveCache();
    }
    return { data, status: 'live' };
  } catch (err) {
    const cached = CACHE.sources[name];
    if (cached) return { data: cached.data, status: 'cached', age: Date.now() - cached.ts, error: String(err.message || err) };
    return { data: null, status: 'offline', error: String(err.message || err) };
  }
}

async function buildSnapshot({ at = null } = {}) {
  const historical = !!at && Math.abs(Date.now() - Date.parse(at)) > 5 * 60e3;
  const sources = {};
  const jobs = [];

  jobs.push(guarded('usgs', () => loadUsgs(historical ? at : null), { live: !historical })
    .then((r) => { sources.usgs = r; }));
  jobs.push(guarded('eonet', () => loadEonet(historical ? at : null), { live: !historical })
    .then((r) => { sources.eonet = r; }));

  if (!historical) {
    jobs.push(guarded('nws', () => loadNws(), { live: true }).then((r) => { sources.nws = r; }));
    jobs.push(guarded('iss', () => loadIss(), { live: true }).then((r) => { sources.iss = r; }));
    jobs.push(guarded('aurora', () => loadAurora(), { live: true }).then((r) => { sources.aurora = r; }));
    jobs.push(guarded('fireballs', () => loadFireballs(), { live: true }).then((r) => { sources.fireballs = r; }));
  }

  await Promise.allSettled(jobs);

  const pick = (n, d = []) => (sources[n]?.data ?? d);

  const events = [...pick('usgs'), ...pick('eonet')];
  if (!historical) events.push(...pick('nws'));

  const dedupe = new Map();
  for (const e of events) {
    const key = e.cat + '|' + Math.round(e.lat * 8) + '|' + Math.round(e.lon * 8) + '|' + (e.title || '').slice(0, 18);
    const prev = dedupe.get(key);
    if (!prev || (e.priority || 0) > (prev.priority || 0)) dedupe.set(key, e);
  }
  const list = [...dedupe.values()].sort((a, b) => {
    const pa = (b.priority || 0) - (a.priority || 0);
    if (pa !== 0) return -pa;
    return b.time - a.time;
  });

  const quakes = list.filter((e) => e.cat === 'seismic');
  const stats = {
    total: list.length,
    quakes: quakes.length,
    maxMag: quakes.reduce((m, q) => Math.max(m, q.mag || 0), 0),
    fires: list.filter((e) => e.cat === 'fire').length,
    storms: list.filter((e) => e.cat === 'storm').length,
    warnings: list.filter((e) => e.cat === 'warning' || e.cat === 'tsunami').length,
    fireballs: pick('fireballs').length,
    auroraCells: pick('aurora')?.points?.length || 0,
  };

  const onlineCount = Object.values(sources).filter((s) => s.status === 'live').length;
  const totalTracked = Object.keys(sources).length || 1;

  return {
    mode: historical ? 'history' : 'live',
    at: historical ? new Date(at).toISOString() : new Date().toISOString(),
    fetchedAt: Date.now(),
    events: list,
    iss: pick('iss', null),
    aurora: pick('aurora', null),
    fireballs: pick('fireballs'),
    stats,
    online: onlineCount > 0,
    signal: Math.round((onlineCount / totalTracked) * 100),
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.status])),
  };
}

/* ------------------------------------------------------------------ */
/* probe + search                                                      */
/* ------------------------------------------------------------------ */

const probeCache = new Map();

async function probe({ lat, lon }) {
  const key = lat.toFixed(2) + ',' + lon.toFixed(2);
  if (probeCache.has(key)) return probeCache.get(key);
  const [rev, met] = await Promise.allSettled([
    fetchJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, { timeout: 12000 }),
    fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + '&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,apparent_temperature,is_day,pressure_msl'
      + '&daily=sunrise,sunset&forecast_days=1&timezone=auto', { timeout: 12000 }),
  ]);

  const r = rev.status === 'fulfilled' ? rev.value : null;
  const m = met.status === 'fulfilled' ? met.value : null;
  const cur = m?.current || null;

  const labelParts = [];
  if (r?.city) labelParts.push(r.city);
  if (r?.locality && r.locality !== r.city) labelParts.push(r.locality);
  if (!labelParts.length && r?.principalSubdivision) labelParts.push(r.principalSubdivision);
  if (r?.countryName) labelParts.push(r.countryName);

  const result = {
    lat, lon,
    place: labelParts.join(', ') || `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`,
    country: r?.countryName || '',
    countryCode: r?.countryCode || '',
    region: r?.principalSubdivision || '',
    timezone: m?.timezone || '',
    timezoneAbbr: m?.timezone_abbreviation || '',
    utcOffset: m?.utc_offset_seconds ?? null,
    weather: cur ? {
      temp: cur.temperature_2m,
      feels: cur.apparent_temperature,
      wind: cur.wind_speed_10m,
      windDir: cur.wind_direction_10m,
      humidity: cur.relative_humidity_2m,
      pressure: cur.pressure_msl,
      code: cur.weather_code,
      isDay: !!cur.is_day,
    } : null,
    sunrise: m?.daily?.sunrise?.[0] || null,
    sunset: m?.daily?.sunset?.[0] || null,
  };
  probeCache.set(key, result);
  if (probeCache.size > 300) probeCache.delete(probeCache.keys().next().value);
  return result;
}

async function search(q) {
  const latlon = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (latlon) {
    return [{ name: `${latlon[1]}, ${latlon[2]}`, lat: +latlon[1], lon: +latlon[2], kind: 'coordinates' }];
  }
  const j = await fetchJSON('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(q)
    + '&count=8&language=en&format=json', { timeout: 12000 });
  return (j.results || []).map((r) => ({
    name: r.name,
    admin: r.admin1 || '',
    country: r.country || '',
    lat: r.latitude,
    lon: r.longitude,
    population: r.population || 0,
    kind: 'place',
  }));
}

async function locate() {
  try {
    const j = await fetchJSON('https://ipwho.is/', { timeout: 12000 });
    if (j.success !== false) {
      return {
        lat: j.latitude, lon: j.longitude,
        city: j.city, region: j.region, country: j.country,
        timezone: j.timezone?.id || '', flag: j.flag?.emoji || '',
      };
    }
  } catch { /* fall through */ }
  const j = await fetchJSON('https://ipapi.co/json/', { timeout: 12000 });
  return {
    lat: j.latitude, lon: j.longitude, city: j.city,
    region: j.region, country: j.country_name, timezone: j.timezone, flag: '',
  };
}

/* ------------------------------------------------------------------ */
/* window + ipc                                                        */
/* ------------------------------------------------------------------ */

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1680,
    height: 980,
    minWidth: 1180,
    minHeight: 740,
    backgroundColor: '#02060f',
    show: false,
    title: APP_NAME,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#02060f', symbolColor: '#9fe8ff', height: 46 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  if (process.argv.includes('--shot')) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 14000));
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'shot.png'), img.toPNG());
        console.log('screenshot written');
      } catch (e) { console.error('shot failed', e); }
      app.quit();
    });
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
}

app.setName(APP_NAME);
nativeTheme.themeSource = 'dark';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    if (process.argv.includes('--testfeeds')) {
      try {
        const snapshot = await buildSnapshot({});
        fs.writeFileSync(path.join(__dirname, 'snapshot-test.json'), JSON.stringify({
          mode: snapshot.mode,
          stats: snapshot.stats,
          signal: snapshot.signal,
          sources: snapshot.sources,
          events: snapshot.events.slice(0, 12),
          iss: snapshot.iss,
          aurora: { count: snapshot.aurora?.points?.length || 0 },
          fireballs: snapshot.fireballs?.length || 0,
        }, null, 1));
        console.log('FEEDS OK', snapshot.stats);
      } catch (err) {
        console.error('FEEDS FAIL', err);
        fs.writeFileSync(path.join(__dirname, 'snapshot-test.json'), JSON.stringify({ error: String(err) }, null, 1));
      }
      app.quit();
      return;
    }
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      cb(permission === 'geolocation' || permission === 'fullscreen');
    });
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

ipcMain.handle('feed:snapshot', async (_e, opts) => {
  try {
    return await buildSnapshot(opts || {});
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

ipcMain.handle('geo:probe', async (_e, pt) => {
  try { return await probe(pt); } catch (err) { return { error: String(err.message || err) }; }
});

ipcMain.handle('geo:search', async (_e, q) => {
  try { return await search(q); } catch { return []; }
});

ipcMain.handle('geo:locate', async () => {
  try { return await locate(); } catch { return null; }
});

ipcMain.handle('app:open', (_e, url) => {
  if (/^https?:/i.test(url)) shell.openExternal(url);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });


import { EarthGlobe, subsolarPoint, layerOf, CATEGORY_COLOR } from './globe.js';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

const LOCALE = 'en-GB';
const fmtTime = (ts) => new Date(ts).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
const fmtDate = (ts) => new Date(ts).toLocaleDateString(LOCALE, { day: '2-digit', month: 'short', year: 'numeric' });
const fmtDateTime = (ts) => `${fmtDate(ts)} · ${fmtTime(ts)} local`;
const relative = (ts) => {
  const d = Date.now() - ts;
  const abs = Math.abs(d);
  if (abs < 60e3) return 'just now';
  if (abs < 3600e3) return `${Math.round(abs / 60e3)}m ${d > 0 ? 'ago' : 'ahead'}`;
  if (abs < 86400e3) return `${Math.round(abs / 3600e3)}h ${d > 0 ? 'ago' : 'ahead'}`;
  return `${Math.round(abs / 86400e3)}d ${d > 0 ? 'ago' : 'ahead'}`;
};
const haversine = (lat1, lon1, lat2, lon2) => {
  const p = D2R;
  const a = Math.sin((lat2 - lat1) * p / 2) ** 2
    + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin((lon2 - lon1) * p / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
const sunElevation = (lat, lon, sun) => {
  const s = Math.sin(lat * D2R) * Math.sin(sun.lat * D2R)
    + Math.cos(lat * D2R) * Math.cos(sun.lat * D2R) * Math.cos((lon - sun.lon) * D2R);
  return Math.asin(clamp(s, -1, 1)) * R2D;
};
const weatherText = (code, isDay = 1) => {
  const map = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
    56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
    77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Violent showers',
    85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm + hail',
    99: 'Severe thunderstorm',
  };
  if (code == null) return isDay ? 'No telemetry' : 'Nocturnal';
  return map[code] || 'Mixed conditions';
};
const CAT_ICON = {
  seismic: 'i-seismic', warning: 'i-warning', tsunami: 'i-wave', storm: 'i-storm',
  fire: 'i-fire', volcano: 'i-disaster', flood: 'i-tsunami', disaster: 'i-disaster',
  fireball: 'i-fireball',
};
const CAT_LABEL = {
  seismic: 'Seismic event', warning: 'Weather warning', tsunami: 'Tsunami bulletin',
  storm: 'Severe storm', fire: 'Wildfire', volcano: 'Volcanic activity',
  flood: 'Flood', disaster: 'Natural event', fireball: 'Fireball',
};

/* ------------------------------------------------------------------ */
/* progression                                                         */
/* ------------------------------------------------------------------ */

const RANKS = [
  { name: 'CADET', min: 0 },
  { name: 'OBSERVER', min: 120 },
  { name: 'ANALYST', min: 320 },
  { name: 'NAVIGATOR', min: 650 },
  { name: 'CARTOGRAPHER', min: 1000 },
  { name: 'PLANET KEEPER', min: 1500 },
];

const ACHIEVEMENTS = [
  { id: 'first_probe', name: 'First Contact', desc: 'Probe your first coordinate.', pts: 10, icon: 'i-target' },
  { id: 'five_probes', name: 'Field Surveyor', desc: 'Probe five distinct regions.', pts: 25, icon: 'i-locate' },
  { id: 'ring_of_fire', name: 'Ring of Fire', desc: 'Probe within 350 km of a M5.5+ quake.', pts: 30, icon: 'i-seismic' },
  { id: 'night_watch', name: 'Night Watch', desc: 'Probe a location in deep night.', pts: 20, icon: 'i-fireball' },
  { id: 'fire_walker', name: 'Fire Walker', desc: 'Probe within 250 km of an active fire.', pts: 20, icon: 'i-fire' },
  { id: 'aurora_hunter', name: 'Aurora Hunter', desc: 'Probe above 60° latitude with aurora on.', pts: 30, icon: 'i-aurora' },
  { id: 'storm_chaser', name: 'Storm Chaser', desc: 'Open a live severe-storm event.', pts: 20, icon: 'i-storm' },
  { id: 'time_traveler', name: 'Time Traveller', desc: 'Rewind the globe into the past.', pts: 25, icon: 'i-clock' },
  { id: 'space_agency', name: 'Mission Control', desc: 'Track the ISS across the globe.', pts: 15, icon: 'i-sat' },
  { id: 'global_network', name: 'Full Spectrum', desc: 'Enable every data layer at once.', pts: 20, icon: 'i-zap' },
];

const USER_KEY = 'earth-online-operator-v1';
const DEFAULT_USER = { points: 0, probes: [], discoveries: [], waypoints: [], achievements: {}, flags: {}, lastVisit: '' };

function loadUser() {
  try {
    const raw = JSON.parse(localStorage.getItem(USER_KEY));
    return { ...structuredClone(DEFAULT_USER), ...(raw || {}), flags: raw?.flags || {}, achievements: raw?.achievements || {} };
  } catch { return structuredClone(DEFAULT_USER); }
}

let user = loadUser();
const saveUser = () => { try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* ignore */ } };

function rankInfo() {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (user.points >= RANKS[i].min) idx = i;
  const next = RANKS[idx + 1] || null;
  const span = next ? next.min - RANKS[idx].min : 1;
  const pct = next ? clamp(((user.points - RANKS[idx].min) / span) * 100, 0, 100) : 100;
  return { name: RANKS[idx].name, next, pct, points: user.points };
}

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const state = {
  snapshot: null,
  events: [],
  layers: new Set(['seismic', 'disasters', 'gdacs', 'tsunami', 'storms', 'fires', 'warnings', 'aurora', 'iss', 'fireballs']),
  tab: 'live',
  selected: null,
  selectedId: null,
  time: { active: false, days: 0, playing: false, at: null },
  syncAt: 0,
  fetching: false,
  requestId: 0,
  simulated: false,
  sun: subsolarPoint(new Date()),
  searchTimer: null,
  probePoint: null,
  loaderHidden: false,
};

let globe = null;

/* ------------------------------------------------------------------ */
/* loader                                                              */
/* ------------------------------------------------------------------ */

const loader = $('#loader');
const loaderFill = $('#loader-fill');
const loaderMsg = $('#loader-msg');

function loaderProgress(pct, msg) {
  if (loaderFill) loaderFill.style.width = `${clamp(pct, 2, 100)}%`;
  if (msg && loaderMsg) loaderMsg.textContent = msg;
}
function hideLoader() {
  if (state.loaderHidden) return;
  state.loaderHidden = true;
  loaderProgress(100, 'Uplink established');
  setTimeout(() => loader.classList.add('done'), 260);
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  bindUI();
  renderUser();
  updateClock();
  setInterval(updateClock, 1000);
  setInterval(updateSyncAge, 1000);
  setInterval(() => {
    const now = new Date();
    if (!state.time.active) {
      state.sun = subsolarPoint(now);
      if (globe?.ready) globe.setSun(now);
    }
  }, 30e3);
  setInterval(() => {
    if (!state.time.active && !state.fetching && document.visibilityState === 'visible') fetchSnapshot();
  }, 70e3);

  const daily = new Date().toISOString().slice(0, 10);
  if (user.lastVisit !== daily) {
    user.lastVisit = daily;
    if (user.points > 0 || user.probes.length) award(10, 'Daily uplink');
  }

  globe = new EarthGlobe($('#globe'), {
    onReady: () => {
      loaderProgress(55, 'Calibrating orbital sensors…');
      setTimeout(() => {
        if (!state.snapshot) loaderProgress(68, 'Listening for planetary signals…');
      }, 400);
    },
    onMarker: (ev) => selectEvent(ev, true),
    onGlobeClick: ({ lat, lon }) => probeAt(lat, lon),
    onIss: () => trackIss(),
  });

  try {
    await globe.init();
    loaderProgress(45, 'Downloading surface imagery…');
  } catch (err) {
    console.error(err);
    loaderProgress(100, 'GPU initialisation failed — retrying without post-processing');
    try {
      await globe.init();
    } catch (e) {
      loaderMsg.textContent = 'WebGL is unavailable on this device.';
      return;
    }
  }

  loaderProgress(62, 'Establishing live downlink…');
  await fetchSnapshot({ initial: true });
  hideLoader();
}

/* ------------------------------------------------------------------ */
/* data                                                                */
/* ------------------------------------------------------------------ */

function demoEvents() {
  const now = Date.now();
  const rnd = (() => { let s = 987654321; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const out = [];
  const quakeZones = [
    [38.3, 142.4], [35.6, 140.2], [55.5, 160.5], [-4.5, 102], [-7.2, 118],
    [18.4, -72.5], [61.2, -149.5], [37.8, -122.3], [-33.5, -70.5], [28.5, 84.2],
    [38.5, 44.3], [15.5, -92.4], [-15.4, -173.2], [-41.3, 174.6], [7.3, 126.5],
    [52.2, -171.8], [12.6, 144.8], [43.5, 146.8], [-21.2, -174.1], [1.2, 126.2],
  ];
  for (let i = 0; i < 36; i++) {
    const [zlat, zlon] = quakeZones[i % quakeZones.length];
    const lat = clamp(zlat + (rnd() - 0.5) * 5, -85, 85);
    const lon = ((zlon + (rnd() - 0.5) * 7 + 540) % 360) - 180;
    const mag = +(Math.pow(rnd(), 2.2) * 5.6 + 1.2).toFixed(1);
    out.push({
      id: 'sim-q-' + i, cat: 'seismic',
      title: `M ${mag.toFixed(1)} earthquake`,
      subtitle: `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`,
      lat, lon, mag, depth: Math.round(rnd() * 60 + 5),
      severity: clamp(mag / 8, 0.1, 1), time: now - Math.round(rnd() * 20 * 3600e3),
      source: 'USGS', sim: true,
    });
  }
  const fires = [[-3.2, -60.5], [-9.5, -63.8], [17.4, 98.6], [39.5, 22.4], [-33.8, 151.2], [48.7, -121.5], [62.4, 129.2], [-14.5, 132.4]];
  fires.forEach(([lat, lon], i) => out.push({
    id: 'sim-f-' + i, cat: 'fire', title: `Wildfire complex · ${['Amanã', 'Juruena', 'Lamphun', 'Thessaly', 'Blue Mountains', 'Cascade Ridge', 'Sakha', 'Arnhem'][i]}`,
    subtitle: 'NASA EONET · active fire front', lat: lat + (rnd() - .5), lon: lon + (rnd() - .5),
    severity: .55, time: now - Math.round(rnd() * 12 * 3600e3), source: 'NASA EONET', sim: true,
  }));
  const storms = [[16.2, -58.4, 'Tropical Storm Ilona'], [22.8, 128.5, 'Typhoon Karuna'], [-18.4, 61.2, 'Cyclone Vela'], [31.2, -49.4, 'Subtropical Low 07']];
  storms.forEach(([lat, lon, name], i) => out.push({
    id: 'sim-s-' + i, cat: 'storm', title: name, subtitle: 'Severe storms · wind field tracked',
    lat, lon, severity: .72, time: now - Math.round(rnd() * 8 * 3600e3), source: 'NASA EONET', sim: true,
  }));
  const warnings = [[64.8, -147.7, 'Blizzard Warning', 'Fairbanks AK'], [61.2, -149.9, 'Ice Storm Warning', 'Anchorage AK'], [39.7, -105.1, 'Red Flag Warning', 'Denver CO'], [30.4, -97.7, 'Severe Thunderstorm Watch', 'Austin TX'], [25.8, -80.2, 'Flood Advisory', 'Miami FL'], [46.8, -100.8, 'High Wind Warning', 'Bismarck ND']];
  warnings.forEach(([lat, lon, title, area], i) => out.push({
    id: 'sim-w-' + i, cat: 'warning', title, subtitle: area, place: area,
    lat, lon, severity: .65, time: now - Math.round(rnd() * 3 * 3600e3),
    source: 'NWS', sim: true, priority: 3,
  }));
  out.push({
    id: 'sim-v-1', cat: 'volcano', title: 'Volcanic ash advisory · Etna', subtitle: 'Volcanic activity · ash plume',
    lat: 37.75, lon: 14.99, severity: .6, time: now - 6 * 3600e3, source: 'NASA EONET', sim: true,
  });
  return out;
}

function demoIss() {
  const track = [];
  for (let i = -4; i <= 4; i++) track.push({ lat: 22 + i * 4.2, lon: 118 + i * 22, t: Date.now() + i * 300e3 });
  return { lat: 22, lon: 118, altitude: 428, velocity: 27580, visibility: 'daylight', footprint: 4530, track, updated: Date.now() };
}

function demoAurora() {
  const points = [];
  for (let lon = -180; lon < 180; lon += 1.4) {
    for (const lat of [64, 66, 68, 70, 72]) {
      if (Math.sin(lon * D2R * 2.1) + Math.cos(lon * D2R * 3.3) > 0.2) points.push([lat + Math.random(), lon, 30 + Math.random() * 55]);
      if (Math.sin(lon * D2R * 2.1 + 2) + Math.cos(lon * D2R * 1.7) > 1.1) points.push([-lat + Math.random(), lon, 25 + Math.random() * 45]);
    }
  }
  return { points, updated: Date.now() };
}

function demoFireballs() {
  const now = Date.now();
  return [
    { lat: 34.2, lon: -118.5, time: now - 2 * 86400e3, energy: 4.6, subtitle: '4.6 × 10¹⁰ J · 32 km' },
    { lat: -21.4, lon: 132.9, time: now - 6 * 86400e3, energy: 2.1, subtitle: '2.1 × 10¹⁰ J · 28 km' },
    { lat: 48.6, lon: 9.2, time: now - 11 * 86400e3, energy: 1.4, subtitle: '1.4 × 10¹⁰ J · 31 km' },
  ].map((f) => ({ ...f, id: 'sim-fb-' + f.lat, cat: 'fireball', title: 'Fireball', severity: 0.4, source: 'NASA CNEOS', sim: true }));
}

async function fetchSnapshot({ initial = false, force = false } = {}) {
  if (state.fetching && !force) return;
  const rid = ++state.requestId;
  state.fetching = true;
  $('#refresh-btn')?.classList.add('spinning');
  updateSyncAge();

  const opts = {};
  if (state.time.active && state.time.days > 0) {
    opts.at = new Date(Date.now() - state.time.days * 86400e3).toISOString();
  }

  let snap = null;
  try {
    snap = await window.earth.snapshot(opts);
  } catch (err) {
    snap = { error: String(err) };
  }
  if (rid !== state.requestId) return;

  state.fetching = false;
  $('#refresh-btn')?.classList.remove('spinning');

  if (!snap || snap.error) {
    toast('Uplink interrupted', snap?.error || 'Could not reach the data network. Showing the last known picture.', 'i-warning');
    if (!state.snapshot) renderEmpty();
    if (initial) hideLoader();
    return;
  }

  state.simulated = false;
  if (!snap.events?.length) {
    snap.events = demoEvents();
    snap.iss = snap.iss || demoIss();
    snap.aurora = snap.aurora || demoAurora();
    snap.fireballs = snap.fireballs?.length ? snap.fireballs : demoFireballs();
    snap.stats = {
      total: snap.events.length,
      quakes: snap.events.filter((e) => e.cat === 'seismic').length,
      maxMag: Math.max(...snap.events.filter((e) => e.cat === 'seismic').map((e) => e.mag || 0), 0),
      fires: snap.events.filter((e) => e.cat === 'fire').length,
      storms: snap.events.filter((e) => e.cat === 'storm').length,
      warnings: snap.events.filter((e) => e.cat === 'warning' || e.cat === 'tsunami').length,
      fireballs: snap.fireballs.length,
      auroraCells: snap.aurora.points.length,
    };
    snap.signal = 0;
    snap.sources = {};
    snap.mode = 'live';
    snap.at = new Date().toISOString();
    snap.simulated = true;
    state.simulated = true;
  }

  state.snapshot = snap;
  state.syncAt = Date.now();
  state.sun = subsolarPoint(new Date(snap.at || Date.now()));

  const events = [...snap.events];
  if (snap.fireballs?.length) for (const f of snap.fireballs) events.push(f);

  state.events = events;
  applySnapshot();

  if (initial) {
    globe.focus(18, 100, 4.16, false);
    loaderProgress(88, 'Synchronising planetary layers…');
  }
  if (snap.simulated) {
    toast('Simulation mode', 'Live feeds are unreachable. Synthetic telemetry is now driving the globe.', 'i-warning');
  }
  hideLoader();
}

function applySnapshot() {
  const snap = state.snapshot;
  if (!snap) return;

  const at = snap.mode === 'history' ? new Date(snap.at) : new Date();
  globe.setSun(at);
  state.sun = subsolarPoint(at);

  globe.setEvents(state.events);
  globe.setAurora(snap.aurora || { points: [] });
  globe.setAuroraVisible(state.layers.has('aurora'));
  globe.setIss(snap.iss, state.layers.has('iss'));

  updateCounts();
  renderStream();
  renderPulse();
  renderSpace();
  updateSignal();
  updateSyncAge();
  updateFeedStatus();

  if (state.selectedId) {
    const still = state.events.find((e) => e.id === state.selectedId);
    if (still) { state.selected = still; globe.highlight(still); }
    else closeDetail();
  }
}

function renderEmpty() {
  const events = demoEvents();
  const fireballs = demoFireballs();
  const aurora = demoAurora();
  const iss = demoIss();
  state.snapshot = {
    mode: 'live',
    at: new Date().toISOString(),
    fetchedAt: Date.now(),
    events, fireballs, aurora, iss,
    stats: {
      total: events.length,
      quakes: events.filter((e) => e.cat === 'seismic').length,
      maxMag: Math.max(...events.filter((e) => e.cat === 'seismic').map((e) => e.mag || 0), 0),
      fires: events.filter((e) => e.cat === 'fire').length,
      storms: events.filter((e) => e.cat === 'storm').length,
      warnings: events.filter((e) => e.cat === 'warning').length,
      fireballs: fireballs.length,
      auroraCells: aurora.points.length,
    },
    online: false,
    signal: 0,
    sources: {},
    simulated: true,
  };
  state.simulated = true;
  state.events = [...events, ...fireballs];
  state.syncAt = Date.now();
  applySnapshot();
  toast('Simulation mode', 'No uplink available. Synthetic telemetry is driving the globe.', 'i-warning');
}

/* ------------------------------------------------------------------ */
/* stream                                                              */
/* ------------------------------------------------------------------ */

function filteredEvents() {
  return state.events.filter((e) => {
    if (e.cat === 'fireball') return state.tab === 'space' || state.layers.has('fireballs');
    return state.layers.has(layerOf(e.cat));
  });
}

function eventMeta(e) {
  if (e.cat === 'seismic') return `M ${(e.mag || 0).toFixed(1)} · ${e.depth ?? 0} km deep · ${esc(e.source)}`;
  if (e.cat === 'warning' || e.cat === 'tsunami') return `starts ${fmtTime(e.time)} · ${esc(e.source)}`;
  return `${esc(e.source)} · ${relative(e.time)}${e.approx ? ' · approx.' : ''}`;
}

function renderStream() {
  const list = $('#stream-list');
  if (!list) return;

  if (state.tab === 'space') { list.hidden = true; return; }
  list.hidden = false;

  let events = filteredEvents();
  if (state.tab === 'live') events = events.filter((e) => e.cat !== 'fireball');
  events.sort((a, b) => {
    const pa = (b.priority || 0) - (a.priority || 0);
    if (pa !== 0) return pa;
    return b.time - a.time;
  });

  $('#event-count').textContent = events.length;
  const frag = document.createDocumentFragment();

  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'stream-empty';
    empty.innerHTML = state.simulated
      ? 'No live uplink.<br/>Synthetic telemetry is active.'
      : 'No events match the active layers.<br/>Try enabling more layers.';
    list.replaceChildren(empty);
    return;
  }

  for (const e of events.slice(0, 160)) {
    const row = document.createElement('div');
    row.className = 'event-row' + (state.selectedId === e.id ? ' selected' : '');
    row.dataset.id = e.id;
    row.innerHTML = `
      <span class="event-icon ${e.cat}" style="color:${CATEGORY_COLOR[e.cat] || '#ffb648'}">
        <svg><use href="#${CAT_ICON[e.cat] || 'i-warning'}"/></svg>
      </span>
      <span class="event-main">
        <span class="event-title">${esc(e.title)}</span>
        <span class="event-meta"><span class="event-sev" style="color:${CATEGORY_COLOR[e.cat] || '#ffb648'}"></span>${eventMeta(e)}</span>
      </span>`;
    row.addEventListener('click', () => selectEvent(e, true));
    frag.appendChild(row);
  }
  list.replaceChildren(frag);
}

function renderSpace() {
  const snap = state.snapshot;
  const iss = snap?.iss;
  if (iss) {
    $('#iss-lat').textContent = `${Math.abs(iss.lat).toFixed(2)}° ${iss.lat >= 0 ? 'N' : 'S'}`;
    $('#iss-lon').textContent = `${Math.abs(iss.lon).toFixed(2)}° ${iss.lon >= 0 ? 'E' : 'W'}`;
    $('#iss-alt').textContent = `${iss.altitude} km`;
    $('#iss-vel').textContent = `${(iss.velocity / 1000).toFixed(2)} km/s`;
  }
  const au = snap?.aurora;
  if (au?.points?.length) {
    let peak = 0, cells = 0;
    for (const p of au.points) { if (p[2] > peak) peak = p[2]; cells++; }
    $('#aurora-cells').textContent = cells.toLocaleString();
    $('#aurora-peak').textContent = Math.round(peak);
    $('#aurora-summary').textContent = `Auroral oval active across ${cells.toLocaleString()} grid cells with a peak intensity of ${Math.round(peak)} GW. Visible on the night side above ${au.points.some((p) => p[0] < 0) ? 'both' : 'northern'} polar circles.`;
  } else {
    $('#aurora-summary').textContent = 'No auroral oval data in this snapshot.';
  }

  const fl = $('#fireball-list');
  const fireballs = (snap?.fireballs || []).slice(0, 6);
  if (!fireballs.length) {
    fl.innerHTML = '<div class="fireball-row"><span>NO DATA</span> No atmospheric impacts in the last 30 days<b>—</b></div>';
  } else {
    fl.innerHTML = fireballs.map((f) => `
      <div class="fireball-row">
        <span>${new Date(f.time).toISOString().slice(5, 10)}</span>
        <span>${esc(f.lat.toFixed(1))}°, ${esc(f.lon.toFixed(1))}°</span>
        <b>${esc(f.subtitle.split(' · ')[0])}</b>
      </div>`).join('');
  }
}

/* ------------------------------------------------------------------ */
/* pulse, counts, status                                               */
/* ------------------------------------------------------------------ */

function updateCounts() {
  const counts = {
    seismic: 0, disasters: 0, gdacs: 0, tsunami: 0, storms: 0, fires: 0, warnings: 0,
  };
  for (const e of state.events) {
    if (e.cat === 'seismic') counts.seismic++;
    else if (e.cat === 'tsunami') counts.tsunami++;
    else if (e.cat === 'warning') counts.warnings++;
    else if (e.cat === 'storm') counts.storms++;
    else if (e.cat === 'fire') counts.fires++;
    else if (e.cat === 'volcano' || e.cat === 'flood') counts.disasters++;
    else if (e.cat === 'disaster') counts.gdacs++;
  }
  $$('[data-count]').forEach((el) => {
    const k = el.dataset.count;
    if (k in counts) el.textContent = counts[k].toLocaleString();
  });
  const au = state.snapshot?.aurora?.points?.length;
  const issEl = $('[data-count="iss"]');
  if (issEl) issEl.textContent = state.snapshot?.iss ? 'LEO' : '—';
  const auroraEl = $('[data-count="aurora"]');
  if (auroraEl) auroraEl.textContent = au ? Math.round(au).toLocaleString() : '—';
  const fbEl = $('[data-count="fireballs"]');
  if (fbEl) fbEl.textContent = (state.snapshot?.fireballs?.length || 0).toLocaleString();
}

function renderPulse() {
  const s = state.snapshot?.stats || {};
  const activity = clamp(Math.round((s.quakes || 0) * 1.15 + (s.storms || 0) * 5 + (s.fires || 0) * 1.35 + (s.warnings || 0) * 0.4 + (s.fireballs || 0) * 1.5), 3, 100);
  const gauge = $('#pulse-gauge');
  if (gauge) gauge.style.setProperty('--v', activity);
  $('#pulse-value').textContent = activity;
  $('#pulse-quakes').textContent = s.quakes ?? 0;
  $('#pulse-mag').textContent = (s.maxMag || 0).toFixed(1);
  $('#pulse-fires').textContent = s.fires ?? 0;
  $('#pulse-warnings').textContent = s.warnings ?? 0;
  const status = activity >= 75 ? 'EXTREME' : activity >= 50 ? 'ACTIVE' : activity >= 28 ? 'ELEVATED' : 'CALM';
  $('#pulse-status') && ($('#pulse-status').textContent = status);

  const r = rankInfo();
  $('#rank-name').textContent = r.name;
  $('#rank-points').textContent = `${user.points} pts`;
  $('#rank-next').textContent = r.next ? `${r.next.min - user.points} to ${r.next.name}` : 'MAX RANK';
  $('#rank-fill').style.width = `${r.pct}%`;
}

function updateSignal() {
  const snap = state.snapshot;
  const pct = snap?.signal ?? (state.simulated ? 0 : 100);
  const el = $('#signal-label');
  el.textContent = state.simulated ? 'SIMULATED' : `SIGNAL ${pct}%`;
  el.style.color = state.simulated ? '#ffc46a' : pct >= 80 ? '#7fe9c1' : pct >= 40 ? '#ffd166' : '#ff8a8a';
  el.style.borderColor = state.simulated ? 'rgba(255,190,90,.3)' : 'rgba(80,220,160,.18)';
  const sources = Object.values(snap?.sources || {}).filter((v) => v === 'live').length;
  $('#layer-sources').textContent = state.simulated ? 'SIMULATED TELEMETRY' : `${sources || 6} FEEDS LINKED`;
}

function updateFeedStatus() {
  const snap = state.snapshot;
  const el = $('#feed-status');
  const srcEl = $('#feed-sources');
  const statuses = Object.values(snap?.sources || {});
  const cached = statuses.filter((s) => s === 'cached').length;
  const offline = statuses.filter((s) => s === 'offline').length;
  if (state.simulated) {
    el.innerHTML = '<span class="tiny-dot" style="background:#ffc46a;box-shadow:0 0 6px #ffc46a"></span> SIMULATED FEED';
    el.style.color = '#d6a85c';
  } else if (offline || cached) {
    el.innerHTML = '<span class="tiny-dot" style="background:#ffd166;box-shadow:0 0 6px #ffd166"></span> PARTIAL UPLINK · CACHE';
    el.style.color = '#cda75f';
  } else {
    el.innerHTML = '<span class="tiny-dot"></span> ALL SYSTEMS NOMINAL';
    el.style.color = '';
  }
  if (state.time.active) {
    el.innerHTML = '<span class="tiny-dot" style="background:#ffc46a;box-shadow:0 0 6px #ffc46a"></span> HISTORICAL DATASET';
    el.style.color = '#d6a85c';
  }
  srcEl.textContent = state.simulated ? 'SYNTHETIC' : 'USGS · NASA · NOAA · NWS';
}

function updateSyncAge() {
  const el = $('#sync-age');
  if (!el) return;
  if (!state.syncAt) { el.textContent = 'linking…'; return; }
  if (state.fetching) { el.textContent = 'syncing…'; return; }
  const age = Math.round((Date.now() - state.syncAt) / 1000);
  el.textContent = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;
}

function updateClock() {
  const now = new Date();
  const el = $('#clock-utc');
  if (el) el.textContent = now.toISOString().slice(11, 19) + ' UTC';
}

/* ------------------------------------------------------------------ */
/* selection + detail                                                  */
/* ------------------------------------------------------------------ */

function selectEvent(ev, fly = true) {
  state.selected = ev;
  state.selectedId = ev.id;
  hideProbeCard();
  globe.highlight(ev);
  globe.focus(ev.lat, ev.lon, 2.7, fly);

  if (ev.cat === 'storm') user.flags.storm = true;
  if (!user.discoveries.includes(ev.id)) {
    user.discoveries.push(ev.id);
    award(6, `Discovery logged · ${ev.title}`);
    saveUser();
  }
  evaluateAchievements();
  renderDetail(ev);

  $$('.event-row').forEach((r) => r.classList.toggle('selected', r.dataset.id === ev.id));
  if (state.tab === 'live' && fly) {
    const row = $(`.event-row[data-id="${CSS.escape(ev.id)}"]`);
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function renderDetail(ev) {
  const card = $('#detail-card');
  card.hidden = false;
  card.innerHTML = `
    <div class="card-head">
      <div style="min-width:0">
        <div class="card-kicker"><b>EVENT DOSSIER</b> · ${esc(CAT_LABEL[ev.cat] || 'Event')}</div>
        <div class="card-title">${esc(ev.title)}</div>
        <div class="card-sub">${esc(ev.source)} · ${fmtDateTime(ev.time)} ${ev.approx ? '· approximate area' : ''}</div>
      </div>
      <button class="card-close" id="detail-close" aria-label="Close"><svg><use href="#i-x"/></svg></button>
    </div>
    <div class="card-body">
      <div class="stat-grid">
        <div class="stat"><span>COORDINATES</span><b>${Math.abs(ev.lat).toFixed(2)}°${ev.lat >= 0 ? 'N' : 'S'}<br/>${Math.abs(ev.lon).toFixed(2)}°${ev.lon >= 0 ? 'E' : 'W'}</b></div>
        <div class="stat"><span>${ev.cat === 'seismic' ? 'MAGNITUDE' : 'SEVERITY'}</span><b>${ev.cat === 'seismic' ? `M ${(ev.mag || 0).toFixed(1)}` : `${Math.round((ev.severity || 0) * 100)}%`}<small>${ev.cat === 'seismic' ? `/ ${ev.depth} km` : ''}</small></b></div>
        <div class="stat"><span>LOCAL TIME</span><b>${new Date(ev.time).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}<small>${relative(ev.time)}</small></b></div>
        <div class="stat"><span>REGION</span><b style="font-size:11px;line-height:1.4">${esc(ev.place || ev.subtitle || '—')}</b></div>
      </div>
      ${ev.headline ? `<p class="card-note"><b style="color:#a9d8ea">${esc(ev.headline)}</b></p>` : ''}
      ${ev.description ? `<p class="card-note">${esc(ev.description)}</p>` : ''}
      ${!ev.description ? `<p class="card-note">${esc(ev.subtitle || '')}${ev.cat === 'seismic' ? ' — recorded by the USGS advanced national seismic system. Click the globe around this point to probe conditions on the ground.' : ''}</p>` : ''}
      <div class="card-actions">
        <button class="card-btn" id="detail-fly"><svg><use href="#i-target"/></svg> CENTRE ON EVENT</button>
        ${ev.url ? '<button class="card-btn ghost" id="detail-source"><svg><use href="#i-external"/></svg> OPEN SOURCE</button>' : ''}
        <button class="card-btn ghost" id="detail-probe"><svg><use href="#i-locate"/></svg> PROBE NEARBY</button>
      </div>
    </div>`;

  $('#detail-close').onclick = closeDetail;
  $('#detail-fly').onclick = () => globe.focus(ev.lat, ev.lon, 1.85, true);
  $('#detail-probe').onclick = () => probeAt(ev.lat + 1.2, ev.lon + 1.2);
  const src = $('#detail-source');
  if (src) src.onclick = () => ev.url && window.earth.open(ev.url);
}

function closeDetail() {
  state.selected = null;
  state.selectedId = null;
  globe.highlight(null);
  $('#detail-card').hidden = true;
  $$('.event-row').forEach((r) => r.classList.remove('selected'));
}

/* ------------------------------------------------------------------ */
/* probe                                                               */
/* ------------------------------------------------------------------ */

async function probeAt(lat, lon) {
  lat = clamp(lat, -89.9, 89.9);
  lon = ((lon + 540) % 360) - 180;
  hideDetail();
  state.probePoint = { lat, lon };
  globe.setProbe(lat, lon);
  globe.focus(lat, lon, Math.min(globe.camera.position.length(), 2.9), true);

  const card = $('#probe-card');
  card.hidden = false;
  card.innerHTML = `
    <div class="card-head">
      <div>
        <div class="card-kicker"><b>SURFACE PROBE</b> · ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} / ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}</div>
        <div class="card-title">Acquiring conditions…</div>
        <div class="card-sub">Reverse geocoding · weather downlink</div>
      </div>
      <button class="card-close" id="probe-close" aria-label="Close"><svg><use href="#i-x"/></svg></button>
    </div>
    <div class="card-body">
      <div class="probe-loading"><span class="spinner"></span> Reading local sensors and nearby hazards…</div>
      <div class="probe-skeleton"></div>
    </div>`;
  $('#probe-close').onclick = closeProbe;

  registerProbe(lat, lon);

  let data = null;
  try { data = await window.earth.probe(lat, lon); } catch { data = null; }
  if (state.probePoint?.lat !== lat || state.probePoint?.lon !== lon) return;
  renderProbe(data || { lat, lon, place: `${Math.abs(lat).toFixed(2)}°, ${Math.abs(lon).toFixed(2)}°` });
}

function registerProbe(lat, lon) {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  if (!user.probes.includes(key)) {
    user.probes.push(key);
    award(10, 'New coordinate probed');
    saveUser();
  }
  const sunEl = sunElevation(lat, lon, state.sun);
  if (sunEl < -12) user.flags.nightWatch = true;
  if (Math.abs(lat) > 60 && state.layers.has('aurora')) user.flags.aurora = true;

  const nearQuake = state.events.find((e) => e.cat === 'seismic' && (e.mag || 0) >= 5.5 && haversine(lat, lon, e.lat, e.lon) < 350);
  if (nearQuake) user.flags.ringOfFire = true;
  const nearFire = state.events.find((e) => e.cat === 'fire' && haversine(lat, lon, e.lat, e.lon) < 250);
  if (nearFire) user.flags.fireWalker = true;
  saveUser();
  evaluateAchievements();
}

function renderProbe(d) {
  const card = $('#probe-card');
  const lat = d.lat, lon = d.lon;
  const sunEl = sunElevation(lat, lon, state.sun);
  const day = sunEl > 0;
  const w = d.weather;
  const temp = w?.temp != null ? Math.round(w.temp) : null;
  const nearby = state.events
    .filter((e) => e.cat !== 'fireball')
    .map((e) => ({ e, dist: haversine(lat, lon, e.lat, e.lon) }))
    .filter((x) => x.dist < 900)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3);

  const localTime = (() => {
    if (d.utcOffset != null) {
      const t = new Date(Date.now() + d.utcOffset * 1000);
      return t.toISOString().slice(11, 16);
    }
    return new Date(Date.now() + lon * 4 * 60e3).toISOString().slice(11, 16);
  })();

  card.innerHTML = `
    <div class="card-head">
      <div style="min-width:0">
        <div class="card-kicker"><b>SURFACE PROBE</b> · ${d.timezone || 'LOCAL SOLAR'} ${d.timezoneAbbr ? `(${esc(d.timezoneAbbr)})` : ''}</div>
        <div class="card-title">${esc(d.place)}</div>
        <div class="card-sub">${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'} · ${day ? 'day side' : 'night side'}</div>
      </div>
      <button class="card-close" id="probe-close" aria-label="Close"><svg><use href="#i-x"/></svg></button>
    </div>
    <div class="card-body">
      <div class="stat-grid">
        <div class="stat"><span>LOCAL TIME</span><b>${localTime}<small>${esc(d.timezoneAbbr || 'solar')}</small></b></div>
        <div class="stat"><span>TEMPERATURE</span><b>${temp != null ? `${temp}°C` : '—'}<small>${w?.feels != null ? `feels ${Math.round(w.feels)}°` : 'no sensor'}</small></b></div>
        <div class="stat"><span>WIND</span><b>${w?.wind != null ? `${Math.round(w.wind)}<small>km/h</small>` : '—'}</b></div>
        <div class="stat"><span>HUMIDITY</span><b>${w?.humidity != null ? `${Math.round(w.humidity)}<small>%</small>` : '—'}</b></div>
      </div>
      <div class="stat-grid three" style="margin-top:12px">
        <div class="stat"><span>CONDITIONS</span><b style="font-size:11.5px">${esc(weatherText(w?.code, day ? 1 : 0))}</b></div>
        <div class="stat"><span>SUN ELEVATION</span><b>${sunEl.toFixed(1)}°<small>${day ? 'above horizon' : 'below horizon'}</small></b></div>
        <div class="stat"><span>PRESSURE</span><b>${w?.pressure != null ? `${Math.round(w.pressure)}<small>hPa</small>` : '—'}</b></div>
      </div>
      ${d.sunrise || d.sunset ? `<p class="card-note" style="color:#638296;font-size:9px">☀ ${d.sunrise ? esc(d.sunrise.slice(11)) : '—'} · ☾ ${d.sunset ? esc(d.sunset.slice(11)) : '—'} local</p>` : ''}
      ${nearby.length ? `<div class="card-near">
        <div class="card-near-label">NEARBY HAZARDS</div>
        ${nearby.map(({ e, dist }) => `<span class="near-chip" data-id="${esc(e.id)}"><b>${Math.round(dist)} km</b> ${esc(e.title)}</span>`).join('')}
      </div>` : ''}
      <div class="card-actions">
        <button class="card-btn" id="probe-save"><svg><use href="#i-save"/></svg> SAVE WAYPOINT</button>
        <button class="card-btn ghost" id="probe-copy"><svg><use href="#i-locate"/></svg> COPY COORDINATES</button>
        <button class="card-btn ghost" id="probe-close2">CLOSE</button>
      </div>
    </div>`;

  $('#probe-close').onclick = closeProbe;
  $('#probe-close2').onclick = closeProbe;
  $('#probe-save').onclick = () => {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (user.waypoints.includes(key)) { toast('Already logged', 'This waypoint is already in your operator log.', 'i-save'); return; }
    user.waypoints.push(key);
    award(5, 'Waypoint saved');
    saveUser();
    toast('Waypoint saved', `${d.place} · ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`, 'i-save');
  };
  $('#probe-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(`${lat.toFixed(5)}, ${lon.toFixed(5)}`); toast('Coordinates copied', `${lat.toFixed(4)}, ${lon.toFixed(4)}`, 'i-target'); }
    catch { toast('Clipboard blocked', 'Select the coordinates manually.', 'i-warning'); }
  };
  $$('.near-chip', card).forEach((chip) => {
    chip.onclick = () => {
      const ev = state.events.find((x) => x.id === chip.dataset.id);
      if (ev) selectEvent(ev, true);
    };
  });
}

function closeProbe() {
  state.probePoint = null;
  globe.clearProbe();
  const card = $('#probe-card');
  card.hidden = true;
  card.innerHTML = '';
}

function hideProbeCard() {
  state.probePoint = null;
  globe.clearProbe();
  $('#probe-card').hidden = true;
}

function hideDetail() {
  state.selected = null;
  state.selectedId = null;
  globe.highlight(null);
  $('#detail-card').hidden = true;
}

/* ------------------------------------------------------------------ */
/* space                                                               */
/* ------------------------------------------------------------------ */

function trackIss() {
  const iss = state.snapshot?.iss;
  if (!iss) { toast('ISS telemetry unavailable', 'The orbital feed is offline in this snapshot.', 'i-sat'); return; }
  switchTab('space');
  globe.focus(iss.lat, iss.lon, 2.2, true);
  globe.setIssVisible(true);
  user.flags.iss = true;
  saveUser();
  evaluateAchievements();
  toast('Tracking ISS', `Altitude ${iss.altitude} km · ${(iss.velocity / 1000).toFixed(2)} km/s`, 'i-sat');
}

function focusAurora() {
  const pts = state.snapshot?.aurora?.points || [];
  if (!pts.length) { toast('No aurora data', 'NOAA has not published an auroral oval for this snapshot.', 'i-aurora'); return; }
  let best = pts[0];
  for (const p of pts) if (p[2] > best[2]) best = p;
  if (!state.layers.has('aurora')) {
    const cb = $('[data-layer="aurora"]');
    if (cb) { cb.checked = true; onLayerChange(); }
  }
  globe.focus(best[0], best[1], 2.35, true);
  toast('Auroral oval', `Peak intensity ${Math.round(best[2])} at ${best[0].toFixed(1)}° latitude`, 'i-aurora');
}

/* ------------------------------------------------------------------ */
/* time machine                                                        */
/* ------------------------------------------------------------------ */

const timeline = $('#timeline');
const tlRange = $('#tl-range');

function toggleTimeMachine(forceOpen) {
  const open = forceOpen ?? timeline.hidden;
  if (!open && state.time.active && !state.time.playing) {
    returnLive();
    return;
  }
  timeline.hidden = !open;
  $('#time-btn').classList.toggle('active', open);
  $('#hint').style.opacity = open ? '0' : '1';
  if (open) updateTimelineUI();
}

function updateTimelineUI() {
  const days = state.time.days;
  const date = new Date(Date.now() - days * 86400e3);
  $('#tl-date').textContent = `${fmtDate(date)} · ${fmtTime(date)} UTC`;
  $('#tl-offset').textContent = days === 0 ? 'LIVE' : `-${days} DAY${days > 1 ? 'S' : ''}`;
  tlRange.value = days;
  tlRange.style.setProperty('--p', `${(days / 30) * 100}%`);
  $('#time-btn').classList.toggle('active', !timeline.hidden);
}

async function goToDay(days, { animate = false } = {}) {
  days = clamp(Math.round(days), 0, 30);
  state.time.days = days;
  state.time.active = days > 0;
  state.time.at = days > 0 ? new Date(Date.now() - days * 86400e3).toISOString() : null;
  updateTimelineUI();
  $('#live-pill').classList.toggle('archive', days > 0);
  $('#live-pill').innerHTML = days > 0 ? '<span class="live-dot" style="background:#ffc46a"></span>ARCHIVE' : '<span class="live-dot"></span>LIVE';
  if (days > 0) {
    user.flags.timeTravel = true;
    saveUser();
    evaluateAchievements();
  }
  await fetchSnapshot({ force: true });
  if (animate) state.time.playing = false;
}

function playTimeline() {
  if (state.time.playing) {
    state.time.playing = false;
    $('#tl-play').innerHTML = '<svg><use href="#i-play"/></svg>';
    return;
  }
  state.time.playing = true;
  toggleTimeMachine(true);
  $('#tl-play').innerHTML = '<svg><use href="#i-pause"/></svg>';
  const tick = async () => {
    if (!state.time.playing) return;
    const next = state.time.days + 1;
    if (next > 30) {
      state.time.playing = false;
      $('#tl-play').innerHTML = '<svg><use href="#i-play"/></svg>';
      return;
    }
    await goToDay(next);
    setTimeout(tick, 350);
  };
  if (!state.time.active) goToDay(1).then(() => setTimeout(tick, 350));
  else setTimeout(tick, 350);
}

function returnLive() {
  state.time.playing = false;
  $('#tl-play').innerHTML = '<svg><use href="#i-play"/></svg>';
  timeline.hidden = true;
  $('#time-btn').classList.remove('active');
  $('#hint').style.opacity = '1';
  goToDay(0);
}

/* ------------------------------------------------------------------ */
/* progression UI                                                      */
/* ------------------------------------------------------------------ */

function award(points, reason, silent = false) {
  user.points += points;
  saveUser();
  renderUser();
  if (!silent && reason) toast('Telemetry logged', `${reason} · +${points} data points`, 'i-zap', points);
}

function renderUser() {
  const r = rankInfo();
  $('#rank-name').textContent = r.name;
  $('#rank-points').textContent = `${user.points} pts`;
  $('#rank-next').textContent = r.next ? `${Math.max(0, r.next.min - user.points)} to ${r.next.name}` : 'MAX RANK';
  $('#rank-fill').style.width = `${r.pct}%`;
  $('#ops-label').textContent = user.points > 0 ? `OPERATOR · ${user.points}` : 'OPERATOR';
  $('#ops-rank').textContent = r.name;
  $('#ops-points').textContent = user.points;
  $('#ops-probes').textContent = user.probes.length;
  $('#ops-disc').textContent = user.discoveries.length;
  $('#ops-fill').style.width = `${r.pct}%`;
  $('#ops-next').textContent = r.next
    ? `Next rank: ${r.next.name} at ${r.next.min} points (${Math.max(0, r.next.min - user.points)} to go)`
    : 'Maximum rank achieved — the whole planet is your dashboard.';
  if ($('#ops-modal') && !$('#ops-modal').hidden) renderAchievements();
}

function renderAchievements() {
  const wrap = $('#ops-achievements');
  wrap.innerHTML = ACHIEVEMENTS.map((a) => {
    const unlocked = !!user.achievements[a.id];
    return `<div class="ach ${unlocked ? 'unlocked' : ''}">
      <span class="ach-icon"><svg><use href="#${a.icon}"/></svg></span>
      <span><b>${esc(a.name)}</b><p>${unlocked ? 'Unlocked' : esc(a.desc)} · +${a.pts} pts</p></span>
    </div>`;
  }).join('');
}

function evaluateAchievements() {
  let changed = false;
  const cond = {
    first_probe: user.probes.length >= 1,
    five_probes: user.probes.length >= 5,
    ring_of_fire: !!user.flags.ringOfFire,
    night_watch: !!user.flags.nightWatch,
    fire_walker: !!user.flags.fireWalker,
    aurora_hunter: !!user.flags.aurora,
    storm_chaser: !!user.flags.storm,
    time_traveler: !!user.flags.timeTravel,
    space_agency: !!user.flags.iss,
    global_network: !!user.flags.allLayers,
  };
  for (const a of ACHIEVEMENTS) {
    if (!user.achievements[a.id] && cond[a.id]) {
      user.achievements[a.id] = Date.now();
      user.points += a.pts;
      changed = true;
      toast('Achievement unlocked', `${a.name} — ${a.desc}`, 'i-trophy', a.pts);
    }
  }
  if (changed) {
    saveUser();
    renderUser();
    renderPulse();
  }
}

/* ------------------------------------------------------------------ */
/* tabs, layers, search, UI                                            */
/* ------------------------------------------------------------------ */

function switchTab(tab) {
  state.tab = tab;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#tab-line').classList.toggle('right', tab === 'space');
  $('#stream-list').hidden = tab === 'space';
  $('#space-view').hidden = tab !== 'space';
  $('#stream-title').textContent = tab === 'space' ? 'ORBITAL TELEMETRY' : 'LIVE EVENT STREAM';
  $('#event-count').parentElement.style.visibility = tab === 'space' ? 'hidden' : 'visible';
  renderStream();
  if (tab === 'space') renderSpace();
}

function onLayerChange() {
  const boxes = $$('.switch input');
  state.layers = new Set(boxes.filter((b) => b.checked).map((b) => b.dataset.layer));
  globe.setFilters(state.layers);
  globe.setAuroraVisible(state.layers.has('aurora'));
  globe.setIssVisible(state.layers.has('iss'));
  renderStream();
  if (state.layers.size === boxes.length) {
    user.flags.allLayers = true;
    saveUser();
    evaluateAchievements();
  }
}

function doSearch(q) {
  clearTimeout(state.searchTimer);
  const box = $('#search-results');
  if (!q.trim()) { box.hidden = true; box.innerHTML = ''; return; }
  state.searchTimer = setTimeout(async () => {
    let results = [];
    try { results = await window.earth.search(q); } catch { results = []; }
    if (!results?.length) {
      box.innerHTML = '<div class="search-empty">No place found. Try “Tokyo”, “Andes” or “51.5, -0.12”.</div>';
      box.hidden = false;
      return;
    }
    box.innerHTML = results.map((r, i) => `
      <div class="search-item" data-i="${i}" data-lat="${r.lat}" data-lon="${r.lon}" data-name="${esc(r.name)}">
        <svg class="si-pin"><use href="#i-target"/></svg>
        <span class="si-name">${esc(r.name)}</span>
        <span class="si-meta">${esc([r.admin, r.country].filter(Boolean).join(', '))}</span>
      </div>`).join('');
    box.hidden = false;
    $$('.search-item', box).forEach((item) => {
      item.onclick = () => {
        const lat = +item.dataset.lat, lon = +item.dataset.lon;
        box.hidden = true;
        $('#search-input').value = item.dataset.name;
        $('#search-input').blur();
        probeAt(lat, lon);
        globe.focus(lat, lon, 2.25, true);
      };
    });
  }, 260);
}

async function nearMe() {
  const btn = $('#near-btn');
  btn.classList.add('active');
  try {
    let loc = null;
    try { loc = await window.earth.locate(); } catch { loc = null; }
    if (!loc || !Number.isFinite(loc.lat)) {
      loc = await new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, city: '' }),
          () => resolve(null), { timeout: 8000 },
        );
      });
    }
    if (!loc) { toast('Position unavailable', 'Could not resolve your location from the network.', 'i-target'); return; }
    probeAt(loc.lat, loc.lon);
    globe.focus(loc.lat, loc.lon, 2.3, true);
    toast('Local uplink', [loc.city, loc.region, loc.country].filter(Boolean).join(', ') || `${loc.lat.toFixed(2)}°, ${loc.lon.toFixed(2)}°`, 'i-target');
  } finally {
    btn.classList.remove('active');
  }
}

function saveSnapshot() {
  const data = globe?.takeSnapshot();
  if (!data) { toast('Snapshot failed', 'The GPU could not export a frame.', 'i-warning'); return; }
  const a = document.createElement('a');
  a.href = data;
  a.download = `earth-online-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Snapshot saved', 'A full-resolution frame was written to your Downloads folder.', 'i-camera');
}

function toast(title, text, icon = 'i-zap', pts = 0) {
  const stack = $('#toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `
    <span class="toast-icon"><svg><use href="#${icon}"/></svg></span>
    <span style="min-width:0"><b>${esc(title)}</b><p>${esc(text)}</p></span>
    ${pts ? `<span class="pts">+${pts}</span>` : ''}`;
  stack.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 4200);
  while (stack.children.length > 4) stack.firstElementChild.remove();
}

function openModal(id) {
  $$('.modal').forEach((m) => { m.hidden = true; });
  const m = $('#' + id);
  if (m) m.hidden = false;
  if (id === 'ops-modal') { renderUser(); renderAchievements(); }
}

function closeModals() { $$('.modal').forEach((m) => { m.hidden = true; }); }

/* ------------------------------------------------------------------ */
/* binding                                                             */
/* ------------------------------------------------------------------ */

function bindUI() {
  $('#refresh-btn').onclick = () => fetchSnapshot({ force: true });
  $('#guide-btn').onclick = () => openModal('guide-modal');
  $('#ops-btn').onclick = () => openModal('ops-modal');
  $('#snapshot-btn').onclick = saveSnapshot;
  $('#near-btn').onclick = nearMe;
  $('#pulse-close').onclick = () => { $('#pulse-card').style.display = 'none'; };

  $$('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModals(); });
  });

  $$('.tab').forEach((tab) => { tab.onclick = () => switchTab(tab.dataset.tab); });
  $('#tab-line').classList.remove('right');

  $$('.switch input').forEach((cb) => { cb.onchange = onLayerChange; });

  $('#iss-locate').onclick = trackIss;
  $('#aurora-view').onclick = focusAurora;

  const input = $('#search-input');
  input.addEventListener('input', (e) => doSearch(e.target.value));
  input.addEventListener('focus', () => { if (input.value.trim()) doSearch(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('.search-item');
      if (first) first.click();
    } else if (e.key === 'Escape') {
      $('#search-results').hidden = true;
      input.blur();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) $('#search-results').hidden = true;
  });

  $('#time-btn').onclick = () => toggleTimeMachine();
  tlRange.addEventListener('input', () => {
    const days = +tlRange.value;
    state.time.days = days;
    updateTimelineUI();
  });
  tlRange.addEventListener('change', () => goToDay(+tlRange.value));
  $('#tl-live').onclick = returnLive;
  $('#tl-play').onclick = playTimeline;

  $('#ops-reset').onclick = () => {
    if (!confirm('Reset all points, discoveries and achievements?')) return;
    user = structuredClone(DEFAULT_USER);
    saveUser();
    renderUser();
    renderAchievements();
    renderPulse();
    toast('Profile reset', 'Operator progression cleared.', 'i-refresh');
  };

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === '/') { e.preventDefault(); input.focus(); input.select(); }
    else if (e.key === 'Escape') { closeModals(); closeDetail(); closeProbe(); $('#search-results').hidden = true; }
    else if (e.key.toLowerCase() === 'r') fetchSnapshot({ force: true });
    else if (e.key.toLowerCase() === 't') toggleTimeMachine();
    else if (e.key.toLowerCase() === 'g') openModal('guide-modal');
  });

  const guide = $('#guide-modal');
  guide.hidden = true;

  updateTimelineUI();
  updateFeedStatus();
  renderAchievements();
  renderUser();
}

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

boot().catch((err) => {
  console.error(err);
  loaderMsg.textContent = 'Startup error: ' + err.message;
});

window.addEventListener('error', (e) => console.error('Renderer error', e.error || e.message));





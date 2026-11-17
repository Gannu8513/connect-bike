// Ride tracking, the instrument cluster, navigation and replay.
// Speed, distance, altitude and heading come from the phone's GPS; lean and G-force from the
// phone's motion sensors. When a value is not reported the screen shows a dash, never a guess.
import { db } from '../db.js';
import { getSettings, DEFAULT_SETTINGS, rideMetrics, fuelSummary, getOdo, setOdo, parkAt, leaveSpot, currentSpot } from '../data.js';
import {
  esc, num, money, fmtDist, fmtDur, fmtDateTime, fmtTime, toast, refresh, openForm, shareFile, speak, getJson,
  haversine, compass, makeMap, dropMap, dot, icon, meta, sparkline, fileSafe,
} from '../ui.js';
import { sensor, startSensors, stopSensors, recalibrate } from '../sensors.js';
import { isNative, watchPosition, clearWatch } from '../geo.js';

export const title = 'Ride';

const MAX_ACCURACY_M = 40; // ignore fixes worse than this
const MIN_MOVE_M = 8;      // ignore jitter while standing still
const ARRIVE_M = 30;       // how close counts as reaching a turn
const WARN_M = 150;        // speak the turn when this close
const GAUGE_MAX = 160;     // top of the speedometer scale, km/h
const STOP_AFTER_MS = 8000;

// Tracking state lives here so a ride keeps recording while you look at other tabs.
const T = {
  active: false, start: 0, points: [], distance: 0, maxSpeed: null, movingMs: 0, lastFixAt: 0, lastMoveAt: 0,
  speed: null, alt: null, heading: null, acc: null, cur: null, watchId: null, wake: null, timer: null, gpsMsg: '',
};
// Navigation state
const N = { dest: null, coords: null, steps: [], idx: 0, warned: -1, distance: 0, duration: 0, results: null, resultsNote: '', busy: false, error: '', picking: false };
// Replay state for a saved ride
const R = { i: 0, timer: null };

let S = { ...DEFAULT_SETTINGS };
let map = null, trackLine = null, posMarker = null, replayMarker = null, follow = true, shownRide = null, lastSpeedAlert = 0;

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const say = (text) => { if (S.voice) speak(text); };

/* ---------- GPS ---------- */

function ensureWatch() {
  if (T.watchId != null) return;
  if (!isNative && !('geolocation' in navigator)) { T.gpsMsg = 'This browser has no access to GPS.'; return; }
  T.gpsMsg = 'Waiting for GPS signal…';
  T.watchId = watchPosition(onPos, onGpsError);
}

function stopWatch() {
  clearWatch(T.watchId);
  T.watchId = null;
  T.speed = null;
}

function onGpsError(e) {
  T.gpsMsg = e.code === 1
    ? `Location is switched off for this app. Allow it in iPhone Settings${isNative ? ' (Location: While Using, Precise on)' : ''}, then try again.`
    : 'Waiting for GPS signal…';
  T.speed = null;
  paint();
}

function onPos(p) {
  const { latitude, longitude, accuracy, speed, altitude, heading } = p.coords;
  const lat = r6(latitude), lng = r6(longitude);
  const now = Date.now();
  T.cur = [lat, lng];
  T.acc = accuracy;
  T.gpsMsg = '';
  T.speed = typeof speed === 'number' && speed >= 0 ? speed * 3.6 : null;
  T.alt = typeof altitude === 'number' && !Number.isNaN(altitude) ? Math.round(altitude) : null;
  T.heading = typeof heading === 'number' && !Number.isNaN(heading) && T.speed != null && T.speed > 3 ? heading : null;

  if (T.active && accuracy <= MAX_ACCURACY_M) {
    const last = T.points[T.points.length - 1];
    const moved = last ? haversine(last[0], last[1], lat, lng) : 0;
    const stepped = !last || moved >= MIN_MOVE_M;
    if (stepped) {
      if (last) T.distance += moved;
      T.points.push([lat, lng, p.timestamp, T.speed == null ? null : Math.round(T.speed * 10) / 10, T.alt]);
      trackLine?.addLatLng([lat, lng]);
      if (T.points.length % 20 === 0) saveActive();
    }
    // Moving time only counts while the bike is actually moving (auto-pause).
    const moving = T.speed != null ? T.speed >= 3 : stepped && !!last;
    if (moving) {
      T.movingMs += Math.min(now - (T.lastFixAt || now), 5000);
      T.lastMoveAt = now;
    }
    T.lastFixAt = now;
    if (T.speed != null && (T.maxSpeed == null || T.speed > T.maxSpeed)) T.maxSpeed = T.speed;
    if (S.speedAlert && T.speed != null && T.speed > S.speedAlert && now - lastSpeedAlert > 20000) {
      lastSpeedAlert = now;
      say('Speed check');
    }
  }

  if (map) {
    if (!posMarker) posMarker = dot(T.cur, '#2f8fd0').addTo(map);
    else posMarker.setLatLng(T.cur);
    if (follow && !shownRide) map.setView(T.cur, Math.max(map.getZoom(), 15), { animate: true });
  }
  advanceNav();
  paint();
  paintNav();
}

const saveActive = () =>
  db.kvSet('activeRide', { start: T.start, points: T.points, distance: T.distance, maxSpeed: T.maxSpeed, movingMs: T.movingMs }).catch(() => {});

async function wakeOn() {
  try { if ('wakeLock' in navigator) T.wake = await navigator.wakeLock.request('screen'); } catch { /* not available */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && T.active) wakeOn();
});

/** Current position as [lat, lng]; rejects with Error('nopos') when unavailable. */
export function getPos() {
  return new Promise((resolve, reject) => {
    if (T.cur) return resolve(T.cur);
    if (!('geolocation' in navigator)) return reject(new Error('nopos'));
    navigator.geolocation.getCurrentPosition(
      (p) => { T.cur = [r6(p.coords.latitude), r6(p.coords.longitude)]; resolve(T.cur); },
      () => reject(new Error('nopos')),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });
}

/* ---------- Tracking ---------- */

async function startRide() {
  shownRide = null;
  stopReplay();
  Object.assign(T, { active: true, start: Date.now(), points: [], distance: 0, maxSpeed: null, movingMs: 0, lastFixAt: 0, lastMoveAt: Date.now() });
  follow = true;
  ensureWatch();
  wakeOn();
  if (S.sensors) {
    // must be asked for from this tap
    startSensors().then((ok) => { if (!ok) toast('Lean and G-force are off: the phone did not allow motion sensor access.'); });
  }
  leaveSpot().catch(() => {});   // the bike is no longer where it was parked
  clearInterval(T.timer);
  T.timer = setInterval(paint, 1000);
  refresh();
}

function buildRide(src, end, peaks = {}) {
  const m = rideMetrics(src.points);
  return {
    name: '', notes: '',
    start: src.start, end,
    durationS: Math.round((end - src.start) / 1000),
    movingS: src.movingMs ? Math.round(src.movingMs / 1000) : m.movingS,
    distanceM: Math.round(src.distance),
    maxSpeed: src.maxSpeed == null ? null : Math.round(src.maxSpeed * 10) / 10,
    maxAlt: m.maxAlt,
    maxLeanLeft: peaks.maxLeanLeft ?? null, maxLeanRight: peaks.maxLeanRight ?? null, maxG: peaks.maxG ?? null,
    points: src.points,
  };
}

async function stopRide() {
  T.active = false;
  clearInterval(T.timer);
  T.wake?.release?.().catch(() => {});
  T.wake = null;
  const peaks = stopSensors();
  await db.kvDel('activeRide');
  if (!N.steps.length) stopWatch();

  if (T.points.length < 2) {
    toast('No GPS movement was recorded, so nothing was saved.');
    refresh();
    return;
  }
  const ride = buildRide(T, Date.now(), peaks);
  await db.put('rides', ride);
  const end = T.points[T.points.length - 1];
  if (S.autoPark) await parkAt(end[0], end[1], { auto: true });
  refresh();

  // Offer to bring the odometer up to date while the meter is in front of the rider.
  const odo = await getOdo();
  const km = ride.distanceM / 1000;
  openForm({
    title: 'Ride saved',
    note:
      `${num(km, 1)} km by GPS in ${fmtDur(ride.movingS)} of riding.` +
      (S.autoPark ? ' The parking spot was saved.' : '') +
      (odo != null ? ` Your last odometer entry was ${num(odo)} km, so the meter should now read about ${num(odo + km)} km.` : '') +
      ' Type what the meter shows, or skip.',
    fields: [{ name: 'value', label: 'Odometer now (km)', type: 'number' }],
    saveLabel: 'Save', cancelLabel: 'Skip',
    onSave: (v) => {
      if (v.value == null) return undefined;
      if (odo != null && v.value < odo) return `That is lower than your last entry (${num(odo)} km).`;
      return setOdo(v.value);
    },
  });
}

/* ---------- the cluster ---------- */

function gaugeSvg() {
  const cx = 150, cy = 150, r = 128;
  let ticks = '';
  for (let v = 0; v <= GAUGE_MAX; v += 10) {
    const a = Math.PI * (1 - v / GAUGE_MAX);
    const major = v % 20 === 0;
    const r1 = r - (major ? 16 : 9);
    const c = Math.cos(a), s = Math.sin(a);
    ticks += `<line class="tk${major ? ' major' : ''}" x1="${(cx + r * c).toFixed(1)}" y1="${(cy - r * s).toFixed(1)}" x2="${(cx + r1 * c).toFixed(1)}" y2="${(cy - r1 * s).toFixed(1)}"/>`;
    if (major) ticks += `<text class="tl" x="${(cx + (r - 31) * c).toFixed(1)}" y="${(cy - (r - 31) * s + 5).toFixed(1)}">${v}</text>`;
  }
  if (S.speedAlert && S.speedAlert <= GAUGE_MAX) {
    const a = Math.PI * (1 - S.speedAlert / GAUGE_MAX), c = Math.cos(a), s = Math.sin(a);
    ticks += `<line class="tk alert" x1="${(cx + (r + 3) * c).toFixed(1)}" y1="${(cy - (r + 3) * s).toFixed(1)}" x2="${(cx + (r - 14) * c).toFixed(1)}" y2="${(cy - (r - 14) * s).toFixed(1)}"/>`;
  }
  return `<svg class="gauge" viewBox="0 0 300 166" role="img" aria-label="Speedometer showing GPS speed">
    <path class="arc" d="M22 150 A128 128 0 0 1 278 150"/>${ticks}
    <g class="needle" id="needle" style="transform:rotate(-90deg)"><path class="nd" d="M150 160 L150 66"/></g>
    <circle class="hub" cx="150" cy="150" r="9"/>
  </svg>`;
}

function paint() {
  const sp = document.getElementById('rSpeed');
  if (!sp) return;
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

  sp.textContent = T.speed == null ? '– –' : Math.round(T.speed);
  sp.parentElement.classList.toggle('over', !!(S.speedAlert && T.speed != null && T.speed > S.speedAlert));
  const shown = Math.min(GAUGE_MAX, T.speed || 0);
  document.getElementById('needle').style.transform = `rotate(${-90 + (shown / GAUGE_MAX) * 180}deg)`;

  const elapsed = T.active ? (Date.now() - T.start) / 1000 : 0;
  set('rDist', T.active ? (T.distance / 1000).toFixed(2) : '0.00');
  set('rTime', fmtDur(T.active ? (S.autoPause ? T.movingMs / 1000 : elapsed) : 0));
  set('rAlt', T.alt == null ? '—' : num(T.alt));
  set('rHead', T.heading == null ? '—' : compass(T.heading));
  if (sensor.on && sensor.lean != null) {
    const a = Math.round(Math.abs(sensor.lean));
    set('rLean', `${a}°${a >= 2 ? (sensor.lean > 0 ? ' R' : ' L') : ''}`);
    set('rLeanSub', `max L ${Math.round(sensor.maxLeft)}° R ${Math.round(sensor.maxRight)}°`);
  } else {
    set('rLean', '—');
    set('rLeanSub', sensor.on ? 'lean, waiting' : 'lean, phone sensor');
  }
  set('rG', sensor.on && sensor.g != null ? sensor.g.toFixed(2) : '—');

  const st = document.getElementById('rStatus');
  const paused = T.active && S.autoPause && Date.now() - T.lastMoveAt > STOP_AFTER_MS;
  st.classList.toggle('paused', paused);
  if (T.gpsMsg) st.textContent = T.gpsMsg;
  else if (paused) st.textContent = `Paused while stopped. Total time ${fmtDur(elapsed)}`;
  else if (T.acc == null) st.textContent = T.active ? 'Waiting for GPS signal…' : '';
  else st.textContent = T.acc > MAX_ACCURACY_M ? `Weak GPS (±${Math.round(T.acc)} m), distance is on hold` : `GPS accurate to ±${Math.round(T.acc)} m`;
}

function gpx(r) {
  const pts = r.points
    .map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}">${p[4] != null ? `<ele>${p[4]}</ele>` : ''}<time>${new Date(p[2]).toISOString()}</time></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bike Companion" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>${esc(r.name || 'Ride ' + fmtDateTime(r.start))}</name><trkseg>
${pts}
</trkseg></trk></gpx>`;
}

/* ---------- replay ---------- */

function stopReplay() {
  clearInterval(R.timer);
  R.timer = null;
  R.i = 0;
}

function paintReplay() {
  if (!shownRide) return;
  const p = shownRide.points[R.i];
  replayMarker?.setLatLng([p[0], p[1]]);
  const slider = document.getElementById('replaySlider');
  if (slider) slider.value = R.i;
  const out = document.getElementById('replayOut');
  if (out) {
    out.innerHTML = meta([
      fmtTime(p[2]),
      p[3] != null ? `${num(p[3])} km/h` : '',
      p[4] != null ? `${num(p[4])} m altitude` : '',
    ]);
  }
  const btn = document.getElementById('replayBtn');
  if (btn) btn.lastChild.textContent = R.timer ? ' Pause' : ' Replay';
}

function toggleReplay() {
  const n = shownRide.points.length;
  if (R.timer) { clearInterval(R.timer); R.timer = null; paintReplay(); return; }
  if (R.i >= n - 1) R.i = 0;
  const step = Math.max(1, Math.round(n / 320)); // the whole ride plays in about 16 seconds
  R.timer = setInterval(() => {
    R.i = Math.min(n - 1, R.i + step);
    if (R.i >= n - 1) { clearInterval(R.timer); R.timer = null; }
    paintReplay();
  }, 50);
  paintReplay();
}

/* ---------- navigation ---------- */

async function searchPlaces(q) {
  Object.assign(N, { busy: true, error: '', results: null, resultsNote: '' });
  refresh();
  try {
    let url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
    if (T.cur) {
      // Prefer places near the rider without excluding others.
      const [la, lo] = T.cur;
      url += `&viewbox=${lo - 1.5},${la + 1.5},${lo + 1.5},${la - 1.5}`;
    }
    const found = await getJson(url, { headers: { Accept: 'application/json' } });
    N.results = found.map((r) => ({ name: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }));
  } catch {
    N.error = 'Search failed. Check your internet connection and try again.';
  }
  N.busy = false;
  refresh();
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const SHOP_TYPES = ['motorcycle', 'motorcycle_repair', 'car_repair'];

// Preferred source: an exact radius query against OpenStreetMap's Overpass servers.
async function nearbyOverpass(kind, la, lo) {
  const filter = kind === 'fuel' ? '["amenity"="fuel"]' : `["shop"~"^(${SHOP_TYPES.join('|')})$"]`;
  const query = `[out:json][timeout:15];nwr(around:25000,${la},${lo})${filter};out center 40;`;
  const fallback = kind === 'fuel' ? 'Fuel station' : 'Workshop';
  let lastError;
  for (const base of OVERPASS) {
    try {
      const j = await getJson(`${base}?data=${encodeURIComponent(query)}`, {}, 12000);
      return j.elements
        .map((e) => ({ name: e.tags?.name || e.tags?.brand || fallback, lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon }))
        .filter((p) => p.lat != null);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

// Backup source when Overpass is unreachable: the same place search used by the search box.
async function nearbyNominatim(kind, la, lo) {
  const d = 0.25; // roughly 25 km
  const box = `${lo - d},${la + d},${lo + d},${la - d}`;
  const wanted = kind === 'fuel' ? ['fuel'] : SHOP_TYPES;
  const out = [];
  for (const q of kind === 'fuel' ? ['fuel'] : ['motorcycle', 'car repair']) {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=30&bounded=1&viewbox=${box}&q=${encodeURIComponent(q)}`;
    const found = await getJson(url, { headers: { Accept: 'application/json' } });
    for (const r of found) {
      if (wanted.includes(r.type)) out.push({ name: r.name || r.display_name.split(',')[0], lat: Number(r.lat), lng: Number(r.lon) });
    }
  }
  return out;
}

// Fuel stations or workshops around the rider, from OpenStreetMap.
async function nearby(kind) {
  Object.assign(N, { busy: true, error: '', results: null, resultsNote: '' });
  refresh();
  try {
    const [la, lo] = await getPos();
    let found;
    try { found = await nearbyOverpass(kind, la, lo); } catch { found = await nearbyNominatim(kind, la, lo); }
    N.results = found
      .map((p) => ({ ...p, dist: haversine(la, lo, p.lat, p.lng) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 12);
    N.resultsNote = 'Within about 25 km, from OpenStreetMap. The list may be incomplete and distances are straight-line.';
  } catch (e) {
    N.error = e.message === 'nopos'
      ? 'Could not get your location. Allow location access and try again.'
      : 'Could not load nearby places. Check your internet connection and try again.';
  }
  N.busy = false;
  refresh();
}

const VERBS = { turn: 'Turn', 'end of road': 'Turn', fork: 'Keep', merge: 'Merge', 'on ramp': 'Take the ramp', 'off ramp': 'Take the exit' };

function stepText(s) {
  const m = s.maneuver;
  const mod = m.modifier || '';
  const onto = s.name ? ` onto ${s.name}` : '';
  switch (m.type) {
    case 'depart': return `Start${s.name ? ` on ${s.name}` : ''}`;
    case 'arrive': return 'Arrive at your destination';
    case 'roundabout':
    case 'rotary': return `At the roundabout, take exit ${m.exit || ''}${onto}`.replace('  ', ' ');
    case 'new name':
    case 'continue': return `Continue${mod && mod !== 'straight' ? ` ${mod}` : ''}${onto}`;
    default: {
      if (mod === 'uturn') return `Make a U-turn${onto}`;
      if (mod === 'straight') return `Continue straight${onto}`;
      return `${VERBS[m.type] || 'Go'} ${mod}${onto}`.replace('  ', ' ');
    }
  }
}

/** Plans a route from where the rider is to dest ({ name, lat, lng }). Used by other screens too. */
export async function routeTo(dest) {
  Object.assign(N, { dest, results: null, resultsNote: '', error: '', busy: true, picking: false });
  refresh();
  try {
    const from = await getPos();
    const url = `https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${dest.lng},${dest.lat}?overview=full&geometries=geojson&steps=true`;
    const j = await getJson(url, {}, 20000);
    if (j.code !== 'Ok' || !j.routes?.length) throw new Error('noroute');
    const rt = j.routes[0];
    N.coords = rt.geometry.coordinates.map((c) => [c[1], c[0]]);
    N.distance = rt.distance;
    N.duration = rt.duration;
    N.steps = rt.legs[0].steps.map((s) => ({ loc: [s.maneuver.location[1], s.maneuver.location[0]], text: stepText(s) }));
    N.idx = 0;
    N.warned = -1;
    follow = false; // show the whole route first
    ensureWatch();
    say(`Route ready. ${fmtDist(N.distance).replace(' km', ' kilometres').replace(' m', ' metres')}.`);
  } catch (e) {
    N.coords = null; N.steps = [];
    N.error = e.message === 'nopos'
      ? 'Could not get your location. Allow location access and try again.'
      : 'Could not find a route. Check your internet connection and try again.';
  }
  N.busy = false;
  refresh();
}

function clearRoute() {
  Object.assign(N, { dest: null, coords: null, steps: [], idx: 0, warned: -1, results: null, resultsNote: '', error: '' });
  if (!T.active) stopWatch();
  refresh();
}

// Move to a later step once the rider reaches its turn point, and speak upcoming turns.
function advanceNav() {
  if (!N.steps.length || !T.cur) return;
  const lastIdx = N.steps.length - 1;
  for (let i = lastIdx; i > N.idx; i--) {
    if (haversine(T.cur[0], T.cur[1], N.steps[i].loc[0], N.steps[i].loc[1]) <= ARRIVE_M) {
      N.idx = i;
      document.querySelectorAll('.steps li').forEach((li, k) => li.classList.toggle('now', k === Math.min(i + 1, lastIdx)));
      if (i === lastIdx) say('You have arrived');
      break;
    }
  }
  if (N.idx < lastIdx && N.warned !== N.idx) {
    const next = N.steps[N.idx + 1];
    if (haversine(T.cur[0], T.cur[1], next.loc[0], next.loc[1]) <= WARN_M) {
      N.warned = N.idx;
      say(next.text);
    }
  }
}

function paintNav() {
  const el = document.getElementById('navBanner');
  if (!el) return;
  if (!N.steps.length) { el.hidden = true; return; }
  const arrived = N.idx >= N.steps.length - 1;
  const next = N.steps[Math.min(N.idx + 1, N.steps.length - 1)];
  el.hidden = false;
  if (arrived) el.textContent = 'You have arrived';
  else if (T.cur) el.textContent = `In about ${fmtDist(haversine(T.cur[0], T.cur[1], next.loc[0], next.loc[1]))}: ${next.text}`;
  else el.textContent = `Next: ${next.text}`;
}

/* ---------- map ---------- */

function initMap(parked) {
  if (map) { dropMap(map); map = null; }
  posMarker = null; trackLine = null; replayMarker = null;
  // Until GPS has a fix, the map opens on Thimphu.
  map = makeMap('map', T.cur || [27.4728, 89.639], T.cur ? 15 : 11);
  if (!map) return;
  map.on('dragstart', () => { follow = false; });
  // Long-press anywhere, or tap after choosing "Pick on map", to set a destination.
  const pick = (e) => {
    N.picking = false;
    routeTo({ name: `Dropped pin (${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)})`, lat: r6(e.latlng.lat), lng: r6(e.latlng.lng) });
  };
  map.on('contextmenu', (e) => { if (!shownRide) pick(e); });
  map.on('click', (e) => { if (N.picking) pick(e); });

  trackLine = L.polyline(T.active ? T.points.map((p) => [p[0], p[1]]) : [], { color: '#ff6a2b', weight: 5 }).addTo(map);
  if (parked) dot([parked.lat, parked.lng], '#7c5cff', 9).addTo(map).bindTooltip('Parked here');
  if (T.cur) posMarker = dot(T.cur, '#2f8fd0').addTo(map);

  if (N.coords) {
    const line = L.polyline(N.coords, { color: '#2f8fd0', weight: 6, opacity: 0.8 }).addTo(map);
    dot([N.dest.lat, N.dest.lng], '#16a34a', 9).addTo(map);
    if (!follow && !shownRide) map.fitBounds(line.getBounds(), { padding: [24, 24] });
  }
  if (shownRide) {
    const pts = shownRide.points.map((p) => [p[0], p[1]]);
    const line = L.polyline(pts, { color: '#ff6a2b', weight: 5 }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [24, 24] });
    replayMarker = dot(pts[R.i] || pts[0], '#ff6a2b', 9).addTo(map);
  }
}

/* ---------- screen ---------- */

const shortName = (name) => name.split(',').slice(0, 2).join(',');

function rideFacts(r) {
  const fact = (label, value) => `<div class="tile"><div class="lbl">${label}</div><span class="big">${value}</span></div>`;
  const out = [
    fact('Distance, GPS', `${num(r.distanceM / 1000, 2)}<span class="unit">km</span>`),
    fact('Riding time', fmtDur(r.movingS || r.durationS)),
  ];
  if (r.movingS) out.push(fact('Average while moving', `${num((r.distanceM / r.movingS) * 3.6)}<span class="unit">km/h</span>`));
  if (r.maxSpeed != null) out.push(fact('Top GPS speed', `${num(r.maxSpeed)}<span class="unit">km/h</span>`));
  if (r.maxAlt != null) out.push(fact('Highest point', `${num(r.maxAlt)}<span class="unit">m</span>`));
  if (r.maxLeanLeft != null) out.push(fact('Max lean, phone sensor', `L ${num(r.maxLeanLeft)}° R ${num(r.maxLeanRight)}°`));
  if (r.maxG != null) out.push(fact('Peak G, phone sensor', `${num(r.maxG, 2)}<span class="unit">g</span>`));
  out.push(fact('Total time', fmtDur(r.durationS)));
  return out.join('');
}

export async function render(el) {
  const [rides, unfinished, places, parked, settings, fills] = await Promise.all([
    db.all('rides'), db.kvGet('activeRide'), db.all('places'), currentSpot(), getSettings(), db.all('fuel'),
  ]);
  S = settings;
  rides.sort((a, b) => b.start - a.start);
  const pending = !T.active && unfinished?.points?.length >= 2 ? unfinished : null;
  const fs = fuelSummary(fills);

  let fuelLine = '';
  if (N.steps.length && fs.avg) {
    const litres = N.distance / 1000 / fs.avg;
    fuelLine = `<p class="muted small">Fuel for this route: about ${num(litres, 1)} L${
      fs.lastPrice ? `, roughly ${money(Math.round(litres * fs.lastPrice))}` : ''
    }. Estimated from your own average of ${num(fs.avg, 1)} km/l.</p>`;
  }

  const navHtml = N.steps.length
    ? `<div class="t" style="font-weight:700">${esc(shortName(N.dest.name))}</div>
       ${meta([fmtDist(N.distance), `about ${Math.round(N.duration / 60)} min by road, car-based estimate`])}
       ${fuelLine}
       <div class="chips">
         <button class="btn sm" data-act="reroute">Re-route from here</button>
         <button class="btn sm" data-act="savePlace">Save place</button>
         <a class="btn sm" target="_blank" rel="noopener" href="https://maps.apple.com/?daddr=${N.dest.lat},${N.dest.lng}&dirflg=d">Apple Maps</a>
         <a class="btn sm" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${N.dest.lat},${N.dest.lng}">Google Maps</a>
         <button class="btn sm danger" data-act="clearRoute">End navigation</button>
       </div>
       <ol class="steps">${N.steps.map((s, i) => `<li class="${i === Math.min(N.idx + 1, N.steps.length - 1) ? 'now' : ''}">${esc(s.text)}</li>`).join('')}</ol>`
    : `<form class="search" id="searchForm">
         <input type="search" name="q" placeholder="Search a place or address" autocomplete="off" enterkeyhint="search" aria-label="Search a place or address">
         <button class="btn primary" type="submit">Search</button>
       </form>
       <div class="chips">
         <button class="btn sm" data-act="nearFuel">${icon('drop', 16)} Fuel nearby</button>
         <button class="btn sm" data-act="nearShop">${icon('wrench', 16)} Workshops</button>
         <a class="btn sm" href="#parking">${icon('parking', 16)} ${parked ? 'Find my bike' : 'Parking'}</a>
       </div>
       <p class="muted small" style="margin-top:8px">${N.picking ? 'Now tap the map where you want to go.' : 'You can also press and hold the map to route to that point.'}</p>
       ${N.busy ? '<p class="muted small">Working…</p>' : ''}
       ${N.error ? `<p class="err" style="margin-top:8px">${esc(N.error)}</p>` : ''}
       ${
         N.results
           ? N.results.length
             ? `<ul class="list" style="margin-top:8px">${N.results
                 .map(
                   (r, i) => `<li class="row" data-act="pick" data-i="${i}"><div class="t grow">${esc(r.name)}</div>${
                     r.dist != null ? `<span class="chip">${fmtDist(r.dist)}</span>` : ''
                   }</li>`
                 )
                 .join('')}</ul>${N.resultsNote ? `<p class="muted small">${esc(N.resultsNote)}</p>` : ''}`
             : '<p class="muted small">Nothing found. Try a different spelling or a nearby town.</p>'
           : ''
       }
       ${
         places.length
           ? `<h2 style="margin-top:16px">Saved places</h2>
              <ul class="list">${places
                .map(
                  (p) => `<li class="row"><div class="t grow" data-act="goPlace" data-id="${p.id}">${esc(p.name)}</div>
                    <button class="btn sm" data-act="editPlace" data-id="${p.id}">Edit</button></li>`
                )
                .join('')}</ul>`
           : ''
       }`;

  const clusterHtml = `
    <section class="cluster" aria-label="Instruments">
      <div class="gauge-wrap">
        ${gaugeSvg()}
        <div class="readout"><b id="rSpeed">– –</b><span>km/h by GPS${S.speedAlert ? `, alert at ${num(S.speedAlert)}` : ''}</span></div>
      </div>
      <div class="dials">
        <div><b id="rDist">0.00</b><span>km</span></div>
        <div><b id="rTime">0:00:00</b><span>${S.autoPause ? 'riding time' : 'time'}</span></div>
        <div><b id="rAlt">—</b><span>altitude, m</span></div>
        <div><b id="rLean">—</b><span id="rLeanSub">lean, phone sensor</span></div>
        <div><b id="rG">—</b><span>G-force, phone</span></div>
        <div><b id="rHead">—</b><span>heading</span></div>
      </div>
      <p class="status" id="rStatus"></p>
    </section>
    <button class="btn huge block mb ${T.active ? '' : 'primary'}" data-act="toggle">${T.active ? 'Stop and save ride' : 'Start ride'}</button>
    ${
      T.active
        ? `<p class="muted small mb">${isNative
            ? 'GPS keeps recording with the screen locked (the status bar turns blue). Lean and G-force pause while the screen is off.'
            : 'Keep this screen open while riding: iPhone pauses GPS for web apps when the screen locks.'} Lean and G-force are only meaningful with the phone fixed in a mount. ${
            S.sensors ? '<button class="btn sm" data-act="zero" style="margin-top:6px">Set lean to zero (bike upright)</button>' : ''
          }</p>`
        : ''
    }`;

  const savedHtml = shownRide
    ? `<div class="card">
        <div class="row head"><h2>${esc(shownRide.name || fmtDateTime(shownRide.start))}</h2><button class="btn sm" data-act="closeRide">Close</button></div>
        ${shownRide.name ? `<p class="muted small">${esc(fmtDateTime(shownRide.start))}</p>` : ''}
        <div class="row" style="margin:6px 0 2px">
          <button class="btn sm primary" data-act="replay" id="replayBtn">${icon('play', 16)}<span> Replay</span></button>
          <div class="grow" id="replayOut"></div>
        </div>
        <input type="range" id="replaySlider" min="0" max="${shownRide.points.length - 1}" value="${R.i}" aria-label="Position in the ride">
        ${sparkline(shownRide.points.map((p) => p[3]))}
        ${sparkline(shownRide.points.map((p) => p[4]), 'var(--info)')}
        <p class="muted small">${[
          shownRide.points.some((p) => p[3] != null) ? 'Orange line: GPS speed.' : '',
          shownRide.points.some((p) => p[4] != null) ? 'Blue line: altitude.' : '',
        ].join(' ')}</p>
        ${shownRide.notes ? `<p class="pre">${esc(shownRide.notes)}</p>` : ''}
        <div class="chips">
          <button class="btn sm" data-act="renameRide">Name and notes</button>
          <button class="btn sm" data-act="gpx">${icon('share', 16)} Export GPX</button>
          <button class="btn sm danger" data-act="deleteRide">Delete</button>
        </div>
      </div>
      <div class="tiles">${rideFacts(shownRide)}</div>`
    : '';

  const mapHtml = `
    <div class="map-wrap">
      <div id="map"></div>
      <div class="map-btns">
        <button class="btn sm" data-act="locate">${icon('target', 16)} Me</button>
        ${shownRide ? '' : `<button class="btn sm ${N.picking ? 'on' : ''}" data-act="pickMode">${icon('pin', 16)} Pick</button>`}
      </div>
    </div>`;

  // While navigating or looking at a saved ride the map leads; otherwise the instruments do.
  const mapFirst = N.steps.length || shownRide;

  el.innerHTML = `
    <div id="navBanner" class="nav-banner" hidden></div>
    ${
      pending
        ? `<div class="notice">
            A ride from ${esc(fmtDateTime(pending.start))} stopped before it was saved (${num(pending.distance / 1000, 2)} km recorded).
            <div class="actions" style="margin-top:8px">
              <button class="btn sm" data-act="savePending">Save it</button>
              <button class="btn sm danger" data-act="dropPending">Discard</button>
            </div>
          </div>`
        : ''
    }
    ${shownRide ? mapHtml + savedHtml : mapFirst ? mapHtml + clusterHtml : clusterHtml + mapHtml}

    <div class="card">
      <h2>${N.steps.length ? 'Navigating to' : 'Where to?'}</h2>
      ${navHtml}
    </div>

    <div class="card">
      <h2>Past rides</h2>
      ${
        rides.length
          ? `<ul class="list">${rides
              .map(
                (r) => `<li class="row" data-act="showRide" data-id="${r.id}">
                  <div class="grow"><div class="t">${esc(r.name || fmtDateTime(r.start))}</div>
                  ${meta([r.name ? esc(fmtDateTime(r.start)) : '', fmtDur(r.movingS || r.durationS), r.maxSpeed != null ? `top ${num(r.maxSpeed)} km/h` : ''])}</div>
                  <div class="v">${num(r.distanceM / 1000, 1)} km</div>
                </li>`
              )
              .join('')}</ul>`
          : '<p class="empty">Your rides will appear here. Tap Start ride before you set off.</p>'
      }
    </div>
  `;

  initMap(parked);
  paint();
  paintNav();
  paintReplay();

  el.onsubmit = (e) => {
    if (e.target.id !== 'searchForm') return;
    e.preventDefault();
    const q = e.target.elements.q.value.trim();
    if (q) searchPlaces(q);
  };

  el.oninput = (e) => {
    if (e.target.id !== 'replaySlider') return;
    R.i = Number(e.target.value);
    paintReplay();
  };

  el.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const id = Number(t.dataset.id);
    switch (t.dataset.act) {
      case 'toggle':
        if (T.active) stopRide(); else startRide();
        break;
      case 'zero': recalibrate(); toast('Lean set to zero.'); break;
      case 'locate':
        follow = true;
        ensureWatch();
        if (T.cur && map) map.setView(T.cur, 16);
        else toast('Finding your location…');
        break;
      case 'pickMode': N.picking = !N.picking; refresh(); break;
      case 'pick': routeTo(N.results[Number(t.dataset.i)]); break;
      case 'nearFuel': nearby('fuel'); break;
      case 'nearShop': nearby('shop'); break;
      case 'reroute': routeTo(N.dest); break;
      case 'clearRoute': clearRoute(); break;
      case 'savePlace':
        openForm({
          title: 'Save place',
          fields: [{ name: 'name', label: 'Name', type: 'text', required: true }],
          values: { name: shortName(N.dest.name) },
          onSave: (v) => db.put('places', { name: v.name, lat: N.dest.lat, lng: N.dest.lng }),
        });
        break;
      case 'goPlace': routeTo(places.find((p) => p.id === id)); break;
      case 'editPlace': {
        const place = places.find((p) => p.id === id);
        openForm({
          title: 'Saved place',
          fields: [{ name: 'name', label: 'Name', type: 'text', required: true }],
          values: place,
          onSave: (v) => db.put('places', { ...place, ...v }),
          onDelete: () => db.del('places', place.id),
        });
        break;
      }
      case 'showRide':
        if (T.active) { toast('Stop the current ride to look at a saved one.'); break; }
        stopReplay();
        shownRide = rides.find((r) => r.id === id);
        refresh();
        document.getElementById('view').scrollTop = 0;
        break;
      case 'closeRide': stopReplay(); shownRide = null; refresh(); break;
      case 'replay': toggleReplay(); break;
      case 'renameRide':
        openForm({
          title: 'Ride details',
          fields: [
            { name: 'name', label: 'Name', type: 'text', placeholder: 'e.g. Thimphu to Paro' },
            { name: 'notes', label: 'Notes', type: 'textarea' },
          ],
          values: shownRide,
          onSave: async (v) => { shownRide = { ...shownRide, ...v }; await db.put('rides', shownRide); },
        });
        break;
      case 'gpx':
        shareFile(`ride-${fileSafe(shownRide.name || new Date(shownRide.start).toISOString().slice(0, 10))}.gpx`, gpx(shownRide), 'application/gpx+xml');
        break;
      case 'deleteRide':
        if (confirm('Delete this ride? This cannot be undone.')) {
          await db.del('rides', shownRide.id);
          stopReplay();
          shownRide = null;
          refresh();
        }
        break;
      case 'savePending':
        await db.put('rides', buildRide(pending, pending.points[pending.points.length - 1][2] || Date.now()));
        await db.kvDel('activeRide');
        toast('Ride saved');
        refresh();
        break;
      case 'dropPending':
        if (confirm('Discard the interrupted ride?')) { await db.kvDel('activeRide'); refresh(); }
        break;
    }
  };
}

export function leave() {
  stopReplay();
  shownRide = null;
  N.picking = false;
  if (map) { dropMap(map); map = null; posMarker = null; trackLine = null; replayMarker = null; }
  if (!T.active && !N.steps.length) stopWatch();
}

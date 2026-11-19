// Automatic, read-only capture of everything the bike's Bluetooth unit ("HONDA BTU ...") offers,
// logged side by side with what the phone itself measures (GPS and motion sensors), so it is
// clear which data comes from the bike and what changes when.
//
// While the iPhone app is open (and with the screen locked once GPS is running) it:
//   finds the bike and connects on its own; records its advertising data; reads every value and
//   every descriptor; listens to every notify channel; re-reads values every 2 s (logging only
//   changes); logs signal strength, full GPS and motion; reconnects when the bike comes back;
//   builds a summary of what each bike channel sent; uploads the log to the owner's sync gist.
// It never writes to the bike (only the standard switch that turns notifications on).
import { db } from './db.js';
import { isNative, watchPosition, clearWatch } from './geo.js';
import { getSync } from './sync.js';

export const HONDA_SERVICE = '4d87b1ea-528b-4798-b002-e2e1442a2e86';
const LOG_KEY = 'bleLog';
const STATS_KEY = 'bleStats';
const SKIP_KEY = 'bleSkip'; // reads that needed pairing; not retried automatically (avoids repeated iOS prompts)
const AUTO_KEY = 'bleAuto';
const LOG_FILE = 'bike-bluetooth-log.txt';
const MAX_LOG = 30000;
const cap = window.Capacitor;
export const BLE = isNative && typeof cap.registerPlugin === 'function' ? cap.registerPlugin('BluetoothLe') : null;

const KNOWN = {
  '1800': 'Generic Access', '1801': 'Generic Attribute', '180a': 'Device Information', '180f': 'Battery Service',
  '2a00': 'Device Name', '2a01': 'Appearance', '2a04': 'Connection Parameters', '2a05': 'Service Changed',
  '2a29': 'Manufacturer', '2a24': 'Model Number', '2a25': 'Serial Number', '2a27': 'Hardware Revision',
  '2a26': 'Firmware Revision', '2a28': 'Software Revision', '2a23': 'System ID', '2a50': 'PnP ID', '2a19': 'Battery Level',
  '2900': 'Extended Properties', '2901': 'User Description', '2902': 'Notify Switch (CCCD)', '2904': 'Presentation Format',
};
export const short = (u) => (u.endsWith('-0000-1000-8000-00805f9b34fb') && u.startsWith('0000') ? u.slice(4, 8) : u);
export const label = (u) => KNOWN[short(u)] || short(u).slice(0, 8).toUpperCase();
export const hexSp = (h) => (h || '').replace(/(..)/g, '$1 ').trim();
export const ascii = (h) => (h || '').replace(/(..)/g, (b) => { const c = parseInt(b, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : '.'; });
const errText = (e) => String(e?.message || e || 'unknown error');
const stamp = () => { const d = new Date(); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
const f = (n, d = 1) => (n == null || Number.isNaN(n) ? '?' : Number(n).toFixed(d));

/** Shared state, read by the Bike Bluetooth screen. */
export const S = {
  auto: true,
  phase: 'off', // off | searching | connecting | connected
  dev: null, // { deviceId, name }
  chars: [], // { svc, uuid, props, value, count, err, desc: {uuid: text} }
  log: [],
  stats: {}, // per characteristic uuid, kept across sessions (see note())
  gps: null, // last { lat, lon, alt, kmh, heading, acc }
  motion: false, // motion sensors reporting
  rssi: null,
  lastUpload: null, // { at, ok, msg }
  gistId: null,
};

let started = false;
let scanListener = null;
let connListeners = [];
let pollTimer = null;
let rssiTimer = null;
let idleTimer = null;
let gpsWatch = null;
let lastGpsLog = 0;
let uploadedLen = -1;
let skip = new Set();
let busyConnect = false;
let searchTimer = null;

/** Schedules the next search. Only one is ever pending, so retries cannot pile up. */
function scheduleSearch(ms) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { searchTimer = null; startSearch(); }, ms);
}

const changed = () => window.dispatchEvent(new Event('ble:changed'));

let saveTimer;
export function log(line) {
  S.log.push(`${new Date().toISOString().slice(0, 10)} ${stamp()} ${line}`);
  if (S.log.length > MAX_LOG) S.log.splice(0, S.log.length - MAX_LOG);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    db.kvSet(LOG_KEY, S.log).catch(() => {});
    db.kvSet(STATS_KEY, S.stats).catch(() => {});
  }, 1000);
  changed();
}

export function clearLog() {
  S.log = [];
  S.stats = {};
  uploadedLen = -1;
  db.kvSet(LOG_KEY, []).catch(() => {});
  db.kvSet(STATS_KEY, {}).catch(() => {});
  changed();
}

/* ---------- summary: what each bike channel has sent ---------- */

/** Records a value seen on a characteristic (kind: read | notify). */
function note(c, kind, hex) {
  const st = (S.stats[c.uuid] ||= {
    name: label(c.uuid), svc: c.svc, props: Object.keys(c.props).filter((k) => c.props[k]),
    reads: 0, notifies: 0, distinct: [], lengths: [], changingBytes: [], first: Date.now(), last: null, lastValue: null,
  });
  st[kind === 'read' ? 'reads' : 'notifies']++;
  st.last = Date.now();
  if (st.lastValue != null && st.lastValue !== hex) {
    const a = st.lastValue.match(/../g) || [], b = hex.match(/../g) || [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i] && !st.changingBytes.includes(i)) st.changingBytes.push(i);
    st.changingBytes.sort((x, y) => x - y);
  }
  st.lastValue = hex;
  if (st.distinct.length < 40 && !st.distinct.includes(hex)) st.distinct.push(hex);
  const len = hex.length / 2;
  if (!st.lengths.includes(len)) st.lengths.push(len);
}

export function summaryText() {
  const rows = Object.entries(S.stats);
  if (!rows.length) return 'Nothing received from the bike yet.';
  return rows.map(([uuid, st]) => [
    `${st.name}  (${uuid})  [${st.props.join(', ')}]`,
    `   reads ${st.reads}, live updates ${st.notifies}, distinct values ${st.distinct.length}${st.distinct.length >= 40 ? '+' : ''}, lengths ${st.lengths.join('/')} bytes`,
    `   ${st.changingBytes.length ? 'bytes that change: ' + st.changingBytes.join(', ') : 'never changed'}`,
    `   last: ${hexSp(st.lastValue) || '(empty)'}  |${ascii(st.lastValue)}|`,
  ].join('\n')).join('\n');
}

export function logText() {
  return [
    'Connect Bike - Bike Bluetooth log (automatic capture)',
    `Saved ${new Date().toString()}`,
    S.dev ? `Device ${S.dev.name} (${S.dev.deviceId})` : '',
    'Lines: BIKE = from the motorcycle. PHONE GPS / PHONE MOTION = measured by the iPhone itself.',
    '',
    '===== SUMMARY: what the bike has sent =====',
    summaryText(),
    '',
    '===== FULL LOG =====',
  ].join('\n') + '\n' + S.log.join('\n') + '\n';
}

/* ---------- finding the bike ---------- */

async function startSearch() {
  if (!S.auto || busyConnect || S.phase === 'connected' || S.phase === 'connecting') return;
  clearTimeout(searchTimer);
  searchTimer = null;
  S.phase = 'searching';
  changed();
  try {
    if (!scanListener) {
      scanListener = await BLE.addListener('onScanResult', (r) => {
        const id = r.device?.deviceId;
        if (!id || S.phase !== 'searching') return;
        log(`BIKE ADVERT ${r.localName || r.device.name || id}: signal ${r.rssi} dBm, tx power ${r.txPower ?? '?'}, ` +
          `services ${(r.uuids || []).join(' ') || 'none'}, manufacturer data ${JSON.stringify(r.manufacturerData || {})}, ` +
          `service data ${JSON.stringify(r.serviceData || {})}`);
        connect(id, r.localName || r.device.name);
      });
    }
    // The plugin answers a second scan request by stopping the scan altogether ("Already
    // scanning"), so always stop any earlier scan first.
    await BLE.stopLEScan().catch(() => {});
    // Filtering on Honda's service lets iOS keep scanning even in the background.
    await BLE.requestLEScan({ services: [HONDA_SERVICE], allowDuplicates: false });
  } catch (e) {
    log('Search failed: ' + errText(e) + ' (is Bluetooth on and allowed for Connect Bike?)');
  }
  // If iOS already has the bike connected (e.g. through Honda's app) it is not advertising,
  // so also check for that now and then.
  clearInterval(idleTimer);
  idleTimer = setInterval(checkAlreadyConnected, 15000);
  checkAlreadyConnected();
}

async function checkAlreadyConnected() {
  if (S.phase !== 'searching') return;
  try {
    const { devices } = await BLE.getConnectedDevices({ services: [HONDA_SERVICE] });
    if (devices?.length) {
      log(`Bike already connected to the iPhone (probably by Honda's app): ${devices[0].name || devices[0].deviceId}`);
      connect(devices[0].deviceId, devices[0].name);
    }
  } catch { /* try again later */ }
}

async function stopSearch() {
  clearInterval(idleTimer);
  idleTimer = null;
  await BLE.stopLEScan().catch(() => {});
}

/* ---------- connected session ---------- */

async function connect(deviceId, name) {
  if (busyConnect || S.phase === 'connected') return;
  busyConnect = true;
  await stopSearch();
  S.dev = { deviceId, name: name || 'HONDA BTU' };
  S.phase = 'connecting';
  S.chars = [];
  log(`===== Connecting to ${S.dev.name} =====`);
  try {
    connListeners.push(await BLE.addListener(`disconnected|${deviceId}`, onDisconnected));
    await BLE.connect({ deviceId, timeout: 12000 });
    S.phase = 'connected';
    log('Connected.');
    try { log(`BIKE MTU ${(await BLE.getMtu({ deviceId })).value}`); } catch { /* not important */ }

    const { services } = await BLE.getServices({ deviceId });
    for (const s of services) {
      log(`SERVICE ${s.uuid} (${label(s.uuid)})`);
      for (const c of s.characteristics) {
        const props = Object.entries(c.properties).filter(([, v]) => v).map(([k]) => k);
        log(`  CHAR ${c.uuid} (${label(c.uuid)}) [${props.join(', ')}]${c.descriptors?.length ? ' descriptors: ' + c.descriptors.map((d) => label(d.uuid)).join(', ') : ''}`);
        S.chars.push({ svc: s.uuid, uuid: c.uuid, props: c.properties, descriptors: c.descriptors || [], value: null, count: 0, err: null, desc: {} });
      }
    }
    // Listen first: the bike sends a burst of messages as soon as listening starts, and
    // reading everything beforehand would delay that.
    await subscribeAll();
    await readDescriptors();
    if (skip.size) log(`Not reading ${skip.size} locked value(s) found earlier, to avoid pairing prompts.`);
    await readAll('first read');
    log('Capturing everything. Values re-read every 2 s (only changes logged), signal every 5 s, GPS and motion every 2 s.');
    pollTimer = setInterval(() => readAll('auto'), 2000);
    rssiTimer = setInterval(readRssi, 5000);
    startGps();
    startMotion();
  } catch (e) {
    log('Connect failed: ' + errText(e) + '. Will try again.');
    await BLE.disconnect({ deviceId }).catch(() => {});
    await endSession();
    scheduleSearch(3000);
  } finally {
    busyConnect = false;
    changed();
  }
}

async function onDisconnected() {
  // iOS sometimes reports a disconnect while a connection is still being set up (seen when
  // Honda's app already holds the bike). Ending the session then broke the attempt in progress
  // and started a second search next to it; the attempt now finishes or times out on its own.
  if (S.phase !== 'connected') {
    log('(disconnect message while still connecting: ignored, the connection attempt carries on)');
    return;
  }
  log('===== Bike disconnected (ignition off or out of range). Waiting for it to come back. =====');
  await endSession();
  upload();
  scheduleSearch(3000);
}

async function endSession() {
  clearInterval(pollTimer);
  clearInterval(rssiTimer);
  pollTimer = rssiTimer = null;
  stopGps();
  stopMotion();
  const ls = connListeners.splice(0);
  await Promise.all(ls.map((h) => h.remove?.().catch(() => {})));
  S.phase = 'off';
  S.rssi = null;
  changed();
}

/** Descriptor labels (e.g. a "User Description" naming the value). iOS manages the notify switch itself. */
async function readDescriptors() {
  for (const c of S.chars) {
    for (const d of c.descriptors) {
      if (short(d.uuid) === '2902') continue;
      try {
        const { value } = await BLE.readDescriptor({ deviceId: S.dev.deviceId, service: c.svc, characteristic: c.uuid, descriptor: d.uuid, timeout: 4000 });
        c.desc[d.uuid] = value;
        log(`BIKE DESCRIPTOR ${label(c.uuid)} / ${label(d.uuid)} = ${hexSp(value) || '(empty)'}  |${ascii(value)}|`);
      } catch (e) {
        log(`BIKE DESCRIPTOR ${label(c.uuid)} / ${label(d.uuid)} failed: ${errText(e)}`);
      }
    }
  }
}

async function readRssi() {
  if (S.phase !== 'connected') return;
  try {
    const { value } = await BLE.readRssi({ deviceId: S.dev.deviceId });
    S.rssi = value;
    log(`BIKE SIGNAL ${value} dBm`);
  } catch { /* not important */ }
}

let reading = false;
/** Reads every readable value. includeLocked retries ones that needed pairing (may show an iOS prompt). */
export async function readAll(why, includeLocked = false) {
  if (S.phase !== 'connected' || reading) return;
  reading = true;
  if (why !== 'auto') log(`--- reading all values (${why}) ---`);
  try {
    for (const c of S.chars.filter((x) => x.props.read)) {
      if (S.phase !== 'connected') break;
      if (!includeLocked && skip.has(c.uuid)) continue;
      try {
        const { value } = await BLE.read({ deviceId: S.dev.deviceId, service: c.svc, characteristic: c.uuid, timeout: 5000 });
        const diff = c.value !== null && c.value !== value;
        c.value = value; c.err = null;
        note(c, 'read', value);
        if (skip.delete(c.uuid)) db.kvSet(SKIP_KEY, [...skip]).catch(() => {});
        if (why !== 'auto' || diff) log(`BIKE READ ${label(c.uuid)} = ${hexSp(value) || '(empty)'}  |${ascii(value)}|${diff ? '  CHANGED' : ''}`);
      } catch (e) {
        const msg = errText(e);
        if (c.err !== msg || why !== 'auto') log(`BIKE READ ${label(c.uuid)} failed: ${msg}`);
        c.err = msg;
        if (/auth|encrypt|pair|permit/i.test(msg) && !skip.has(c.uuid)) {
          skip.add(c.uuid);
          db.kvSet(SKIP_KEY, [...skip]).catch(() => {});
          log(`  (${label(c.uuid)} is locked; it will not be re-read automatically)`);
        }
      }
    }
  } finally {
    reading = false;
    changed();
  }
}
export const lockedCount = () => skip.size;

async function subscribeAll() {
  const { deviceId } = S.dev;
  for (const c of S.chars.filter((x) => x.props.notify || x.props.indicate)) {
    const handler = (r) => {
      c.value = r?.value ?? '';
      c.count++;
      note(c, 'notify', c.value);
      log(`BIKE NOTIFY ${label(c.uuid)} = ${hexSp(c.value) || '(empty)'}  |${ascii(c.value)}|`);
    };
    // iOS names the event with its own spelling of the ids (short form for standard ones).
    for (const k of new Set([`${c.svc}|${c.uuid}`, `${short(c.svc)}|${short(c.uuid)}`])) {
      connListeners.push(await BLE.addListener(`notification|${deviceId}|${k}`, handler));
    }
    try {
      await BLE.startNotifications({ deviceId, service: c.svc, characteristic: c.uuid, timeout: 5000 });
      log(`Listening to ${label(c.uuid)}`);
    } catch (e) {
      c.err = errText(e);
      log(`Listen to ${label(c.uuid)} failed: ${c.err}`);
    }
  }
}

/* ---------- phone GPS (also keeps the app running when the screen is locked) ---------- */

function startGps() {
  stopGps();
  gpsWatch = watchPosition(
    (p) => {
      const c = p.coords;
      const kmh = c.speed != null && c.speed >= 0 ? c.speed * 3.6 : null;
      S.gps = { lat: c.latitude, lon: c.longitude, alt: c.altitude, kmh, heading: c.heading, acc: c.accuracy };
      const now = Date.now();
      if (now - lastGpsLog >= 2000) {
        lastGpsLog = now;
        log(`PHONE GPS lat ${f(c.latitude, 6)} lon ${f(c.longitude, 6)} alt ${f(c.altitude, 0)} m, speed ${f(kmh)} km/h, heading ${f(c.heading, 0)}°, accuracy ${f(c.accuracy, 0)} m`);
      }
    },
    (e) => log(`PHONE GPS unavailable (code ${e.code}). Capture continues without it.`)
  );
}
function stopGps() {
  if (gpsWatch != null) clearWatch(gpsWatch);
  gpsWatch = null;
}

/* ---------- phone motion sensors ---------- */
// iPhone only allows these after a tap in the app, so permission is asked on the first tap
// anywhere; after that they are logged automatically (averages and peaks every 2 s).

let mo = null;
let motionTimer = null;
const resetMo = () => ({ n: 0, ax: 0, ay: 0, az: 0, peakG: 0, rot: 0, beta: null, gamma: null, alpha: null });

function onMotion(e) {
  const a = e.accelerationIncludingGravity, la = e.acceleration, r = e.rotationRate;
  if (!a || a.x == null) return;
  S.motion = true;
  mo.n++; mo.ax += a.x; mo.ay += a.y; mo.az += a.z;
  if (la && la.x != null) mo.peakG = Math.max(mo.peakG, Math.hypot(la.x, la.y, la.z) / 9.81);
  if (r && r.alpha != null) mo.rot = Math.max(mo.rot, Math.hypot(r.alpha, r.beta, r.gamma));
}
function onOrient(e) {
  if (e.beta == null) return;
  mo.beta = e.beta; mo.gamma = e.gamma; mo.alpha = e.alpha;
}
function flushMotion() {
  if (!mo || !mo.n) return;
  const n = mo.n;
  log(`PHONE MOTION tilt fwd ${f(mo.beta, 0)}° side ${f(mo.gamma, 0)}° compass ${f(mo.alpha, 0)}°, ` +
    `gravity x ${f(mo.ax / n, 2)} y ${f(mo.ay / n, 2)} z ${f(mo.az / n, 2)} m/s², peak ${f(mo.peakG, 2)} g, peak turn ${f(mo.rot, 0)}°/s`);
  mo = resetMo();
}
function startMotion() {
  mo = resetMo();
  window.addEventListener('devicemotion', onMotion);
  window.addEventListener('deviceorientation', onOrient);
  clearInterval(motionTimer);
  motionTimer = setInterval(flushMotion, 2000);
}
function stopMotion() {
  window.removeEventListener('devicemotion', onMotion);
  window.removeEventListener('deviceorientation', onOrient);
  clearInterval(motionTimer);
  motionTimer = null;
}
let motionOk = false;
/** Asks for motion-sensor access; must run inside a tap. */
export function askMotion() {
  const asks = [window.DeviceMotionEvent, window.DeviceOrientationEvent]
    .filter((E) => E && typeof E.requestPermission === 'function')
    .map((E) => E.requestPermission().catch((e) => 'error: ' + errText(e)));
  return Promise.all(asks).then((r) => {
    const ok = r.every((x) => x === 'granted');
    if (ok !== motionOk || !ok) log(`Motion sensors ${ok ? 'allowed' : 'not allowed (' + r.join(', ') + '); will ask again on the next tap'}.`);
    motionOk = ok;
    changed();
    return ok;
  });
}
/** The app grants motion access itself, but iOS only lets the page ask during a real tap
 *  (a scroll does not count), so keep asking on taps until it is granted. */
function askMotionOnTaps() {
  if (!window.DeviceMotionEvent?.requestPermission) { motionOk = true; return; }
  let lastAsk = 0;
  const onTap = () => {
    if (motionOk) { document.removeEventListener('click', onTap, true); return; }
    if (Date.now() - lastAsk < 5000) return;
    lastAsk = Date.now();
    askMotion();
  };
  document.addEventListener('click', onTap, true);
}
export const motionAllowed = () => motionOk;

/* ---------- upload to the sync gist ---------- */

export async function upload(force = false) {
  if (!force && S.log.length === uploadedLen) return;
  const s = await getSync().catch(() => ({}));
  if (!s.token || !s.gistId) {
    S.lastUpload = { at: Date.now(), ok: false, msg: 'Cloud sync is not set up (More → Backup and sync).' };
    changed();
    return;
  }
  S.gistId = s.gistId;
  const len = S.log.length;
  try {
    const res = await fetch(`https://api.github.com/gists/${s.gistId}`, {
      method: 'PATCH',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { [LOG_FILE]: { content: logText() } } }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error('GitHub answered ' + res.status);
    uploadedLen = len;
    S.lastUpload = { at: Date.now(), ok: true, msg: 'Uploaded' };
  } catch (e) {
    S.lastUpload = { at: Date.now(), ok: false, msg: errText(e) };
  }
  changed();
}

/* ---------- on / off ---------- */

export async function setAuto(on) {
  S.auto = on;
  await db.kvSet(AUTO_KEY, on);
  if (on) { log('Automatic capture switched ON.'); if (await init()) scheduleSearch(0); }
  else {
    log('Automatic capture switched OFF.');
    clearTimeout(searchTimer);
    await stopSearch();
    if (S.dev && S.phase !== 'off') await BLE.disconnect({ deviceId: S.dev.deviceId }).catch(() => {});
    await endSession();
  }
}

/** Starts automatic capture when the iPhone app opens. Safe to call more than once. */
export async function startBikeCapture() {
  if (!BLE || started) return;
  started = true;
  S.log = (await db.kvGet(LOG_KEY, [])) || [];
  S.stats = (await db.kvGet(STATS_KEY, {})) || {};
  skip = new Set((await db.kvGet(SKIP_KEY, [])) || []);
  S.auto = await db.kvGet(AUTO_KEY, true);
  S.gistId = (await getSync().catch(() => ({}))).gistId || null;
  setInterval(() => upload(), 120000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') upload(); });
  askMotionOnTaps();
  if (!S.auto) return;
  if (!(await init())) return;
  log('App opened: looking for the bike.');
  scheduleSearch(500);
}

let ready = false;
async function init() {
  if (ready) return true;
  try {
    await BLE.initialize({});
    ready = true;
  } catch (e) {
    log('Bluetooth not available: ' + errText(e) + ' (switch Bluetooth on and allow it for Connect Bike in Settings)');
  }
  return ready;
}

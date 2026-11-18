// Automatic, read-only capture from the bike's Bluetooth unit ("HONDA BTU ...").
// While the iPhone app is open (or kept alive in the background by GPS during a capture) it:
//   finds the bike and connects on its own, reads every readable value, listens to every
//   notify channel, re-reads every 2 s logging only changes, logs GPS speed alongside so the
//   data can be matched to riding, reconnects when the bike comes back, and uploads the log
//   to the owner's sync gist. It never writes to the bike (only the standard switch that
//   turns notifications on).
import { db } from './db.js';
import { isNative, watchPosition, clearWatch } from './geo.js';
import { getSync } from './sync.js';

export const HONDA_SERVICE = '4d87b1ea-528b-4798-b002-e2e1442a2e86';
const LOG_KEY = 'bleLog';
const SKIP_KEY = 'bleSkip'; // reads that needed pairing; not retried automatically (avoids repeated iOS prompts)
const AUTO_KEY = 'bleAuto';
const LOG_FILE = 'bike-bluetooth-log.txt';
const MAX_LOG = 20000;
const cap = window.Capacitor;
export const BLE = isNative && typeof cap.registerPlugin === 'function' ? cap.registerPlugin('BluetoothLe') : null;

const KNOWN = {
  '1800': 'Generic Access', '1801': 'Generic Attribute', '180a': 'Device Information', '180f': 'Battery Service',
  '2a00': 'Device Name', '2a01': 'Appearance', '2a04': 'Connection Parameters', '2a05': 'Service Changed',
  '2a29': 'Manufacturer', '2a24': 'Model Number', '2a25': 'Serial Number', '2a27': 'Hardware Revision',
  '2a26': 'Firmware Revision', '2a28': 'Software Revision', '2a23': 'System ID', '2a50': 'PnP ID', '2a19': 'Battery Level',
};
export const short = (u) => (u.endsWith('-0000-1000-8000-00805f9b34fb') && u.startsWith('0000') ? u.slice(4, 8) : u);
export const label = (u) => KNOWN[short(u)] || short(u).slice(0, 8).toUpperCase();
export const hexSp = (h) => (h || '').replace(/(..)/g, '$1 ').trim();
export const ascii = (h) => (h || '').replace(/(..)/g, (b) => { const c = parseInt(b, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : '.'; });
const errText = (e) => String(e?.message || e || 'unknown error');
const stamp = () => { const d = new Date(); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shared state, read by the Bike Bluetooth screen. */
export const S = {
  auto: true,
  phase: 'off', // off | searching | connecting | connected
  dev: null, // { deviceId, name }
  chars: [], // { svc, uuid, props, value, count, err }
  log: [],
  speed: null,
  lastUpload: null, // { at, ok, msg }
  gistId: null,
};

let started = false;
let scanListener = null;
let connListeners = [];
let pollTimer = null;
let idleTimer = null;
let gpsWatch = null;
let lastGpsLog = 0;
let uploadedLen = -1;
let skip = new Set();
let busyConnect = false;

const changed = () => window.dispatchEvent(new Event('ble:changed'));

let saveTimer;
export function log(line) {
  S.log.push(`${new Date().toISOString().slice(0, 10)} ${stamp()} ${line}`);
  if (S.log.length > MAX_LOG) S.log.splice(0, S.log.length - MAX_LOG);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.kvSet(LOG_KEY, S.log).catch(() => {}), 1000);
  changed();
}

export function clearLog() {
  S.log = [];
  uploadedLen = -1;
  db.kvSet(LOG_KEY, []).catch(() => {});
  changed();
}

export function logText() {
  return [
    'Connect Bike - Bike Bluetooth log (automatic capture)',
    `Saved ${new Date().toString()}`,
    S.dev ? `Device ${S.dev.name} (${S.dev.deviceId})` : '',
    '',
  ].join('\n') + S.log.join('\n') + '\n';
}

/* ---------- finding the bike ---------- */

async function startSearch() {
  if (!S.auto || S.phase === 'connected' || S.phase === 'connecting') return;
  S.phase = 'searching';
  changed();
  try {
    if (!scanListener) {
      scanListener = await BLE.addListener('onScanResult', (r) => {
        const id = r.device?.deviceId;
        if (!id || S.phase !== 'searching') return;
        log(`Found ${r.localName || r.device.name || id} (signal ${r.rssi} dBm)` +
          (r.manufacturerData && Object.keys(r.manufacturerData).length ? ` manufacturer data ${JSON.stringify(r.manufacturerData)}` : '') +
          (r.serviceData && Object.keys(r.serviceData).length ? ` service data ${JSON.stringify(r.serviceData)}` : ''));
        connect(id, r.localName || r.device.name);
      });
    }
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
      log(`Bike already connected to the iPhone: ${devices[0].name || devices[0].deviceId}`);
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
    await BLE.connect({ deviceId, timeout: 20000 });
    S.phase = 'connected';
    log('Connected.');
    try { log(`MTU ${(await BLE.getMtu({ deviceId })).value}`); } catch { /* not important */ }

    const { services } = await BLE.getServices({ deviceId });
    for (const s of services) {
      log(`SERVICE ${s.uuid} (${label(s.uuid)})`);
      for (const c of s.characteristics) {
        const props = Object.entries(c.properties).filter(([, v]) => v).map(([k]) => k);
        log(`  CHAR ${c.uuid} (${label(c.uuid)}) [${props.join(', ')}]`);
        S.chars.push({ svc: s.uuid, uuid: c.uuid, props: c.properties, value: null, count: 0, err: null });
      }
    }
    if (skip.size) log(`Not reading ${skip.size} locked value(s) found earlier, to avoid pairing prompts.`);
    await readAll('first read');
    await subscribeAll();
    log('Capturing. Readable values are re-read every 2 s (only changes are logged); GPS speed is logged alongside.');
    pollTimer = setInterval(() => readAll('auto'), 2000);
    startGps();
  } catch (e) {
    log('Connect failed: ' + errText(e) + '. Will try again.');
    await BLE.disconnect({ deviceId }).catch(() => {});
    await endSession();
    setTimeout(startSearch, 10000);
  } finally {
    busyConnect = false;
    changed();
  }
}

async function onDisconnected() {
  log('===== Bike disconnected (ignition off or out of range). Waiting for it to come back. =====');
  await endSession();
  upload();
  setTimeout(startSearch, 3000);
}

async function endSession() {
  clearInterval(pollTimer);
  pollTimer = null;
  stopGps();
  const ls = connListeners.splice(0);
  await Promise.all(ls.map((h) => h.remove?.().catch(() => {})));
  S.phase = 'off';
  S.speed = null;
  changed();
}

let reading = false;
export async function readAll(why, includeSkipped = false) {
  if (S.phase !== 'connected' || reading) return;
  reading = true;
  if (why !== 'auto') log(`--- reading all values (${why}) ---`);
  try {
    for (const c of S.chars.filter((x) => x.props.read)) {
      if (S.phase !== 'connected') break;
      if (!includeSkipped && skip.has(c.uuid)) continue;
      try {
        const { value } = await BLE.read({ deviceId: S.dev.deviceId, service: c.svc, characteristic: c.uuid, timeout: 5000 });
        const diff = c.value !== null && c.value !== value;
        c.value = value; c.err = null;
        if (why !== 'auto' || diff) log(`READ ${label(c.uuid)} = ${hexSp(value) || '(empty)'}  |${ascii(value)}|${diff ? '  CHANGED' : ''}`);
      } catch (e) {
        const msg = errText(e);
        if (c.err !== msg || why !== 'auto') log(`READ ${label(c.uuid)} failed: ${msg}`);
        c.err = msg;
        if (/auth|encrypt|pair|permit|not permitted/i.test(msg) && !skip.has(c.uuid)) {
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

async function subscribeAll() {
  const { deviceId } = S.dev;
  for (const c of S.chars.filter((x) => x.props.notify || x.props.indicate)) {
    const handler = (r) => {
      c.value = r?.value ?? '';
      c.count++;
      log(`NOTIFY ${label(c.uuid)} = ${hexSp(c.value) || '(empty)'}  |${ascii(c.value)}|`);
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

/* ---------- GPS alongside (also keeps the app running when the screen is locked) ---------- */

function startGps() {
  stopGps();
  gpsWatch = watchPosition(
    (p) => {
      const kmh = p.coords.speed != null && p.coords.speed >= 0 ? p.coords.speed * 3.6 : null;
      S.speed = kmh;
      const now = Date.now();
      if (now - lastGpsLog >= 3000) {
        lastGpsLog = now;
        log(`GPS speed ${kmh == null ? '?' : kmh.toFixed(1)} km/h (accuracy ${Math.round(p.coords.accuracy)} m)`);
      }
    },
    (e) => log(`GPS unavailable (code ${e.code}). Capture continues without speed.`)
  );
}
function stopGps() {
  if (gpsWatch != null) clearWatch(gpsWatch);
  gpsWatch = null;
}

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
  if (on) { log('Automatic capture switched ON.'); if (await init()) startSearch(); }
  else {
    log('Automatic capture switched OFF.');
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
  skip = new Set((await db.kvGet(SKIP_KEY, [])) || []);
  S.auto = await db.kvGet(AUTO_KEY, true);
  S.gistId = (await getSync().catch(() => ({}))).gistId || null;
  setInterval(() => upload(), 120000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') upload(); });
  if (!S.auto) return;
  if (!(await init())) return;
  log('App opened: looking for the bike.');
  await wait(500);
  startSearch();
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

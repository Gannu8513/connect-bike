// Bike Bluetooth: a read-only explorer for the bike's Bluetooth unit ("HONDA BTU ...").
// It connects, reads every readable value, listens to every notify channel and keeps a timestamped
// log that can be shared. It never writes to the bike (only the standard "turn on notifications"
// switch that every Bluetooth app sets). Works only in the installed iPhone app.
import { db } from '../db.js';
import { esc, icon, toast, openForm, shareFile } from '../ui.js';
import { isNative } from '../geo.js';

export const title = 'Bike Bluetooth';

const HONDA_SERVICE = '4d87b1ea-528b-4798-b002-e2e1442a2e86';
const LOG_KEY = 'bleLog';
const MAX_LOG = 8000;
const cap = window.Capacitor;
const BLE = isNative && typeof cap.registerPlugin === 'function' ? cap.registerPlugin('BluetoothLe') : null;

// Names for the standard Bluetooth ids we expect; the rest are Honda's own.
const KNOWN = {
  '1800': 'Generic Access', '1801': 'Generic Attribute', '180a': 'Device Information', '180f': 'Battery Service',
  '2a00': 'Device Name', '2a01': 'Appearance', '2a04': 'Connection Parameters', '2a05': 'Service Changed',
  '2a29': 'Manufacturer', '2a24': 'Model Number', '2a25': 'Serial Number', '2a27': 'Hardware Revision',
  '2a26': 'Firmware Revision', '2a28': 'Software Revision', '2a23': 'System ID', '2a50': 'PnP ID', '2a19': 'Battery Level',
};
const short = (u) => (u.endsWith('-0000-1000-8000-00805f9b34fb') && u.startsWith('0000') ? u.slice(4, 8) : u);
const label = (u) => KNOWN[short(u)] || short(u).slice(0, 8).toUpperCase();

/* ---------- state (kept while the app is open, across screen changes) ---------- */
const S = {
  phase: 'idle', // idle | scanning | connecting | connected
  found: new Map(), // deviceId -> { name, rssi, uuids }
  dev: null, // { deviceId, name }
  chars: [], // { svc, uuid, props, value, count, err }
  log: [],
  poll: null,
  listeners: [],
  el: null,
};

const hexSp = (h) => (h || '').replace(/(..)/g, '$1 ').trim();
const ascii = (h) => (h || '').replace(/(..)/g, (b) => { const c = parseInt(b, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : '.'; });
const stamp = () => { const d = new Date(); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };

let saveTimer;
function log(line) {
  S.log.push(`[${stamp()}] ${line}`);
  if (S.log.length > MAX_LOG) S.log.splice(0, S.log.length - MAX_LOG);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.kvSet(LOG_KEY, S.log).catch(() => {}), 800);
  scheduleDraw();
}
const errText = (e) => String(e?.message || e || 'unknown error');

let drawPending = false;
function scheduleDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; if (S.el?.isConnected && location.hash === '#blebike') draw(S.el); });
}

async function on(event, fn) {
  const h = await BLE.addListener(event, fn);
  S.listeners.push(h);
}
async function dropListeners() {
  const ls = S.listeners.splice(0);
  await Promise.all(ls.map((h) => h.remove?.().catch(() => {})));
}

/* ---------- actions ---------- */

async function scan() {
  if (S.phase === 'scanning') return;
  S.found.clear();
  S.phase = 'scanning';
  log('Searching for Bluetooth devices...');
  try {
    await BLE.initialize({});
    // Already connected by iOS (e.g. through Honda's app)? Those don't show in a scan.
    try {
      const { devices } = await BLE.getConnectedDevices({ services: [HONDA_SERVICE] });
      for (const d of devices || []) {
        S.found.set(d.deviceId, { name: d.name || 'Bike unit (already connected)', rssi: null, uuids: [HONDA_SERVICE] });
        log(`Already connected to iPhone: ${d.name || d.deviceId}`);
      }
    } catch (e) { log('Connected-device check failed: ' + errText(e)); }

    await on('onScanResult', (r) => {
      const id = r.device?.deviceId;
      if (!id) return;
      const isNew = !S.found.has(id);
      S.found.set(id, { name: r.localName || r.device.name || '', rssi: r.rssi, uuids: r.uuids || [], mfr: r.manufacturerData });
      if (isNew && /honda|btu/i.test(r.localName || r.device.name || '')) {
        log(`Found ${r.localName || r.device.name} (signal ${r.rssi} dBm) adverts: ${(r.uuids || []).join(', ') || 'none'}` +
          (r.manufacturerData ? ` manufacturer data: ${JSON.stringify(r.manufacturerData)}` : ''));
      }
      scheduleDraw();
    });
    await BLE.requestLEScan({ allowDuplicates: false });
    setTimeout(stopScan, 12000);
  } catch (e) {
    S.phase = 'idle';
    log('Search failed: ' + errText(e) + ' (is Bluetooth on, and allowed for this app in Settings?)');
  }
  scheduleDraw();
}

async function stopScan() {
  if (S.phase !== 'scanning') return;
  await BLE.stopLEScan().catch(() => {});
  await dropListeners();
  S.phase = 'idle';
  log(`Search finished, ${S.found.size} devices seen.`);
}

async function connect(deviceId) {
  await stopScan();
  const f = S.found.get(deviceId) || {};
  S.dev = { deviceId, name: f.name || deviceId };
  S.phase = 'connecting';
  S.chars = [];
  log(`Connecting to ${S.dev.name}...`);
  scheduleDraw();
  try {
    await on(`disconnected|${deviceId}`, () => {
      log('Bike unit disconnected.');
      stopPoll();
      S.phase = 'idle';
      dropListeners();
    });
    await BLE.connect({ deviceId, timeout: 20000 });
    S.phase = 'connected';
    log('Connected.');
    try { const { value } = await BLE.getMtu({ deviceId }); log(`MTU ${value}`); } catch { /* not important */ }

    const { services } = await BLE.getServices({ deviceId });
    for (const s of services) {
      log(`SERVICE ${s.uuid} (${label(s.uuid)})`);
      for (const c of s.characteristics) {
        const props = Object.entries(c.properties).filter(([, v]) => v).map(([k]) => k);
        log(`  CHAR ${c.uuid} (${label(c.uuid)}) [${props.join(', ')}]`);
        S.chars.push({ svc: s.uuid, uuid: c.uuid, props: c.properties, value: null, count: 0, err: null });
      }
    }
    await readAll('first read');
    await subscribeAll();
    log('Ready. Now switch the ignition on/off, start the engine, ride, etc. and add marks as you go.');
  } catch (e) {
    log('Connect failed: ' + errText(e));
    S.phase = 'idle';
    await BLE.disconnect({ deviceId }).catch(() => {});
  }
  scheduleDraw();
}

async function readAll(why) {
  if (S.phase !== 'connected') return;
  log(`--- reading all values (${why}) ---`);
  for (const c of S.chars.filter((x) => x.props.read)) {
    try {
      const { value } = await BLE.read({ deviceId: S.dev.deviceId, service: c.svc, characteristic: c.uuid, timeout: 6000 });
      const changed = c.value !== null && c.value !== value;
      c.value = value; c.err = null;
      if (why === 'first read' || changed || why === 'manual') log(`READ ${label(c.uuid)} = ${hexSp(value) || '(empty)'}  |${ascii(value)}|${changed ? '  CHANGED' : ''}`);
    } catch (e) {
      c.err = errText(e);
      log(`READ ${label(c.uuid)} failed: ${c.err}`);
    }
  }
  scheduleDraw();
}

async function subscribeAll() {
  const { deviceId } = S.dev;
  for (const c of S.chars.filter((x) => x.props.notify || x.props.indicate)) {
    const handler = (r) => {
      c.value = r?.value ?? ''; c.count++;
      log(`NOTIFY ${label(c.uuid)} = ${hexSp(c.value) || '(empty)'}  |${ascii(c.value)}|`);
    };
    // The native side names the event with iOS's own spelling of the ids, which is the short
    // form for standard ones, so listen under both spellings.
    const keys = new Set([`${c.svc}|${c.uuid}`, `${short(c.svc)}|${short(c.uuid)}`]);
    for (const k of keys) await on(`notification|${deviceId}|${k}`, handler);
    try {
      await BLE.startNotifications({ deviceId, service: c.svc, characteristic: c.uuid, timeout: 6000 });
      log(`Listening to ${label(c.uuid)}`);
    } catch (e) {
      c.err = errText(e);
      log(`Listen to ${label(c.uuid)} failed: ${c.err}`);
    }
  }
}

function startPoll() {
  stopPoll();
  S.poll = setInterval(() => readAll('auto'), 2000);
  log('Auto re-read every 2 s ON (only changes are logged).');
}
function stopPoll() {
  if (!S.poll) return;
  clearInterval(S.poll);
  S.poll = null;
  log('Auto re-read OFF.');
}

async function disconnect() {
  stopPoll();
  if (S.dev) await BLE.disconnect({ deviceId: S.dev.deviceId }).catch(() => {});
  await dropListeners();
  S.phase = 'idle';
  log('Disconnected by you.');
}

function logText() {
  const head = [
    'Connect Bike - Bike Bluetooth log',
    `Saved ${new Date().toString()}`,
    S.dev ? `Device ${S.dev.name} (${S.dev.deviceId})` : '',
    '',
  ];
  return head.join('\n') + S.log.join('\n') + '\n';
}

async function shareLog() {
  const name = `bike-bluetooth-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
  try { await shareFile(name, logText(), 'text/plain'); } catch (e) { toast('Could not share: ' + errText(e)); }
}

async function copyLog() {
  try { await navigator.clipboard.writeText(logText()); toast('Log copied. Paste it into a chat.'); }
  catch { toast('Copy is blocked here. Use Share instead.'); }
}

/* ---------- screen ---------- */

const MARKS = ['Ignition ON', 'Ignition OFF', 'Engine started', 'Revving', 'Riding', 'Stopped', 'Neutral', 'In gear', 'Turn signal', 'Horn/Lights'];

function draw(el) {
  const p = S.phase;
  const devices = [...S.found.entries()]
    .sort((a, b) => (/honda|btu/i.test(b[1].name) - /honda|btu/i.test(a[1].name)) || ((b[1].rssi ?? -999) - (a[1].rssi ?? -999)))
    .filter(([, d]) => d.name || d.uuids?.length);

  el.innerHTML = `
    <a class="back" href="#bike">${icon('back', 18)} More</a>
    <div class="card">
      <div class="row head"><h2>${p === 'connected' ? esc(S.dev.name) : 'Find the bike'}</h2>
        <span class="chip ${p === 'connected' ? 'ok' : 'info'}">${{ idle: 'Not connected', scanning: 'Searching...', connecting: 'Connecting...', connected: 'Connected' }[p]}</span></div>
      ${p === 'connected'
        ? `<div class="actions">
            <button class="btn sm" data-act="read">Read again</button>
            <button class="btn sm ${S.poll ? 'primary' : ''}" data-act="poll">${S.poll ? 'Auto re-read: ON' : 'Auto re-read: OFF'}</button>
            <button class="btn sm danger" data-act="disc">Disconnect</button>
          </div>`
        : `<p class="muted small mb">Switch the bike's ignition ON and keep the phone near it. Close Honda's app first, as the unit may accept only one phone app at a time.</p>
           <button class="btn primary block" data-act="scan" ${p !== 'idle' ? 'disabled' : ''}>${p === 'scanning' ? 'Searching...' : 'Search'}</button>
           ${devices.length ? `<ul class="list" style="margin-top:12px">${devices.slice(0, 15).map(([id, d]) => `
              <li class="row" data-act="connect" data-id="${esc(id)}">
                <div class="grow"><div class="t">${esc(d.name || 'Unnamed device')}</div>
                <div class="muted small">${d.rssi != null ? d.rssi + ' dBm' : ''} ${d.uuids?.includes(HONDA_SERVICE) ? '· Honda unit' : ''}</div></div>
                <button class="btn sm ${/honda|btu/i.test(d.name) ? 'primary' : ''}">Connect</button>
              </li>`).join('')}</ul>` : ''}`}
    </div>

    ${p === 'connected' ? `
    <div class="card">
      <h2>Mark what you are doing</h2>
      <p class="muted small mb">Tap one at the moment you do it, so we can match changes in the data to the bike.</p>
      <div class="chips">${MARKS.map((m) => `<button class="chip" data-act="mark" data-m="${esc(m)}">${esc(m)}</button>`).join('')}
        <button class="chip info" data-act="note">Other...</button></div>
    </div>
    <div class="card">
      <h2>Values</h2>
      <ul class="list">${S.chars.map((c) => `
        <li><div class="row"><span class="t">${esc(label(c.uuid))}</span><span class="muted small">${c.count ? c.count + ' updates' : ''}</span></div>
          <div class="muted small">${['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter((k) => c.props[k]).map((k) => ({ writeWithoutResponse: 'write-nr' }[k] || k)).join(' · ')}</div>
          ${c.value != null ? `<code class="small" style="display:block;overflow-wrap:anywhere">${esc(hexSp(c.value)) || '(empty)'}<br>${esc(ascii(c.value))}</code>` : ''}
          ${c.err ? `<div class="small" style="color:var(--bad)">${esc(c.err)}</div>` : ''}
        </li>`).join('')}</ul>
    </div>` : ''}

    <div class="card">
      <div class="row head"><h2>Log</h2><span class="muted small">${S.log.length} lines</span></div>
      <div class="actions mb">
        <button class="btn sm primary" data-act="share">${icon('share', 16)} Share</button>
        <button class="btn sm" data-act="copy">Copy</button>
        <button class="btn sm danger" data-act="clear">Clear</button>
      </div>
      <pre class="small" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:50vh;overflow:auto;margin:0">${esc(S.log.slice(-200).join('\n')) || 'Nothing yet.'}</pre>
    </div>
  `;
  const pre = el.querySelector('pre');
  if (pre) pre.scrollTop = pre.scrollHeight;
}

export async function render(el) {
  S.el = el;
  if (!BLE) {
    el.innerHTML = `<a class="back" href="#bike">${icon('back', 18)} More</a>
      <div class="card"><h2>Only in the iPhone app</h2><p>Safari cannot use Bluetooth. Open the Connect Bike app installed with AltStore to use this screen.</p></div>`;
    return;
  }
  if (!S.log.length) S.log = (await db.kvGet(LOG_KEY, [])) || [];
  draw(el);

  el.onclick = (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    switch (t.dataset.act) {
      case 'scan': scan(); break;
      case 'connect': connect(t.dataset.id); break;
      case 'read': readAll('manual'); break;
      case 'poll': S.poll ? stopPoll() : startPoll(); break;
      case 'disc': disconnect(); break;
      case 'mark': log(`>>> MARK: ${t.dataset.m}`); toast('Marked: ' + t.dataset.m); break;
      case 'note':
        openForm({
          title: 'Add a mark',
          fields: [{ name: 'text', label: 'What just happened?', type: 'text', placeholder: 'e.g. fuel light came on' }],
          onSave: (v) => { if (v.text) log(`>>> MARK: ${v.text}`); },
        });
        break;
      case 'share': shareLog(); break;
      case 'copy': copyLog(); break;
      case 'clear':
        S.log = [];
        db.kvSet(LOG_KEY, []).catch(() => {});
        draw(el);
        break;
    }
  };
}

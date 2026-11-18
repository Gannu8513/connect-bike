// Bike Bluetooth: shows the automatic capture from the bike's Bluetooth unit (see ../bikeble.js).
// Nothing needs to be done here; the screen is for checking it works and sharing the log by hand.
import { esc, icon, toast, shareFile, fmtTime } from '../ui.js';
import { BLE, S, label, hexSp, ascii, logText, clearLog, readAll, setAuto, upload, summaryText, lockedCount, askMotion } from '../bikeble.js';

export const title = 'Bike Bluetooth';

const STATUS = {
  off: ['Off', 'info'],
  searching: ['Looking for the bike...', 'info'],
  connecting: ['Connecting...', 'info'],
  connected: ['Capturing', 'ok'],
};

let host = null;
let pending = false;
window.addEventListener('ble:changed', () => {
  if (pending || !host?.isConnected || location.hash !== '#blebike') return;
  pending = true;
  requestAnimationFrame(() => { pending = false; if (host?.isConnected) draw(host); });
});

function draw(el) {
  const [st, cls] = S.auto ? STATUS[S.phase] : ['Switched off', 'info'];
  const up = S.lastUpload;
  el.innerHTML = `
    <a class="back" href="#bike">${icon('back', 18)} More</a>
    <div class="card">
      <div class="row head"><h2>${S.phase === 'connected' ? esc(S.dev.name) : 'Automatic capture'}</h2><span class="chip ${cls}">${st}</span></div>
      <label class="check"><input type="checkbox" data-act="auto" ${S.auto ? 'checked' : ''}><span>Capture from the bike automatically</span></label>
      <p class="muted small" style="margin-top:8px">Nothing to do: keep Bluetooth on and open Connect Bike when you get on the bike, with the ignition on.
        It connects by itself and records everything the bike offers, together with the phone's own GPS and motion sensors, keeps going with
        the screen locked, reconnects next time, and uploads the log to your cloud backup. It only reads; it never changes anything on the bike.
        Tip: keep Honda's app running too. Anything the bike sends to it is captured here as well.</p>
    </div>

    <div class="card">
      <h2>Phone readings</h2>
      <dl class="kv">
        <dt>Bike signal</dt><dd>${S.rssi == null ? '—' : S.rssi + ' dBm'}</dd>
        <dt>Location</dt><dd>${S.gps ? `${S.gps.lat.toFixed(5)}, ${S.gps.lon.toFixed(5)} (±${Math.round(S.gps.acc)} m)` : '—'}</dd>
        <dt>Speed</dt><dd>${S.gps?.kmh == null ? '—' : S.gps.kmh.toFixed(0) + ' km/h'}</dd>
        <dt>Altitude</dt><dd>${S.gps?.alt == null ? '—' : Math.round(S.gps.alt) + ' m'}</dd>
        <dt>Motion sensors</dt><dd>${S.motion ? 'Recording' : '<button class="btn sm" data-act="motion">Allow</button>'}</dd>
      </dl>
      <p class="muted small" style="margin-top:8px">These come from the iPhone, not the bike. They are logged next to the bike data so changes can be matched.</p>
    </div>

    <div class="card">
      <div class="row head"><h2>What the bike gives</h2>${lockedCount() ? `<button class="btn sm" data-act="locked">Try ${lockedCount()} locked</button>` : ''}</div>
      <pre class="small" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:45vh;overflow:auto;margin:0">${esc(summaryText())}</pre>
      ${lockedCount() ? '<p class="muted small" style="margin-top:8px">Locked values need the phone to be paired with the bike. "Try" may show an iPhone pairing request.</p>' : ''}
    </div>

    <div class="card">
      <div class="row head"><h2>Upload</h2><button class="btn sm" data-act="upload">Upload now</button></div>
      <p class="small">${up ? `${up.ok ? 'Last uploaded' : 'Last try failed'} at ${fmtTime(up.at)}${up.ok ? '' : ': ' + esc(up.msg)}` : 'Uploads every 2 minutes while there is new data.'}</p>
      ${S.gistId ? `<p class="muted small" style="margin-top:6px">Cloud log id (send this once): <b style="user-select:all">${esc(S.gistId)}</b> <button class="btn sm" data-act="copyid">Copy id</button></p>` : ''}
      <div class="actions" style="margin-top:10px">
        <button class="btn sm" data-act="share">${icon('share', 16)} Share log</button>
        <button class="btn sm danger" data-act="clear">Clear log</button>
      </div>
    </div>

    ${S.chars.length ? `
    <div class="card">
      <div class="row head"><h2>Values</h2>${S.phase === 'connected' ? '<button class="btn sm" data-act="read">Read again</button>' : ''}</div>
      <ul class="list">${S.chars.map((c) => `
        <li><div class="row"><span class="t">${esc(label(c.uuid))}</span><span class="muted small">${c.count ? c.count + ' updates' : ''}</span></div>
          <div class="muted small">${['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter((k) => c.props[k]).map((k) => ({ writeWithoutResponse: 'write-nr' }[k] || k)).join(' · ')}</div>
          ${c.value != null ? `<code class="small" style="display:block;overflow-wrap:anywhere">${esc(hexSp(c.value)) || '(empty)'}<br>${esc(ascii(c.value))}</code>` : ''}
          ${c.err ? `<div class="small" style="color:var(--bad)">${esc(c.err)}</div>` : ''}
        </li>`).join('')}</ul>
    </div>` : ''}

    <div class="card">
      <div class="row head"><h2>Log</h2><span class="muted small">${S.log.length} lines</span></div>
      <pre class="small" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:50vh;overflow:auto;margin:0">${esc(S.log.slice(-150).join('\n')) || 'Nothing yet.'}</pre>
    </div>
  `;
  const pre = [...el.querySelectorAll('pre')].pop();
  if (pre) pre.scrollTop = pre.scrollHeight;
}

export async function render(el) {
  host = el;
  if (!BLE) {
    el.innerHTML = `<a class="back" href="#bike">${icon('back', 18)} More</a>
      <div class="card"><h2>Only in the iPhone app</h2><p>Safari cannot use Bluetooth. Open the Connect Bike app installed with AltStore.</p></div>`;
    return;
  }
  draw(el);

  el.onchange = (e) => {
    if (e.target.dataset?.act === 'auto') setAuto(e.target.checked);
  };
  el.onclick = async (e) => {
    const t = e.target.closest('button[data-act]');
    if (!t) return;
    switch (t.dataset.act) {
      case 'read': readAll('manual'); break;
      case 'locked': readAll('locked values', true); break;
      case 'motion': askMotion(); break;
      case 'upload': await upload(true); toast(S.lastUpload?.ok ? 'Log uploaded' : 'Upload failed: ' + (S.lastUpload?.msg || '')); break;
      case 'copyid':
        try { await navigator.clipboard.writeText(S.gistId); toast('Copied'); } catch { toast('Press and hold the id to copy it.'); }
        break;
      case 'share': {
        const name = `bike-bluetooth-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
        try { await shareFile(name, logText(), 'text/plain'); } catch { toast('Could not share the log.'); }
        break;
      }
      case 'clear':
        if (confirm('Clear the Bluetooth log on this phone?')) clearLog();
        break;
    }
  };
}

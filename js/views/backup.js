import { db } from '../db.js';
import { getSync, connect, disconnect, syncNow } from '../sync.js';
import { serviceReport } from '../report.js';
import { esc, today, fmtDateTime, openForm, refresh, toast, shareFile, icon } from '../ui.js';

export const title = 'Backup and sync';

let busy = false;

const RESULT = {
  pushed: 'Cloud copy updated from this phone.',
  pulled: 'This phone now has the newer data from the cloud.',
  same: 'Already up to date.',
  conflict: 'Both sides changed. Choose which to keep.',
};

async function run(job) {
  busy = true;
  refresh();
  try {
    const result = await job();
    if (RESULT[result]) toast(RESULT[result]);
  } catch (e) {
    toast(e.message === 'auth' ? 'GitHub did not accept the token. Connect again with a new one.' : 'Sync failed. Check your internet connection.');
  }
  busy = false;
  refresh();
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!confirm('Replace everything in the app with this backup? The data on this phone now will be overwritten.')) return;
    await db.importAll(data);
    toast('Backup restored');
    refresh();
  } catch (e) {
    console.error(e);
    toast('That file is not a Bike Companion backup.');
  }
}

export async function render(el) {
  const sync = await getSync();

  const cloud = sync.token
    ? `<p>Connected to GitHub as <b>${esc(sync.user || '')}</b>.</p>
       <p class="muted small">${sync.lastSync ? `Last synced ${esc(fmtDateTime(sync.lastSync))}.` : 'Not synced yet.'} The app syncs when you open it and after you change something.</p>
       ${
         sync.conflict
           ? `<div class="notice bad">This phone and the cloud copy have both changed since the last sync, so one has to win. The other is overwritten.
                <div class="actions" style="margin-top:8px">
                  <button class="btn sm" data-act="keepLocal" ${busy ? 'disabled' : ''}>Keep this phone's data</button>
                  <button class="btn sm" data-act="keepCloud" ${busy ? 'disabled' : ''}>Use the cloud data</button>
                </div>
              </div>`
           : ''
       }
       <div class="actions">
         <button class="btn primary" data-act="sync" ${busy ? 'disabled' : ''}>${icon('cloud', 18)} ${busy ? 'Syncing…' : 'Sync now'}</button>
         <button class="btn danger" data-act="disconnect" ${busy ? 'disabled' : ''}>Disconnect</button>
       </div>`
    : `<p>Keep the same data on your phone and computer, and a copy safe if the phone is lost. It is stored as a private gist in your own GitHub account, which is free.</p>
       <ol class="muted small" style="padding-left:20px">
         <li>On github.com open Settings, Developer settings, Personal access tokens, Tokens (classic).</li>
         <li>Generate a new token and tick only the <b>gist</b> permission.</li>
         <li>Copy the token and paste it here. Use the same token on your other devices.</li>
       </ol>
       <button class="btn primary block" data-act="connect" ${busy ? 'disabled' : ''}>${icon('cloud', 18)} ${busy ? 'Connecting…' : 'Connect GitHub'}</button>`;

  el.innerHTML = `
    <a class="back" href="#bike">${icon('back', 18)} More</a>

    <div class="card">
      <h2>Cloud sync</h2>
      ${cloud}
      <p class="muted small" style="margin-top:10px">Photos are not synced, to keep the cloud copy small. They are included in backup files.</p>
    </div>

    <div class="card">
      <h2>Service report</h2>
      <p>A PDF of the bike's details, odometer, service history, maintenance schedule and parts. Useful for your records or to show a buyer.</p>
      <button class="btn block" data-act="pdf" style="margin-top:8px">${icon('doc', 18)} Create PDF report</button>
    </div>

    <div class="card">
      <h2>Backup file</h2>
      <p>Everything in the app, photos included, in one file you can keep in Files or iCloud Drive.</p>
      <div class="actions" style="margin-top:8px">
        <button class="btn" data-act="export">${icon('share', 18)} Save backup</button>
        <button class="btn" data-act="import">Restore backup</button>
      </div>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </div>

    <div class="card">
      <h2>What leaves this phone</h2>
      <p class="muted small">Maps, place search and nearby fuel or workshops come from OpenStreetMap; routes from OSRM; weather from MET Norway. They receive what you search for and the location needed to answer. Cloud sync, if you connect it, sends your data to your own GitHub account. Nothing else is sent anywhere.</p>
    </div>
  `;

  el.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    switch (t.dataset.act) {
      case 'connect':
        openForm({
          title: 'Connect GitHub',
          note: 'Paste a personal access token that has only the "gist" permission. It is stored on this device only.',
          fields: [{ name: 'token', label: 'Access token', type: 'password', required: true, placeholder: 'ghp_…' }],
          saveLabel: 'Connect',
          onSave: async (v) => {
            try {
              const result = await connect(v.token);
              toast(RESULT[result] || 'Connected');
              return undefined;
            } catch (ex) {
              return ex.message === 'auth'
                ? 'GitHub did not accept that token. Check it has the gist permission.'
                : 'Could not reach GitHub. Check your internet connection.';
            }
          },
        });
        break;
      case 'sync': run(() => syncNow()); break;
      case 'keepLocal': run(() => syncNow('local')); break;
      case 'keepCloud':
        if (confirm("Replace this phone's data with the cloud copy?")) run(() => syncNow('cloud'));
        break;
      case 'disconnect':
        if (confirm('Stop syncing on this device? Your data stays on the phone and the cloud copy stays in your GitHub account.')) {
          await disconnect();
          refresh();
        }
        break;
      case 'pdf':
        try { await serviceReport(); } catch (ex) { console.error(ex); toast('The report could not be created.'); }
        break;
      case 'export':
        shareFile(`bike-companion-backup-${today()}.json`, JSON.stringify(await db.exportAll()), 'application/json');
        break;
      case 'import': el.querySelector('#importFile').click(); break;
    }
  };
  el.onchange = (e) => {
    if (e.target.id === 'importFile' && e.target.files[0]) importBackup(e.target.files[0]);
  };
}

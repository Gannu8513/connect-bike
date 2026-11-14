import { db } from '../db.js';
import { esc, openForm, icon } from '../ui.js';

export const title = 'Bike profile';

function editField(profile, idx) {
  const rec = idx == null ? null : profile[idx];
  openForm({
    title: rec ? rec.label : 'Add detail',
    fields: [
      ...(rec && !rec.custom ? [] : [{ name: 'label', label: 'Name', type: 'text', required: true, placeholder: 'e.g. Registration number' }]),
      { name: 'value', label: 'Value', type: 'text' },
      { name: 'verified', label: 'Verified against the manual, a bill or the registration document', type: 'checkbox' },
    ],
    values: rec || { verified: false },
    onSave: (v) => {
      const next = [...profile];
      if (rec) next[idx] = { ...rec, ...v };
      else next.push({ key: 'custom_' + Date.now(), custom: true, ...v });
      return db.kvSet('profile', next);
    },
    onDelete: rec?.custom ? () => db.kvSet('profile', profile.filter((_, i) => i !== idx)) : null,
  });
}

export async function render(el) {
  const profile = await db.kvGet('profile', []);

  el.innerHTML = `
    <a class="back" href="#bike">${icon('back', 18)} More</a>
    <div class="card">
      <h2>Motorcycle</h2>
      <ul class="list">${profile
        .map(
          (f, i) => `<li class="row" data-act="field" data-i="${i}">
            <div class="grow">
              <div class="muted small">${esc(f.label)}</div>
              <div class="t">${esc(f.value) || '<span class="muted">Not set</span>'}</div>
            </div>
            ${f.verified ? '' : '<span class="chip unverified">Unverified</span>'}
          </li>`
        )
        .join('')}</ul>
      <button class="btn block" style="margin-top:12px" data-act="addField">${icon('plus', 18)} Add detail</button>
      <p class="muted small">Tap a line to change it. "Unverified" means it has not been checked against a manual or document yet.</p>
    </div>

    <div class="card">
      <h2>Connection to the bike</h2>
      <ul class="list">
        <li>
          <div class="row"><span class="t">Bluetooth</span><span class="chip">Not available</span></div>
          <div class="muted small">Web apps on iPhone cannot use Bluetooth, so this app does not connect to the bike.</div>
        </li>
        <li>
          <div class="row"><span class="t">OBD diagnostics</span><span class="chip">Not set up</span></div>
          <div class="muted small">The bike's diagnostic protocol is unknown and no adapter has been confirmed to work. The app shows no engine or sensor data from the bike.</div>
        </li>
        <li>
          <div class="row"><span class="t">Speed, distance, altitude</span><span class="chip info">Phone GPS</span></div>
          <div class="muted small">Measured by the phone, not the motorcycle.</div>
        </li>
        <li>
          <div class="row"><span class="t">Lean angle, G-force</span><span class="chip info">Phone sensors</span></div>
          <div class="muted small">Measured by the phone's motion sensors. Approximate, and only meaningful with the phone fixed in a mount.</div>
        </li>
      </ul>
    </div>
  `;

  el.onclick = (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    if (t.dataset.act === 'field') editField(profile, Number(t.dataset.i));
    if (t.dataset.act === 'addField') editField(profile, null);
  };
}

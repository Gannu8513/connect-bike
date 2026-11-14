import { db } from '../db.js';
import { esc, openForm, toast, icon } from '../ui.js';
import { getPos } from './ride.js';

export const title = 'Emergency';

async function shareLocation() {
  try {
    const [lat, lng] = await getPos();
    const url = `https://maps.apple.com/?ll=${lat},${lng}&q=I%20am%20here`;
    if (navigator.share) await navigator.share({ title: 'My location', text: 'I am here and may need help.', url });
    else { await navigator.clipboard?.writeText(url); toast('Map link copied. Paste it into a message.'); }
  } catch (e) {
    if (e.name !== 'AbortError') toast('Could not get your location. Allow location access and try again.');
  }
}

export async function render(el) {
  const em = await db.kvGet('emergency', { name: '', blood: '', medical: '', insurance: '', contacts: [] });
  const save = () => db.kvSet('emergency', em);
  const row = (label, value) => `<dt>${label}</dt><dd>${esc(value) || '<span class="muted">Not set</span>'}</dd>`;

  el.innerHTML = `
    <a class="back" href="#bike">${icon('back', 18)} More</a>
    <button class="btn primary block huge mb" data-act="share">${icon('share', 22)} Send my location</button>

    <div class="card">
      <h2>Call</h2>
      ${
        em.contacts.length
          ? `<ul class="list">${em.contacts
              .map(
                (c, i) => `<li class="row">
                  <div class="grow" data-act="contact" data-i="${i}">
                    <div class="t">${esc(c.label)} ${c.verified === false ? '<span class="chip unverified">Confirm number</span>' : ''}</div>
                    <div class="num" style="font-size:22px">${esc(c.phone)}</div>
                  </div>
                  <a class="btn primary" href="tel:${encodeURIComponent(c.phone)}">Call</a>
                </li>`
              )
              .join('')}</ul>`
          : '<p class="empty">No contacts yet.</p>'
      }
      <button class="btn block" style="margin-top:12px" data-act="addContact">${icon('plus', 18)} Add contact</button>
    </div>

    <div class="card">
      <div class="row head"><h2>Rider</h2><button class="btn sm" data-act="info">Edit</button></div>
      <dl class="kv">
        ${row('Name', em.name)}
        ${row('Blood group', em.blood)}
        ${row('Medical notes', em.medical)}
        ${row('Insurance policy', em.insurance)}
      </dl>
    </div>
    <p class="muted small">Numbers marked "Confirm number" were filled in for you and have not been checked. Confirm them, then tap the contact and tick "Verified". Add a family member or friend too.</p>
  `;

  const contactForm = (i) => {
    const rec = i == null ? null : em.contacts[i];
    openForm({
      title: rec ? 'Edit contact' : 'Add contact',
      fields: [
        { name: 'label', label: 'Name', type: 'text', required: true },
        { name: 'phone', label: 'Phone number', type: 'tel', required: true },
        { name: 'verified', label: 'Verified: I have confirmed this number', type: 'checkbox', default: true },
      ],
      values: rec || {},
      onSave: (v) => {
        if (rec) em.contacts[i] = v; else em.contacts.push(v);
        return save();
      },
      onDelete: rec ? () => { em.contacts.splice(i, 1); return save(); } : null,
    });
  };

  el.onclick = (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    switch (t.dataset.act) {
      case 'share': shareLocation(); break;
      case 'info':
        openForm({
          title: 'Rider details',
          fields: [
            { name: 'name', label: 'Name', type: 'text' },
            { name: 'blood', label: 'Blood group', type: 'text' },
            { name: 'medical', label: 'Medical notes', type: 'textarea', placeholder: 'Allergies, conditions, medication' },
            { name: 'insurance', label: 'Insurance policy number', type: 'text' },
          ],
          values: em,
          onSave: (v) => { Object.assign(em, v); return save(); },
        });
        break;
      case 'contact': contactForm(Number(t.dataset.i)); break;
      case 'addContact': contactForm(null); break;
    }
  };
}

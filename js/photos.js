// Photos of bills and documents, attached to a record and kept on this device.
import { db } from './db.js';
import { esc, icon, openSheet, refresh, toast } from './ui.js';

const MAX_SIDE = 1400; // big enough to read a bill, small enough to store hundreds

async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.72);
}

/** A small camera button showing how many photos a record has. owner is e.g. "docs:3". */
export const photoButton = (owner, counts) =>
  `<button class="btn sm" data-photos="${esc(owner)}" aria-label="Photos">${icon('camera', 17)}${counts[owner] ? ` ${counts[owner]}` : ''}</button>`;

/** Opens the photo sheet for one record. */
export async function openPhotos(owner, title) {
  let viewing = null;

  const draw = async () => {
    const list = await db.byOwner(owner);
    const dlg = openSheet(`<div class="sheet-body">
      <h2>${esc(title)}</h2>
      ${
        viewing
          ? `<img class="photo-full" src="${viewing.data}" alt="Photo">
             <div class="actions mb">
               <button class="btn" data-p="backToList">All photos</button>
               <button class="btn danger" data-p="delete">Delete photo</button>
             </div>`
          : list.length
            ? `<div class="thumbs">${list.map((p) => `<img src="${p.data}" data-p="view" data-id="${p.id}" alt="Photo, tap to enlarge">`).join('')}</div>`
            : '<p class="muted mb">No photos yet. Add a picture of the bill, receipt or document.</p>'
      }
      <input type="file" accept="image/*" id="photoInput" hidden>
      <div class="actions">
        <button class="btn" data-p="close">Done</button>
        ${viewing ? '' : `<button class="btn primary" data-p="add">${icon('camera', 18)} Add photo</button>`}
      </div>
      <p class="muted small" style="margin-top:10px">Photos stay on this phone and are included in backup files, but not in cloud sync.</p>
    </div>`);

    dlg.querySelector('.sheet-body').onclick = async (e) => {
      const t = e.target.closest('[data-p]');
      if (!t) return;
      switch (t.dataset.p) {
        case 'close': dlg.close(); refresh(); break;
        case 'add': dlg.querySelector('#photoInput').click(); break;
        case 'view': viewing = list.find((p) => p.id === Number(t.dataset.id)); draw(); break;
        case 'backToList': viewing = null; draw(); break;
        case 'delete':
          if (confirm('Delete this photo?')) { await db.del('photos', viewing.id); viewing = null; draw(); }
          break;
      }
    };
    dlg.querySelector('#photoInput').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await db.put('photos', { owner, data: await shrink(file), at: Date.now() });
        draw();
      } catch (ex) {
        console.error(ex);
        toast('That photo could not be added. Try a different image.');
      }
    };
  };

  await draw();
}

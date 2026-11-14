// Cloud sync through a private GitHub Gist in the owner's own GitHub account.
// Free, no server of ours involved. The access token stays on this device.
// Photos are not synced (they would make the copy too large); everything else is.
import { db } from './db.js';

const API = 'https://api.github.com';
const FILE = 'bike-companion.json';

async function gh(path, token, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401 || res.status === 403) throw new Error('auth');
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}

export const getSync = () => db.kvGet('sync', {});
const saveSync = (s) => db.kvSet('sync', s);

async function pull(s) {
  const gist = await gh('/gists/' + s.gistId, s.token);
  const f = gist.files?.[FILE];
  if (!f) return null;
  const text = f.truncated ? await (await fetch(f.raw_url, { signal: AbortSignal.timeout(30000) })).text() : f.content;
  return JSON.parse(text);
}

async function push(s) {
  let stamp = await db.kvGet('modifiedAt', 0);
  if (!stamp) { stamp = Date.now(); await db.kvSet('modifiedAt', stamp); }
  const data = await db.exportAll({ photos: false });
  data.stamp = stamp;
  const body = JSON.stringify({ description: 'Bike Companion sync data', public: false, files: { [FILE]: { content: JSON.stringify(data) } } });
  const gist = s.gistId
    ? await gh('/gists/' + s.gistId, s.token, { method: 'PATCH', body })
    : await gh('/gists', s.token, { method: 'POST', body });
  return { ...s, gistId: gist.id, remoteStamp: stamp, localStamp: stamp, lastSync: Date.now(), conflict: false };
}

/** Checks the token, finds an existing sync copy in the account if there is one, then syncs. */
export async function connect(token) {
  const me = await gh('/user', token);
  const gists = await gh('/gists?per_page=100', token);
  const existing = gists.find((g) => g.files && g.files[FILE]);
  await saveSync({ token, user: me.login, gistId: existing?.id || null, remoteStamp: null, localStamp: null, lastSync: null, conflict: false });
  return syncNow();
}

export const disconnect = () => db.kvDel('sync');

/**
 * Brings this device and the cloud copy in line.
 * Resolves to: off | pushed | pulled | same | conflict.
 * A conflict means both sides changed since the last sync; call again with 'local' or 'cloud' to choose.
 */
export async function syncNow(choice) {
  let s = await getSync();
  if (!s.token) return 'off';

  const remote = s.gistId ? await pull(s) : null;
  if (!remote) {
    await saveSync(await push(s));
    return 'pushed';
  }

  const localStamp = await db.kvGet('modifiedAt', 0);
  const localChanged = localStamp !== s.localStamp;
  const remoteChanged = remote.stamp !== s.remoteStamp;

  if (choice === 'local' || (localChanged && !remoteChanged)) {
    await saveSync(await push(s));
    return 'pushed';
  }
  if (choice === 'cloud' || (remoteChanged && !localChanged)) {
    await db.importAll(remote, { keepPhotos: true });
    await saveSync({ ...s, remoteStamp: remote.stamp, localStamp: remote.stamp, lastSync: Date.now(), conflict: false });
    return 'pulled';
  }
  if (!localChanged && !remoteChanged) {
    await saveSync({ ...s, lastSync: Date.now(), conflict: false });
    return 'same';
  }
  await saveSync({ ...s, conflict: true });
  return 'conflict';
}

let busy = false;
let timer;

/** Quiet background sync; never throws. Refreshes the screen if newer data arrived. */
export async function autoSync() {
  if (busy || !navigator.onLine) return;
  busy = true;
  try {
    const result = await syncNow();
    if (result === 'pulled' || result === 'conflict') window.dispatchEvent(new Event('app:refresh'));
  } catch { /* offline or token problem: the Backup screen shows the state */ }
  busy = false;
}

/** Sync when the app opens, shortly after changes, and when it goes to the background. */
export function startAutoSync() {
  autoSync();
  window.addEventListener('db:changed', () => {
    clearTimeout(timer);
    timer = setTimeout(autoSync, 20000);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autoSync();
  });
}

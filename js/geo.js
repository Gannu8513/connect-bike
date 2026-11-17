// GPS source. In the installed iPhone app (Capacitor) a native plugin keeps reporting positions
// while the screen is locked; in the browser the standard web API is used.

const cap = window.Capacitor;
export const isNative = !!cap?.isNativePlatform?.();
const BG = isNative ? cap.registerPlugin('BackgroundGeolocation') : null;

/**
 * Starts watching the position. onPos receives a web-style position ({ coords, timestamp });
 * onError receives { code } where 1 means permission denied.
 * Returns a handle for clearWatch (a Promise in the native app).
 */
export function watchPosition(onPos, onError) {
  if (BG) {
    return BG.addWatcher(
      {
        backgroundMessage: 'Recording your ride.',
        backgroundTitle: 'Ride tracking',
        requestPermissions: true,
        stale: false,
        distanceFilter: 0,
      },
      (loc, err) => {
        if (err) { onError({ code: err.code === 'NOT_AUTHORIZED' ? 1 : 2 }); return; }
        if (!loc) return;
        onPos({
          timestamp: loc.time || Date.now(),
          coords: {
            latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy,
            altitude: loc.altitude, speed: loc.speed, heading: loc.bearing,
          },
        });
      }
    );
  }
  if (!('geolocation' in navigator)) return null;
  return navigator.geolocation.watchPosition(onPos, onError, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}

export function clearWatch(handle) {
  if (handle == null) return;
  if (BG) Promise.resolve(handle).then((id) => BG.removeWatcher({ id })).catch(() => {});
  else navigator.geolocation.clearWatch(handle);
}

/** Opens the iPhone settings page for this app (native app only). */
export function openAppSettings() {
  BG?.openSettings?.().catch(() => {});
}

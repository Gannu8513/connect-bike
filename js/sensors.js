// Lean angle and G-force from the phone's own motion sensors.
// These describe the phone, not the motorcycle: they are only meaningful when the phone is
// fixed in a handlebar mount, and they are shown in the app as approximate phone readings.

const RAD = Math.PI / 180;

export const sensor = {
  on: false, available: false,
  lean: null,   // degrees, positive = leaning right
  g: null,      // acceleration excluding gravity, in g
  maxLeft: 0, maxRight: 0, maxG: 0,
};

let zero = null;  // mount angle captured at the start, so "upright" reads 0
let axis = 'x';   // which phone axis lies across the bike (portrait mount = x, landscape = y)

function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  const beta = e.beta * RAD, gamma = e.gamma * RAD;
  // Height of the phone's sideways axis above the horizon. Using the axis that sits across
  // the bike keeps the reading independent of how far the phone is tilted back in its mount.
  const zx = -Math.cos(beta) * Math.sin(gamma);
  const zy = Math.sin(beta);
  if (zero == null) {
    axis = Math.abs(zx) <= Math.abs(zy) ? 'x' : 'y';
    zero = Math.asin(Math.max(-1, Math.min(1, axis === 'x' ? zx : zy)));
  }
  let angle = (Math.asin(Math.max(-1, Math.min(1, axis === 'x' ? zx : zy))) - zero) / RAD;
  // Right side dropping lowers the x axis; in landscape the sign depends on which way the phone is turned.
  if (axis === 'x') angle = -angle;
  else if ((screen.orientation?.angle ?? 0) === 270) angle = -angle;

  sensor.available = true;
  sensor.lean = sensor.lean == null ? angle : sensor.lean * 0.7 + angle * 0.3;
  if (sensor.lean > sensor.maxRight) sensor.maxRight = sensor.lean;
  if (-sensor.lean > sensor.maxLeft) sensor.maxLeft = -sensor.lean;
}

function onMotion(e) {
  const a = e.acceleration;
  if (!a || a.x == null) return;
  const g = Math.hypot(a.x, a.y, a.z) / 9.81;
  sensor.available = true;
  sensor.g = sensor.g == null ? g : sensor.g * 0.75 + g * 0.25;
  if (sensor.g > sensor.maxG) sensor.maxG = sensor.g;
}

/** Call from a tap (iPhone only grants sensor access in response to one). Resolves to true if listening. */
export async function startSensors() {
  if (sensor.on) return true;
  if (typeof DeviceOrientationEvent === 'undefined') return false;
  try {
    const asks = [DeviceOrientationEvent, typeof DeviceMotionEvent === 'undefined' ? null : DeviceMotionEvent]
      .filter((E) => E && typeof E.requestPermission === 'function')
      .map((E) => E.requestPermission()); // both requested before any await, while the tap still counts
    if ((await Promise.all(asks)).some((answer) => answer !== 'granted')) return false;
  } catch {
    return false;
  }
  Object.assign(sensor, { on: true, available: false, lean: null, g: null, maxLeft: 0, maxRight: 0, maxG: 0 });
  zero = null;
  window.addEventListener('deviceorientation', onOrientation);
  window.addEventListener('devicemotion', onMotion);
  return true;
}

/** Stops listening and returns the peaks recorded, or nulls if the sensors never reported. */
export function stopSensors() {
  window.removeEventListener('deviceorientation', onOrientation);
  window.removeEventListener('devicemotion', onMotion);
  const had = sensor.available;
  sensor.on = false;
  const r1 = (n) => Math.round(n * 10) / 10;
  return had
    ? { maxLeanLeft: r1(sensor.maxLeft), maxLeanRight: r1(sensor.maxRight), maxG: Math.round(sensor.maxG * 100) / 100 }
    : { maxLeanLeft: null, maxLeanRight: null, maxG: null };
}

/** Treat the current position as upright (use when the bike is standing straight). */
export function recalibrate() {
  zero = null;
  Object.assign(sensor, { lean: null, maxLeft: 0, maxRight: 0 });
}

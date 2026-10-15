/**
 * Per-step timings of one request: lap(name) closes a step. Attached to a result with withTiming (not part of
 * the JSON body) and sent as a Server-Timing header — e.g. "qr;dur=180;desc=…, provider;dur=950, db;dur=40, total;dur=1170".
 */
export function stopwatch() {
  const start = performance.now();
  let last = start;
  const steps = [];
  return {
    lap(name, desc) {
      const now = performance.now();
      steps.push({ name, desc, dur: Math.round(now - last) });
      last = now;
    },
    get ms() {
      return { ...Object.fromEntries(steps.map((s) => [s.name, s.dur])), total: Math.round(last - start) };
    },
    get header() {
      return [...steps.map((s) => `${s.name};dur=${s.dur}${s.desc ? `;desc="${encodeURIComponent(s.desc)}"` : ''}`), `total;dur=${Math.round(last - start)}`].join(', ');
    },
  };
}

const TIMING = Symbol('timing');

/** The result, carrying the timings for the route (JSON.stringify skips symbol keys — the body is unchanged). */
export function withTiming(out, time) {
  if (time) Object.defineProperty(out, TIMING, { value: time, enumerable: false });
  return out;
}

export const timingOf = (out) => (out && typeof out === 'object' ? out[TIMING] : undefined);

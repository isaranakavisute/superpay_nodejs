import jsQR from 'jsqr';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * Does the image contain QR finder patterns (the three corner squares, dark:light:dark:light:dark
 * = 1:1:3:1:1 across and down) even though it did not decode? Lets us tell "something that looks
 * like a QR but is not a real one" (typical of an edited / generated fake slip) from "no QR at all".
 */
export function hasQrFinderPatterns(img) {
  const { width: w, height: h, data } = img;
  if (!w || !h) return false;
  const lum = (x, y) => { const i = (y * w + x) * 4; return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000; };
  let sum = 0, n = 0;
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) { sum += lum(x, y); n++; }
  const threshold = Math.min(sum / n, 160);
  const dark = (x, y) => lum(x, y) < threshold;
  const fits = (runs) => {
    const total = runs.reduce((a, r) => a + r, 0);
    if (total < 7) return false;
    const m = total / 7, tol = m * 0.6;
    return Math.abs(runs[0] - m) < tol && Math.abs(runs[1] - m) < tol && Math.abs(runs[2] - 3 * m) < 3 * tol && Math.abs(runs[3] - m) < tol && Math.abs(runs[4] - m) < tol;
  };
  // Column runs through (cx, cy): the same 1:1:3:1:1 must hold vertically.
  const verticalFits = (cx, cy, size) => {
    if (!dark(cx, cy)) return false;
    const runs = [0, 0, 0, 0, 0];
    let y = cy;
    while (y >= 0 && dark(cx, y)) { runs[2]++; y--; }
    for (const [k, want] of [[1, false], [0, true]]) while (y >= 0 && dark(cx, y) === want && runs[k] <= size) { runs[k]++; y--; }
    y = cy + 1;
    while (y < h && dark(cx, y)) { runs[2]++; y++; }
    for (const [k, want] of [[3, false], [4, true]]) while (y < h && dark(cx, y) === want && runs[k] <= size) { runs[k]++; y++; }
    return fits(runs);
  };
  const centers = [];
  for (let y = 0; y < h; y += 2) {
    const runs = [];
    let cur = dark(0, y), len = 0, startX = 0;
    const starts = [];
    for (let x = 0; x <= w; x++) {
      const d = x < w ? dark(x, y) : !cur;
      if (d === cur) { len++; continue; }
      runs.push({ dark: cur, len }); starts.push(startX);
      cur = d; len = 1; startX = x;
    }
    for (let i = 0; i + 4 < runs.length; i++) {
      if (!runs[i].dark) continue;
      const five = runs.slice(i, i + 5).map((r) => r.len);
      if (!fits(five)) continue;
      const size = five.reduce((a, r) => a + r, 0);
      const cx = Math.round(starts[i + 2] + runs[i + 2].len / 2);
      if (verticalFits(cx, y, size)) centers.push({ x: cx, y, size });
    }
  }
  // Group hits of the same square; a QR has three squares of about the same size.
  const groups = [];
  for (const c of centers) {
    const g = groups.find((q) => Math.abs(q.x - c.x) < q.size / 2 && Math.abs(q.y - c.y) < q.size / 2);
    if (g) g.hits++; else groups.push({ ...c, hits: 1 });
  }
  const squares = groups.filter((g) => g.hits >= 2);
  return squares.some((a) => squares.filter((b) => b !== a && Math.abs(b.size - a.size) < a.size * 0.5).length >= 2);
}

/** Half-size copy (2×2 average) — a phone screenshot's QR is still several pixels per module after it. */
function half({ width, height, data }) {
  const w = width >> 1, h = height >> 1, out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = (2 * y * width + 2 * x) * 4, b = a + width * 4, o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) out[o + k] = (data[a + k] + data[a + 4 + k] + data[b + k] + data[b + 4 + k]) >> 2;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

const BIG = 1_200_000; // pixels: above this, try a half-size scan first

/**
 * The QR text of a slip image (null for WebP / no QR) and whether it has QR-like corner squares that did not decode.
 * Cheapest first: half size (large images), then full size dark-on-light, then inverted (dark mode) — the first hit
 * wins, so a normal slip costs one scan instead of jsQR's default two passes. ('invertFirst', not 'onlyInvert': jsQR
 * never builds the inverted image for 'onlyInvert' and throws.)
 */
export function readQr(buf, mime) {
  const img = mime === 'image/png' ? PNG.sync.read(buf) : mime === 'image/jpeg' ? jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 }) : null;
  if (!img) return { qr: null, qrLike: false };
  const px = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length);
  // jsQR throws on some images (a known bug in its locator): that attempt counts as "no QR".
  const scan = (i, inversionAttempts) => {
    try { return jsQR(i.data, i.width, i.height, { inversionAttempts })?.data?.trim() || null; } catch { return null; }
  };
  const full = { width: img.width, height: img.height, data: px };
  const qr = (img.width * img.height > BIG ? scan(half(full), 'dontInvert') : null) ?? scan(full, 'dontInvert') ?? scan(full, 'invertFirst');
  return { qr, qrLike: qr ? false : hasQrFinderPatterns(img) };
}

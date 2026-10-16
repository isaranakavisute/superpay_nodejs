import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { createWorker } from 'tesseract.js';
import logger from '../logger.js';

/**
 * Finds an Option Pay TXN number printed anywhere in an image (e.g. a screenshot with "TXN172919" typed in it).
 * Small, compressed photos and light-on-dark text are common, so the image is enlarged and read twice — as is and
 * inverted — by an English reader that only knows the characters T, X, N and 0–9.
 */
const LANG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/ocr');
const MAX_SIDE = 2400;

let worker = null;
function getWorker() {
  worker ??= createWorker('eng', 1, {
    langPath: LANG_DIR, gzip: false, cacheMethod: 'none', logger: () => {},
    errorHandler: (err) => logger.warn({ err: String(err?.message ?? err) }, 'TXN OCR worker error'),
  })
    .then(async (w) => {
      await w.setParameters({ tessedit_char_whitelist: 'TXNtxn0123456789 -:#', tessedit_pageseg_mode: '11' });
      return w;
    })
    .catch((err) => { worker = null; throw err; });
  return worker;
}

function decode(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) { const p = PNG.sync.read(buf); return { width: p.width, height: p.height, data: p.data }; }
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 });
  return null; // e.g. WebP: read as is
}

/** Grey, optionally inverted, enlarged (bilinear) so small text has enough pixels; PNG for the OCR engine. */
function variant(img, scale, invert) {
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const png = new PNG({ width: w, height: h });
  const grey = (x, y) => {
    const i = (y * img.width + x) * 4;
    return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  };
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, (y + 0.5) / scale - 0.5);
    const y0 = Math.max(0, Math.floor(sy)); const y1 = Math.min(img.height - 1, y0 + 1); const fy = Math.max(0, sy - y0);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, (x + 0.5) / scale - 0.5);
      const x0 = Math.max(0, Math.floor(sx)); const x1 = Math.min(img.width - 1, x0 + 1); const fx = Math.max(0, sx - x0);
      let v = (grey(x0, y0) * (1 - fx) + grey(x1, y0) * fx) * (1 - fy) + (grey(x0, y1) * (1 - fx) + grey(x1, y1) * fx) * fy;
      if (invert) v = 255 - v;
      const o = (y * w + x) * 4;
      png.data[o] = png.data[o + 1] = png.data[o + 2] = v; png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** All text the TXN reader sees in the image (both variants joined); '' when it can't be read. */
export async function readTxnText(buf) {
  const w = await getWorker();
  let inputs = [buf];
  try {
    const img = decode(buf);
    if (img) {
      const scale = Math.max(1, Math.min(3, MAX_SIDE / Math.max(img.width, img.height)));
      inputs = [variant(img, scale, false), variant(img, scale, true)];
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'TXN OCR: could not prepare the image');
  }
  const texts = [];
  for (const input of inputs) texts.push((await w.recognize(input)).data.text);
  return texts.join('\n');
}

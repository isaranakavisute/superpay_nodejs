// Worker thread: decodes slip images and reads their QR off the request thread (see slip-fingerprint.js).
import { parentPort } from 'node:worker_threads';
import { readQr } from './slip-qr.js';

parentPort.on('message', ({ id, buf, mime }) => {
  try {
    parentPort.postMessage({ id, ...readQr(Buffer.from(buf), mime) });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});

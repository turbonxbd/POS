/**
 * media-service.js - image storage for product / category / brand / logo images.
 *
 * Images are downscaled on the client (canvas) to keep them small, then stored
 * in a dedicated localStorage bucket keyed by id. The DB only ever holds an
 * `imageId` reference, so structured data stays fast to parse. In 'rest' mode
 * this becomes multipart upload to an object store and getUrl() returns a CDN
 * URL - callers are unaffected.
 */
import config from '../config.js';
import http from '../core/http.js';
import { uuid } from '../utils/id.js';
import { readFileAsDataUrl } from '../utils/csv.js';
import bus from '../core/event-bus.js';

const KEY = 'afia_pos_media_v1';
const MAX_DIM = 480;
const QUALITY = 0.72;

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}
function saveStore(store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch (err) {
    bus.emit('db:quota-exceeded', err);
    throw new Error('Not enough local storage to save this image. Try a smaller file or reset demo data.');
  }
}

async function downscale(dataUrl) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  let { width, height } = img;
  if (width > MAX_DIM || height > MAX_DIM) {
    const scale = MAX_DIM / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', QUALITY);
}

export const mediaService = {
  async upload(file) {
    if (!file || !file.type.startsWith('image/')) throw new Error('Please choose an image file.');
    const raw = await readFileAsDataUrl(file);
    const optimised = await downscale(raw).catch(() => raw);

    if (config.api.mode === 'rest') {
      // Downscaled client-side, then stored server-side (Hostinger MySQL `media`).
      const { id, url } = await http.post('/media', { dataUrl: optimised });
      return { id, url };
    }

    const id = 'img_' + uuid();
    const store = loadStore();
    store[id] = optimised;
    saveStore(store);
    return { id, url: optimised };
  },

  getUrl(id) {
    if (!id) return null;
    if (config.api.mode === 'rest') return `${config.api.baseUrl}/media/${id}`;
    return loadStore()[id] || null;
  },

  remove(id) {
    if (!id) return;
    const store = loadStore();
    delete store[id];
    saveStore(store);
  },

  /** Remove media not referenced by any collection (housekeeping). */
  gc(referencedIds) {
    const store = loadStore();
    const ref = new Set(referencedIds);
    let removed = 0;
    for (const id of Object.keys(store)) {
      if (!ref.has(id)) {
        delete store[id];
        removed++;
      }
    }
    saveStore(store);
    return removed;
  },

  clear() {
    localStorage.removeItem(KEY);
  },
};

export default mediaService;

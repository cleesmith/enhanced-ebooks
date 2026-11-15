import { configure, ZipReader, BlobReader, BlobWriter } from './foliate/vendor/zip.js';

configure({ useWebWorkers:false });
const mimeTypes = { jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp' };

async function matchesCover(blob, expected) {
  if (blob.size > 50 * 1024 * 1024) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') === expected;
}

export async function availableCover(imageURL, bytes) {
  try {
    const response = await fetch(imageURL, { method:'HEAD', cache:'no-cache' });
    const type = response.headers.get('content-type') || '';
    const size = response.headers.get('content-length');
    return response.ok && /^(image\/|application\/octet-stream)/i.test(type)
      && (!size || !bytes || Number(size) === bytes);
  } catch { return false; }
}

export async function loadCover(epubURL, cover) {
  const type = mimeTypes[cover.extension];
  if (!type || !/^[a-f0-9]{64}$/.test(cover.sha256) || typeof cover.entry !== 'string') throw new Error('This cover listing needs to be refreshed.');
  let response;
  try { response = await fetch(epubURL, { cache:'no-cache' }); }
  catch { throw new Error('The cover could not be loaded. Please try again.'); }
  if (!response.ok) throw new Error('The cover and its EPUB are unavailable. Refresh the page and try again.');
  const reader = new ZipReader(new BlobReader(await response.blob()));
  try {
    const entry = (await reader.getEntries()).find(item => !item.directory && item.filename === cover.entry);
    if (!entry || entry.uncompressedSize > 50 * 1024 * 1024) throw new Error('This cover listing needs to be refreshed.');
    const blob = await entry.getData(new BlobWriter(type));
    if (!await matchesCover(blob, cover.sha256)) throw new Error('The EPUB has changed. Its download list needs to be refreshed.');
    return blob;
  } finally { await reader.close(); }
}

export function saveLink(url, name) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

export function saveCover(blob, name) {
  const url = URL.createObjectURL(blob);
  saveLink(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

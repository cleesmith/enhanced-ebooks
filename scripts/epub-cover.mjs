import { TextWriter, BlobWriter } from '../epub-reader/foliate/vendor/zip.js';

const decodeXML = text => text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (all, entity) => {
  if (entity[0] !== '#') return ({ amp:'&', quot:'"', apos:"'", lt:'<', gt:'>' })[entity] ?? all;
  const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : all;
});

// Read only start-tag attributes; do not interpret DTDs, scripts or external entities.
function tags(xml, name) {
  xml = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const pattern = new RegExp('<(?:[\\w.-]+:)?' + name + '(?=[\\s/>])((?:[^>"\']|"[^"]*"|\'[^\']*\')*)>', 'g');
  return [...xml.matchAll(pattern)].map(match => Object.fromEntries([...match[1].matchAll(/([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g)].map(([, key, value]) => [key, decodeXML(value.slice(1, -1))])));
}

function resolveEntry(href, from) {
  if (!href) return null;
  try {
    const base = new URL(from.split('/').map(encodeURIComponent).join('/'), 'https://epub.invalid/');
    const url = new URL(href, base);
    if (url.origin !== base.origin || url.search) return null;
    return decodeURIComponent(url.pathname).slice(1);
  } catch { return null; }
}

function imageExtension(data) {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString())) return 'gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

export async function extractCover(files, opfPath) {
  const packageEntry = files.get(opfPath);
  if (packageEntry.uncompressedSize > 4 * 1024 * 1024) return null;
  const xml = await packageEntry.getData(new TextWriter());
  const items = tags(xml, 'item');
  const legacyID = tags(xml, 'meta').find(item => item.name === 'cover')?.content;
  const candidates = [
    ...items.filter(item => (item.properties || '').split(/\s+/).includes('cover-image')),
    ...items.filter(item => legacyID && item.id === legacyID),
    ...tags(xml, 'reference').filter(item => (item.type || '').split(/\s+/).includes('cover')),
  ];
  async function readImage(file) {
    const entry = files.get(file);
    if (!entry || entry.uncompressedSize > 50 * 1024 * 1024) return null;
    const data = Buffer.from(await (await entry.getData(new BlobWriter())).arrayBuffer());
    const extension = imageExtension(data);
    return extension ? { data, extension, entry:file } : null;
  }
  for (const candidate of candidates) {
    const file = resolveEntry(candidate.href, opfPath);
    if (!file || !files.has(file)) continue;
    const direct = await readImage(file);
    if (direct) return direct;
    // Some older EPUBs identify a cover page with one image, or an SVG wrapper.
    const entry = files.get(file);
    if (entry.uncompressedSize > 1024 * 1024 || !(/\.(xhtml|html|svg)$/i.test(file) || /(?:xhtml|svg)\+xml/.test(candidate['media-type'] || ''))) continue;
    const page = await entry.getData(new TextWriter());
    const refs = [...tags(page, 'img').map(item => item.src), ...tags(page, 'image').map(item => item.href || item['xlink:href'])];
    const images = [...new Set(refs.map(ref => resolveEntry(ref, file)).filter(Boolean))];
    if (images.length === 1) {
      const image = await readImage(images[0]);
      if (image) return image;
    }
  }
  return null;
}

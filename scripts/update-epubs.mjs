import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { configure, ZipReader, BlobReader, TextWriter } from '../epub-reader/foliate/vendor/zip.js';
import { extractCover } from './epub-cover.mjs';

configure({ useWebWorkers:false });
const base = new URL('https://bookshelf.invalid/');
const encodePath = value => value.split('/').map(encodeURIComponent).join('/');

export function readBooks(html) {
  const match = html.match(/\bconst\s+BOOKS\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!match || !/id=["']grid["']/.test(html)) throw new Error('Run this command from your enhanced-ebooks folder (the one containing its index.html).');
  let books;
  try { books = JSON.parse(vm.runInNewContext('JSON.stringify(' + match[1] + ')', Object.create(null), { timeout:500, contextCodeGeneration:{ strings:false, wasm:false } })); }
  catch { throw new Error('Could not read the BOOKS list in index.html. No files were changed.'); }
  if (!Array.isArray(books)) throw new Error('BOOKS must be a list.');
  return books;
}

function localRelative(value) {
  const url = new URL(value, base);
  if (url.origin !== base.origin || url.search || url.hash) return null;
  const relative = decodeURIComponent(url.pathname).slice(1);
  if (relative.includes('\\') || relative.split('/').some(part => part === '..' || part.startsWith('.'))) throw new Error('Use ordinary local book folders for downloads.');
  return relative;
}

export async function assertLocalFile(root, relative) {
  const absolute = path.resolve(root, relative);
  const realRoot = await fs.realpath(root);
  const real = await fs.realpath(absolute);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('A book path points outside this repository: ' + relative);
  return absolute;
}

async function inspectEpub(root, relative, wantCover) {
  const absolute = await assertLocalFile(root, relative);
  const data = await fs.readFile(absolute);
  const reader = new ZipReader(new BlobReader(new Blob([data])));
  try {
    const entries = await reader.getEntries();
    const files = new Map(entries.filter(entry => !entry.directory).map(entry => [entry.filename, entry]));
    const type = files.get('mimetype');
    if (!type || type.uncompressedSize > 100 || (await type.getData(new TextWriter())).trim() !== 'application/epub+zip') throw new Error('not an EPUB file');
    const container = files.get('META-INF/container.xml');
    if (!container || container.uncompressedSize > 1024 * 1024) throw new Error('missing EPUB container');
    const xml = await container.getData(new TextWriter());
    const opf = xml.match(/\bfull-path\s*=\s*["']([^"']+)["']/)?.[1]?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    if (!opf || !files.has(opf)) throw new Error('missing EPUB package');
    const authors = entries.some(entry => /^(?:META-INF\/ee-paperback\/|OEBPS\/nomatter\/|OEBPS\/meta\.json$|OEBPS\/css\/visual-narrative\.css$)/i.test(entry.filename));
    let cover = null;
    let coverWarning;
    if (!authors && wantCover) {
      try { cover = await extractCover(files, opf); }
      catch { coverWarning = 'Could not extract the embedded cover from ' + relative; }
      if (!cover && !coverWarning) coverWarning = 'No standalone cover image identified in ' + relative;
    }
    return { authors, bytes:data.length, cover, coverWarning };
  } catch (error) { throw new Error(relative + ': ' + error.message); }
  finally { await reader.close(); }
}

export async function collectEpubs(root, html) {
  const books = readBooks(html);
  const catalogue = { version:2, books:{} };
  const messages = [];
  const generated = [];
  for (const book of books) {
    if (!book.read) continue;
    const relative = localRelative(book.read);
    if (relative === null) continue;
    const directory = relative.endsWith('/') ? relative.slice(0, -1) : path.posix.dirname(relative);
    const key = directory === '.' ? '' : directory;
    const absolute = await assertLocalFile(root, key || '.');
    const children = await fs.readdir(absolute, { withFileTypes:true });
    const filenames = children.filter(entry => entry.isFile()).map(entry => entry.name).sort();
    const coverNames = filenames.filter(name => /-epub-cover\.(jpe?g|png|gif|webp)$/i.test(name));
    let candidates;
    if (book.epub) {
      const selected = localRelative(book.epub);
      if (selected === null || !/\.epub$/i.test(selected)) throw new Error('The epub entry for ' + book.title + ' must name a local .epub file.');
      candidates = [selected];
    } else {
      candidates = filenames.filter(name => /\.epub$/i.test(name)).map(name => path.posix.join(key, name));
    }
    const usable = [];
    for (const file of candidates) {
      const result = await inspectEpub(root, file, !coverNames.length);
      if (result.authors) {
        if (book.epub) throw new Error(file + ' is an Authors EPUB. Select the Booksellers export instead.');
        messages.push('Skipped Authors EPUB: ' + file + ' — use the Booksellers export.');
      } else {
        if (result.coverWarning) messages.push(result.coverWarning + ' — the EPUB is still available.');
        usable.push({ file:encodePath(file), bytes:result.bytes, cover:result.cover });
      }
    }
    if (usable.length > 1) throw new Error('More than one Booksellers EPUB in ' + (key || '.') + '. Keep one, or add epub: \'folder/filename.epub\' to this book in BOOKS.');
    const pdfs = filenames.filter(name => /\.pdf$/i.test(name) && !/-pdf-cover\.pdf$/i.test(name));
    // A cover by itself does not count as a downloadable book.
    if (!usable.length && !pdfs.length) continue;
    const downloads = usable.map(({ file, bytes }) => ({ file, bytes, name:path.posix.basename(decodeURIComponent(file)), kind:'epub' }));
    if (usable[0]?.cover) {
      const { data, extension, entry } = usable[0].cover;
      const stem = path.posix.basename(decodeURIComponent(usable[0].file)).replace(/\.epub$/i, '').replace(/-booksellers$/i, '');
      const name = stem + '-epub-cover.' + extension;
      const digest = createHash('sha256').update(data).digest('hex');
      const file = path.posix.join('epub-reader/covers', digest, name);
      generated.push({ file, data });
      downloads.push({ file:encodePath(file), name, kind:'epub-cover', bytes:data.length, embeddedCover:{ epub:usable[0].file, entry, extension, sha256:digest } });
      messages.push('Extracted cover: ' + name);
    }
    const groups = [
      ['epub-cover', coverNames],
      ['pdf', pdfs],
      ['pdf-cover', filenames.filter(name => /-pdf-cover\.(pdf|png)$/i.test(name))],
    ];
    for (const [kind, names] of groups) for (const name of names) {
      const relativeFile = path.posix.join(key, name);
      const local = await assertLocalFile(root, relativeFile);
      downloads.push({ file:encodePath(relativeFile), name, kind, bytes:(await fs.stat(local)).size });
    }
    catalogue.books[key] = { ...(usable[0] ? { file:usable[0].file, bytes:usable[0].bytes } : {}), downloads };
    messages.push(book.title + ': ' + downloads.map(item => item.name).join(', '));
  }
  await validateGenerated(root, generated);
  return { catalogue, messages, generated };
}

async function validateGenerated(root, generated) {
  for (const item of generated) {
    let current = root;
    for (const part of item.file.split('/')) {
      current = path.join(current, part);
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Generated cover path must not be a symbolic link: ' + item.file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { if (!(await fs.readFile(current)).equals(item.data)) throw new Error('An extracted cover was edited: ' + item.file + '. Move your custom image into the book folder using the -epub-cover suffix.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function writeCatalogue(root, catalogue, generated = []) {
  await validateGenerated(root, generated);
  for (const item of generated) {
    const target = path.join(root, item.file);
    await fs.mkdir(path.dirname(target), { recursive:true });
    try { await fs.writeFile(target, item.data, { flag:'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const file = path.join(root, 'bookseller-epubs.json');
  const content = JSON.stringify(catalogue, null, 2) + '\n';
  let previous;
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('bookseller-epubs.json must not be a symbolic link.');
    previous = await fs.readFile(file, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== content) {
    const temp = file + '.tmp-' + process.pid;
    try { await fs.writeFile(temp, content, { flag:'wx' }); await fs.rename(temp, file); }
    finally { await fs.rm(temp, { force:true }); }
  }
}

export async function updateDownloads() {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: node scripts/update-downloads.mjs [--check]');
    const root = process.cwd();
    const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
    const { catalogue, messages, generated } = await collectEpubs(root, html);
    const checking = process.argv.includes('--check');
    if (!checking) await writeCatalogue(root, catalogue, generated);
    for (const message of messages) console.log(message);
    console.log(Object.keys(catalogue.books).length + ' book(s) with downloads. ' + (checking ? 'No files changed.' : 'Download links updated.'));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await updateDownloads();

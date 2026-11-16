const $ = id => document.getElementById(id);
const siteRoot = new URL('../', import.meta.url);
let view, currentIndex = 0, storageKey, saveTimer;
let theme = 'dark', fontSize = 18, ready = false;
const getSaved = key => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
theme = getSaved('ee-theme') === 'light' ? 'light' : 'dark';
fontSize = Math.min(32, Math.max(12, Number(getSaved('ee-epub-font-size')) || 18));

function applyAppearance() {
  document.documentElement.classList.toggle('light', theme === 'light');
  $('theme').textContent = theme === 'light' ? '\uD83C\uDF19' : '\u2600\uFE0F';
  const themeLabel = 'Switch to ' + (theme === 'light' ? 'dark' : 'light') + ' theme';
  $('theme').setAttribute('aria-label', themeLabel);
  $('theme').title = themeLabel;
  const bg = theme === 'light' ? '#faf8f5' : '#161513';
  const fg = theme === 'light' ? '#26231f' : '#ece9e4';
  const link = theme === 'light' ? '#855027' : '#e2b993';
  view?.renderer?.setStyles?.(`
    html { font-size:${fontSize}px !important; color-scheme:${theme}; }
    html, body { background:${bg} !important; color:${fg} !important; }
    body { font-size:1rem !important; }
    p, li, blockquote, dd { line-height:1.6 !important; }
    a[href] { color:${link} !important; }
    img, svg, video { max-width:100%; }
    pre { white-space:pre-wrap !important; }
  `);
  $('smaller').disabled = !ready || view?.isFixedLayout || fontSize <= 12;
  $('larger').disabled = !ready || view?.isFixedLayout || fontSize >= 32;
}
applyAppearance();
$('theme').addEventListener('click', () => {
  theme = theme === 'light' ? 'dark' : 'light';
  save('ee-theme', theme);
  applyAppearance();
});
for (const [id, delta] of [['smaller', -2], ['larger', 2]]) $('' + id).addEventListener('click', () => {
  fontSize = Math.max(12, Math.min(32, fontSize + delta));
  save('ee-epub-font-size', String(fontSize));
  applyAppearance();
});

function neighbour(delta) {
  const sections = view?.book?.sections || [];
  for (let i = currentIndex + delta; i >= 0 && i < sections.length; i += delta) {
    if (sections[i].linear !== 'no') return i;
  }
  return null;
}
function updateNavigation() {
  $('previous').disabled = !ready || neighbour(-1) === null;
  $('next').disabled = !ready || neighbour(1) === null;
}
async function changeSection(delta) {
  const index = neighbour(delta);
  if (ready && index !== null) await view.goTo(index);
}
$('previous').addEventListener('click', () => changeSection(-1));
$('next').addEventListener('click', () => changeSection(1));
function onKey(event) {
  if (!ready || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || $('toc-dialog').open) return;
  if (event.target.closest?.('input, select, textarea, button, a, [contenteditable="true"]')) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    changeSection(event.key === 'ArrowLeft' ? -1 : 1);
  }
}
document.addEventListener('keydown', onKey);
$('contents').addEventListener('click', () => $('toc-dialog').showModal());
$('close-toc').addEventListener('click', () => $('toc-dialog').close());
$('toc-dialog').addEventListener('click', event => {
  const box = $('toc-dialog').getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('toc-dialog').close();
});

function languageText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return Object.values(value).find(x => typeof x === 'string') || '';
  return '';
}
function makeContents(items) {
  const list = document.createElement('ol');
  for (const item of items) {
    const li = document.createElement('li');
    const label = document.createElement(item.href != null ? 'button' : 'span');
    label.textContent = languageText(item.label) || 'Untitled section';
    if (item.href != null) {
      label.dataset.href = String(item.href);
      label.addEventListener('click', async () => {
        $('toc-dialog').close();
        await view.goTo(item.href);
      });
    }
    li.append(label);
    if (item.subitems?.length) li.append(makeContents(item.subitems));
    list.append(li);
  }
  return list;
}

// EPUB files remain unchanged on disk and when downloaded. Only the displayed
// documents have active content removed. Images, text, links and styles remain.
function cleanDocument(data, type) {
  const doc = new DOMParser().parseFromString(data, type);
  if (doc.querySelector('parsererror')) throw new Error('This EPUB contains an unreadable chapter.');
  doc.querySelectorAll('script, iframe, object, embed, base, meta[http-equiv]').forEach(el => el.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name) || attr.name === 'srcdoc' || (/^(?:href|xlink:href|action|formaction)$/i.test(attr.name) && /^\s*(?:javascript|vbscript):/i.test(attr.value))) el.removeAttributeNode(attr);
    }
  }
  return new XMLSerializer().serializeToString(doc);
}

async function openBook() {
  const requested = new URLSearchParams(location.search).get('book');
  if (!requested) throw new Error('Choose Read EPUB beneath a book on the bookshelf.');
  const url = new URL(requested, siteRoot);
  const decoded = decodeURIComponent(url.pathname);
  if (url.origin !== siteRoot.origin || !url.pathname.startsWith(siteRoot.pathname) || !/\.epub$/i.test(decoded) || decoded.split('/').some(part => part === '..') || decoded.includes('\\')) {
    throw new Error('Choose an EPUB from this bookshelf.');
  }
  await import('./foliate/view.js');
  const response = await fetch(url, { cache:'no-cache' });
  if (!response.ok) throw new Error(response.status === 404 ? 'This EPUB is not available yet.' : 'The EPUB could not be downloaded. Please try again.');
  const blob = await response.blob();
  const filename = decoded.split('/').pop();
  $('download').href = url.href;
  $('download').download = filename;
  $('download').hidden = false;
  storageKey = 'ee-epub-position:' + url.pathname + ':' + blob.size;
  view = document.createElement('foliate-view');
  $('reading-area').append(view);
  view.addEventListener('load', ({ detail: { doc, index } }) => {
    currentIndex = index;
    doc.addEventListener('keydown', onKey);
    updateNavigation();
  });
  view.addEventListener('external-link', event => {
    event.preventDefault();
    try {
      const external = new URL(event.detail.href);
      if (['http:', 'https:', 'mailto:'].includes(external.protocol)) window.open(external.href, '_blank', 'noopener,noreferrer');
    } catch {}
  });
  view.addEventListener('relocate', ({ detail }) => {
    $('chapter').textContent = detail.tocItem?.label || '';
    $('percent').textContent = Number.isFinite(detail.fraction) ? Math.round(detail.fraction * 100) + '%' : '';
    for (const button of $('toc').querySelectorAll('button[data-href]')) {
      if (button.dataset.href === detail.tocItem?.href) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
    if (detail.cfi) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => save(storageKey, detail.cfi), 150);
    }
  });
  await view.open(new File([blob], filename, { type:'application/epub+zip' }));
  const { book } = view;
  if (!book.sections?.length) throw new Error('This EPUB has no readable chapters.');
  book.transformTarget?.addEventListener('data', ({ detail }) => {
    if (/javascript|ecmascript/.test(detail.type)) detail.data = '';
    else if (['application/xhtml+xml', 'text/html', 'image/svg+xml'].includes(detail.type)) {
      detail.data = Promise.resolve(detail.data).then(data => cleanDocument(data, detail.type));
    }
  });
  const title = languageText(book.metadata?.title) || filename.replace(/\.epub$/i, '');
  $('book-title').textContent = title;
  $('book-title').title = title;
  document.title = title + ' · Read EPUB';
  const contents = book.toc?.length ? book.toc : book.sections.map((section, i) => ({ label:'Section ' + (i + 1), href:i }));
  $('toc').append(makeContents(contents));
  $('contents').disabled = false;
  view.renderer.setAttribute('max-inline-size', '900px');
  view.renderer.setAttribute('margin-left', '16px');
  view.renderer.setAttribute('margin-right', '16px');
  applyAppearance();
  const lastLocation = getSaved(storageKey);
  try { await view.init({ lastLocation }); }
  catch { await view.goTo(0); }
  ready = true;
  $('status').hidden = true;
  applyAppearance();
  updateNavigation();
}
window.addEventListener('pagehide', () => {
  if (storageKey && view?.lastLocation?.cfi) save(storageKey, view.lastLocation.cfi);
});
openBook().catch(error => {
  console.error(error);
  ready = false;
  if (view) { try { view.close(); } catch {} view.remove(); }
  $('status').hidden = false;
  $('status').textContent = 'Could not open EPUB. ' + (error.message || 'Please try again.');
  $('contents').disabled = true;
  updateNavigation();
  applyAppearance();
});


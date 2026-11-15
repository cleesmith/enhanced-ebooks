/* Adds EPUB reading and a popup with individual book/cover downloads. */
(() => {
  const root = new URL('../', document.currentScript.src);
  const icon = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 2.5h4c1 0 2 .6 2 1.5 0-.9 1-1.5 2-1.5h4v11h-4c-1 0-2 .5-2 1-0-0.5-1-1-2-1H2zM8 4v10"/></svg>';
  const downloadIcon = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1v9M4.5 6.5 8 10l3.5-3.5M2 10v4h12v-4"/></svg>';
  let dialog;
  function localURL(file) {
    try {
      const url = new URL(file, root);
      if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.search || url.hash) return null;
      return url;
    } catch { return null; }
  }
  function openDownloads(book, files) {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'downloads-dialog';
      dialog.setAttribute('aria-labelledby', 'ee-downloads-heading');
      dialog.setAttribute('aria-describedby', 'ee-downloads-book');
      dialog.innerHTML = '<div class="downloads-heading"><h2 id="ee-downloads-heading">Downloads</h2><button type="button" class="downloads-close">Close</button></div><p id="ee-downloads-book"></p><ul class="downloads-files"></ul>';
      dialog.querySelector('.downloads-close').addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const box = dialog.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
      });
      document.body.append(dialog);
      const status = document.createElement('p');
      status.className = 'downloads-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.hidden = true;
      dialog.append(status);
    }
    dialog.querySelector('#ee-downloads-book').textContent = book.title;
    const list = dialog.querySelector('.downloads-files');
    list.replaceChildren();
    const status = dialog.querySelector('.downloads-status');
    status.textContent = '';
    status.hidden = true;
    for (const file of files) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = file.url.href;
      a.download = decodeURIComponent(file.url.pathname.split('/').pop());
      a.setAttribute('aria-label', 'Download ' + a.download);
      a.innerHTML = downloadIcon;
      const name = document.createElement('span');
      name.textContent = a.download;
      a.append(name);
      if (file.embeddedCover) {
        let busy = false;
        a.addEventListener('click', async event => {
          event.preventDefault();
          if (busy) return;
          busy = true;
          a.setAttribute('aria-disabled', 'true');
          status.textContent = 'Preparing cover…';
          status.hidden = false;
          try {
            const { availableCover, loadCover, saveLink, saveCover } = await import(new URL('epub-reader/download-cover.mjs', root));
            if (await availableCover(file.url.href, file.bytes)) saveLink(file.url.href, a.download);
            else saveCover(await loadCover(file.epubURL.href, file.embeddedCover), a.download);
            if (a.isConnected) status.hidden = true;
          } catch (error) {
            if (a.isConnected) status.textContent = error.message || 'The cover could not be downloaded. Please try again.';
          } finally {
            busy = false;
            a.removeAttribute('aria-disabled');
          }
        });
      }
      li.append(a);
      list.append(li);
    }
    dialog.showModal();
  }
  async function addLinks() {
    if (typeof BOOKS === 'undefined') return;
    let books = {};
    try {
      const response = await fetch(new URL('bookseller-epubs.json', root), { cache:'no-cache' });
      if (response.ok) books = (await response.json()).books || {};
    } catch (error) { console.warn('Could not load the download list.', error); }
    const cards = document.querySelectorAll('#grid .book');
    BOOKS.forEach((book, index) => {
      const card = cards[index];
      if (!card || card.querySelector('.epub-opt, .downloads-opt')) return;
      let directory;
      try {
        const readingURL = new URL(book.read || '.', document.baseURI);
        if (readingURL.origin === root.origin && readingURL.pathname.startsWith(root.pathname)) {
          directory = decodeURIComponent(new URL('./', readingURL).pathname.slice(root.pathname.length)).replace(/\/$/, '');
        }
      } catch { return; }
      const entry = books[directory] || {};
      const file = book.epub || entry.file;
      const epub = file ? localURL(file) : null;
      const opts = card.querySelector('.opts');
      if (!opts) return;
      if (epub && /\.epub$/i.test(epub.pathname)) {
        const reader = new URL('epub-reader/', root);
        reader.searchParams.set('book', epub.pathname.slice(root.pathname.length));
        const a = document.createElement('a');
        a.className = 'opt epub-opt';
        a.href = reader.href;
        a.title = 'Read EPUB — ' + book.title + ' (Booksellers EPUB)';
        a.setAttribute('aria-label', a.title);
        a.innerHTML = icon;
        const span = document.createElement('span');
        span.textContent = 'Read EPUB';
        a.append(span);
        a.target = '_self';
        opts.append(a);
      }
      // Support the earlier catalogue as well, until its next refresh.
      const candidates = Array.isArray(entry.downloads) ? entry.downloads : (file ? [{ file, kind:'epub' }] : []);
      const seen = new Set();
      const downloads = candidates.flatMap(item => {
        const url = typeof item.file === 'string' ? localURL(item.file) : null;
        if (!url || !/\.(epub|pdf|jpe?g|png|gif|webp)$/i.test(url.pathname) || seen.has(url.href)) return [];
        seen.add(url.href);
        const epubURL = item.embeddedCover && typeof item.embeddedCover.epub === 'string' ? localURL(item.embeddedCover.epub) : null;
        const embeddedCover = item.kind === 'epub-cover' && epubURL && /\.epub$/i.test(epubURL.pathname) ? item.embeddedCover : null;
        return [{ url, kind:item.kind, bytes:item.bytes, embeddedCover, epubURL }];
      });
      if (!downloads.some(item => item.kind === 'epub' || item.kind === 'pdf')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'opt downloads-opt';
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-label', 'Downloads — ' + book.title);
      button.title = 'Downloads — ' + book.title;
      button.innerHTML = downloadIcon;
      const label = document.createElement('span');
      label.textContent = 'Downloads';
      button.append(label);
      button.addEventListener('click', () => openDownloads(book, downloads));
      opts.append(button);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addLinks, { once:true });
  else addLinks();
})();

// Pure helpers for the continuous book reader. The viewer keeps every source
// image separate for lazy decoding, but presents them inside one semantic strip
// so the lesson reads as a single long page without seams or page chrome.

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function localBookSource(value) {
  const source = String(value || '').trim().replace(/\\/g, '/');
  if (!source || source.includes('..') || /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//')) return '';
  if (source.startsWith('/')) return source.startsWith('/data/book/') ? source : '';
  return `data/book/${source.replace(/^\.\//, '')}`;
}

export function buildBookViewerModel(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry, sourceIndex) => ({
      entry,
      sourceIndex,
      src: localBookSource(entry?.src),
      page: Number.isFinite(Number(entry?.page)) ? Number(entry.page) : Number.MAX_SAFE_INTEGER,
    }))
    .filter(({ entry, src }) => src && (entry?.kind === 'image' || entry?.kind === 'page'))
    .sort((a, b) => a.page - b.page || a.src.localeCompare(b.src) || a.sourceIndex - b.sourceIndex)
    .map(({ entry, src, page }) => ({
      src,
      page: page === Number.MAX_SAFE_INTEGER ? null : page,
      kind: entry.kind,
    }));
}

export function renderBookViewerStrip(model) {
  const images = (Array.isArray(model) ? model : []).map((entry, index) => {
    const printedPage = entry.page == null ? '' : `, trang ${entry.page + 1}`;
    return `<img class="book-viewer-page" src="${escapeHtml(entry.src)}" alt="Phần ${index + 1} của trang sách liên tục${escapeHtml(printedPage)}" loading="lazy" decoding="async">`;
  }).join('');
  return `<figure class="book-viewer-strip" aria-label="Trang sách liên tục">${images}</figure>`;
}

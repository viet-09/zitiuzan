// One writing sheet for a whole kanji lesson, in the shape of a genkō-yōshi
// practice page: a row of squares per kanji, the model character first, faded
// tracing copies next, then blanks to write from memory.
//
// Only the first GUIDED_CELLS squares of each row check stroke order and
// direction (js/kanji-stroke-match.js). After that the learner is meant to be
// writing unaided, and having the sheet argue with them about a slightly wobbly
// stroke would turn drilling into a fight.
//
// Every square is its own small canvas. Pointer coordinates are scaled by the
// canvas's own bounding box, so zooming the page in to write comfortably keeps
// the ink under the pen at any magnification.

import { activateModalDialog } from './modal-dialog.js';
import { STROKE_FEEDBACK, matchStroke } from './kanji-stroke-match.js';
import { formatHanViet, hanVietOf, loadHanViet } from './kanji-hanviet.js';
import { clearSheet, decodeStroke, encodeStroke, loadSheet, saveSheet } from './kanji-sheet-store.js';

/** Squares per kanji: 1 model + traced + blank. */
export const SHEET_LAYOUT = Object.freeze({
  cells: 14,
  traced: 7,
  /** Only these many writable squares are stroke-checked. */
  guided: 3,
});

const CELL_PIXELS = 220;

let activeSheet = null;
let strokeDataPromise = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function loadStrokeData() {
  if (!strokeDataPromise) {
    strokeDataPromise = fetch('data/kanji-strokes.json')
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
  }
  return strokeDataPromise;
}

/** Sample an SVG path into a polyline in 0..1 character space. */
function samplePath(d, viewBox, count) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewBox} ${viewBox}`);
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  document.body.appendChild(svg);
  try {
    const total = path.getTotalLength();
    if (!Number.isFinite(total) || total <= 0) return [];
    return Array.from({ length: count }, (_, index) => {
      const point = path.getPointAtLength((total * index) / (count - 1));
      return { x: point.x / viewBox, y: point.y / viewBox };
    });
  } catch {
    return [];
  } finally {
    svg.remove();
  }
}

/**
 * Which squares of a row do what.
 * @param {number} index position in the row
 * @returns {'model'|'guided'|'traced'|'blank'}
 */
export function cellRole(index, layout = SHEET_LAYOUT) {
  if (index === 0) return 'model';
  if (index <= layout.guided) return 'guided';
  if (index <= layout.traced) return 'traced';
  return 'blank';
}

/** Open the sheet for a list of characters. */
export function openKanjiSheet({ characters = [], title = '', lessonId = '', trigger = null } = {}) {
  if (typeof document === 'undefined') return null;
  activeSheet?.close();

  const list = [...new Set(
    characters.flatMap((value) => [...String(value || '')]).filter((c) => /\p{Script=Han}/u.test(c)),
  )];
  if (!list.length) return null;

  const titleId = `kanji-sheet-title-${Date.now()}`;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay kanji-sheet-overlay active';
  overlay.innerHTML = `
    <section class="modal-card kanji-sheet-card" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <header class="modal-header">
        <div>
          <p class="profile-modal__eyebrow">TỜ LUYỆN VIẾT CẢ BÀI</p>
          <h2 id="${titleId}">Luyện viết${title ? ` · ${escapeHtml(title)}` : ''}</h2>
        </div>
        <button type="button" class="modal-close" data-sheet-action="close" aria-label="Đóng tờ luyện viết">×</button>
      </header>
      <div class="modal-body kanji-sheet-body">
        <p class="kanji-sheet-hint">
          ${list.length} chữ · ${SHEET_LAYOUT.guided} ô đầu mỗi dòng có kiểm tra thứ tự và chiều nét, các ô sau viết tự do.
          Phóng to trang để viết thoải mái hơn — nét vẫn bám theo bút.
        </p>
        <p class="kanji-sheet-status" data-sheet-status role="status" aria-live="polite"></p>
        <div class="kanji-sheet-rows" data-sheet-rows></div>
      </div>
      <footer class="modal-footer kanji-sheet-actions">
        <button type="button" class="profile-skip-btn" data-sheet-action="clear">Xóa cả tờ</button>
        <button type="button" class="complete-modal-btn" data-sheet-action="close">Xong</button>
      </footer>
    </section>`;
  document.body.appendChild(overlay);

  const rowsHost = overlay.querySelector('[data-sheet-rows]');
  const statusEl = overlay.querySelector('[data-sheet-status]');
  /** character -> ordered stroke polylines in 0..1 space. */
  const guides = new Map();
  /** canvas -> { character, role, strokes: [][], accepted: number } */
  const cells = new Map();
  let modalDialog = null;
  let closed = false;

  function setStatus(message, tone = '') {
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
  }

  rowsHost.innerHTML = list.map((character) => `
    <section class="kanji-sheet-row" data-sheet-row="${escapeHtml(character)}">
      <div class="kanji-sheet-label">
        <span class="kanji-sheet-char" lang="ja">${escapeHtml(character)}</span>
        <span class="kanji-sheet-hanviet" data-sheet-hanviet></span>
      </div>
      <div class="kanji-sheet-cells">
        ${Array.from({ length: SHEET_LAYOUT.cells }, (_, index) => {
          const role = cellRole(index);
          return role === 'model'
            ? `<div class="kanji-sheet-cell is-model" lang="ja" aria-hidden="true">${escapeHtml(character)}</div>`
            : `<canvas class="kanji-sheet-cell" data-role="${role}" data-char="${escapeHtml(character)}" data-index="${index}" width="${CELL_PIXELS}" height="${CELL_PIXELS}" aria-label="Ô viết ${escapeHtml(character)} số ${index}"></canvas>`;
        }).join('')}
      </div>
    </section>`).join('');

  // ---- drawing -------------------------------------------------------------

  const cellState = (canvas) => {
    if (!cells.has(canvas)) {
      cells.set(canvas, {
        character: canvas.dataset.char,
        role: canvas.dataset.role,
        index: Number(canvas.dataset.index),
        strokes: [],
        accepted: 0,
      });
    }
    return cells.get(canvas);
  };

  /** Everything drawn so far, in the compact shape the store persists. */
  function collectRows() {
    const rows = {};
    for (const [canvas, state] of cells) {
      if (!state.strokes.length) continue;
      const row = rows[state.character] || (rows[state.character] = {});
      row[state.index] = {
        s: state.strokes.map((stroke) => encodeStroke(stroke, canvas.width)),
        a: state.accepted,
      };
    }
    return rows;
  }

  // Written after every finished stroke rather than on close: the learner may
  // simply navigate away, and a sheet that only survives a tidy exit is a
  // sheet that mostly does not survive.
  const persist = () => { if (lessonId) saveSheet(lessonId, collectRows()); };

  /** Put a saved sheet back on the canvases. */
  function restore() {
    if (!lessonId) return 0;
    const saved = loadSheet(lessonId);
    if (!saved?.rows) return 0;
    let restored = 0;
    for (const canvas of overlay.querySelectorAll('canvas.kanji-sheet-cell')) {
      const state = cellState(canvas);
      const entry = saved.rows?.[state.character]?.[state.index];
      if (!entry || !Array.isArray(entry.s)) continue;
      state.strokes = entry.s.map((flat) => decodeStroke(flat, canvas.width));
      state.accepted = Math.max(0, Math.min(Number(entry.a) || 0, state.strokes.length));
      restored += state.strokes.length;
    }
    return restored;
  }

  function pointOf(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function paintCell(canvas) {
    const state = cellState(canvas);
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    const guide = guides.get(state.character);

    // Traced squares show the whole character; guided squares show only what
    // has not been written yet, so the next stroke is the visible one.
    if (guide && (state.role === 'traced' || state.role === 'guided')) {
      const upcoming = state.role === 'guided' ? guide.slice(state.accepted) : guide;
      context.save();
      context.strokeStyle = 'rgba(20, 18, 16, .16)';
      context.lineWidth = 5;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      for (const stroke of upcoming) {
        if (stroke.length < 2) continue;
        context.beginPath();
        context.moveTo(stroke[0].x * canvas.width, stroke[0].y * canvas.height);
        for (const point of stroke.slice(1)) context.lineTo(point.x * canvas.width, point.y * canvas.height);
        context.stroke();
      }
      context.restore();
    }

    context.save();
    context.strokeStyle = '#141210';
    context.lineWidth = 6;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const stroke of state.strokes) {
      if (!stroke.length) continue;
      context.beginPath();
      context.moveTo(stroke[0].x, stroke[0].y);
      for (const point of stroke.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
    context.restore();
  }

  let drawing = null;

  function onPointerDown(event) {
    const canvas = event.target.closest('canvas.kanji-sheet-cell');
    if (!canvas || (event.button !== 0 && event.pointerType !== 'pen')) return;
    event.preventDefault();
    // State first, capture second: setPointerCapture throws when the browser
    // no longer considers the pointer active, and letting that abort the
    // handler would swallow the stroke entirely. Move and up are bound to the
    // document, so capture is a nicety here, not a requirement.
    drawing = { canvas, points: [pointOf(event, canvas)], pointerId: event.pointerId };
    try { canvas.setPointerCapture?.(event.pointerId); } catch { /* draw without it */ }
  }

  function onPointerMove(event) {
    if (!drawing || event.pointerId !== drawing.pointerId) return;
    event.preventDefault();
    drawing.points.push(pointOf(event, drawing.canvas));
    paintCell(drawing.canvas);
    const context = drawing.canvas.getContext('2d');
    context.save();
    context.strokeStyle = '#141210';
    context.lineWidth = 6;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(drawing.points[0].x, drawing.points[0].y);
    for (const point of drawing.points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
    context.restore();
  }

  function onPointerUp(event) {
    if (!drawing || event.pointerId !== drawing.pointerId) return;
    event.preventDefault();
    const { canvas, points } = drawing;
    drawing = null;
    try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* never held it */ }

    const state = cellState(canvas);
    const guide = guides.get(state.character);
    const checking = state.role === 'guided' && guide && state.accepted < guide.length;

    if (!checking) {
      state.strokes.push(points);
      paintCell(canvas);
      persist();
      return;
    }

    const drawn = points.map((point) => ({ x: point.x / canvas.width, y: point.y / canvas.height }));
    const verdict = matchStroke(drawn, guide[state.accepted]);
    if (verdict.ok) {
      state.strokes.push(points);
      state.accepted += 1;
      const done = state.accepted >= guide.length;
      setStatus(done ? `${state.character}: xong ${guide.length} nét.` : `${state.character}: nét ${state.accepted + 1}/${guide.length}`, done ? 'ok' : '');
      persist();
    } else {
      setStatus(`${state.character}: ${STROKE_FEEDBACK[verdict.reason] || STROKE_FEEDBACK['wrong-place']}`, 'error');
      canvas.classList.remove('is-rejected');
      void canvas.offsetWidth;
      canvas.classList.add('is-rejected');
    }
    paintCell(canvas);
  }

  rowsHost.addEventListener('pointerdown', onPointerDown);
  // preventDefault on pointerdown is not enough on its own: a drag that began
  // on a square still raises selectstart, which highlights the whole row and
  // brings up the copy menu mid-stroke.
  rowsHost.addEventListener('selectstart', (event) => event.preventDefault());
  rowsHost.addEventListener('dragstart', (event) => event.preventDefault());
  document.addEventListener('pointermove', onPointerMove, { passive: false });
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);

  function wipeSheet() {
    for (const [canvas, state] of cells) {
      state.strokes = [];
      state.accepted = 0;
      paintCell(canvas);
    }
    if (lessonId) clearSheet(lessonId);
    setStatus('Đã xóa cả tờ.');
  }

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);
    modalDialog?.release();
    overlay.remove();
    if (activeSheet?.element === overlay) activeSheet = null;
  }

  overlay.addEventListener('click', (event) => {
    const action = event.target.closest('[data-sheet-action]')?.dataset.sheetAction;
    if (action === 'clear') wipeSheet();
    else if (action === 'close' || event.target === overlay) close();
  });

  modalDialog = activateModalDialog(overlay, {
    trigger,
    initialFocus: overlay.querySelector('[aria-label="Đóng tờ luyện viết"]'),
    onEscape: close,
  });
  activeSheet = { element: overlay, close };

  // Ink first: it comes from localStorage, so it can be on screen immediately
  // rather than waiting on the half-megabyte stroke file.
  const restored = restore();
  for (const canvas of overlay.querySelectorAll('canvas.kanji-sheet-cell')) paintCell(canvas);
  if (restored) setStatus('Đã mở lại tờ đang viết dở.');

  // Stroke outlines and readings arrive together; until they do the squares are
  // plain paper, which is still usable.
  void Promise.all([loadStrokeData(), loadHanViet()]).then(([data]) => {
    if (closed) return;
    const viewBox = Number(data?.viewBox) || 109;
    for (const character of list) {
      const paths = data?.strokes?.[character];
      if (Array.isArray(paths) && paths.length) {
        const sampled = paths.map((d) => samplePath(d, viewBox, 24)).filter((points) => points.length >= 2);
        if (sampled.length) guides.set(character, sampled);
      }
      const reading = formatHanViet(hanVietOf(character));
      const slot = overlay.querySelector(`[data-sheet-row="${CSS.escape(character)}"] [data-sheet-hanviet]`);
      if (slot && reading) slot.textContent = reading;
    }
    for (const canvas of overlay.querySelectorAll('canvas.kanji-sheet-cell')) paintCell(canvas);
  });

  return activeSheet;
}

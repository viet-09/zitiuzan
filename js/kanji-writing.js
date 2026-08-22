import { activateModalDialog } from './modal-dialog.js';
import { STROKE_FEEDBACK, matchStroke, resamplePolyline } from './kanji-stroke-match.js';

let activePad = null;
let strokeDataPromise = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

/**
 * KanjiVG stroke outlines for the whole curriculum, fetched once per session.
 * Half a megabyte is far too much to ship in the app shell for a pad most
 * visits never open, so it loads when the pad does.
 */
function loadStrokeData() {
  if (!strokeDataPromise) {
    strokeDataPromise = fetch('data/kanji-strokes.json')
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
  }
  return strokeDataPromise;
}

/**
 * Sample an SVG path into a polyline in 0..1 character space.
 *
 * The browser already knows how to walk a bezier, so the data file keeps
 * KanjiVG's `d` strings verbatim and this asks the DOM for the points instead
 * of reimplementing curve maths.
 */
function samplePath(d, viewBox, count) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewBox} ${viewBox}`);
  svg.style.position = 'absolute';
  svg.style.width = '0';
  svg.style.height = '0';
  svg.style.overflow = 'hidden';
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

function pointerPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const pressure = event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : 0.5;
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height),
    width: 7 + pressure * 13,
  };
}

function drawSegment(context, from, to) {
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.lineWidth = (from.width + to.width) / 2;
  context.stroke();
}

export function openKanjiWritingPad({ character = '', trigger = null } = {}) {
  if (typeof document === 'undefined') return null;
  activePad?.close();

  const kanji = [...String(character).trim()][0] || '字';
  const titleId = `kanji-writing-title-${Date.now()}`;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay kanji-writing-overlay active';
  overlay.innerHTML = `
    <section class="modal-card kanji-writing-card" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <header class="modal-header">
        <div>
          <p class="profile-modal__eyebrow">LUYỆN NÉT TRÊN TABLET</p>
          <h2 id="${titleId}">Luyện viết <span lang="ja">${escapeHtml(kanji)}</span></h2>
        </div>
        <button type="button" class="modal-close" data-writing-action="close" aria-label="Đóng bảng luyện viết">×</button>
      </header>
      <div class="modal-body kanji-writing-body">
        <p class="kanji-writing-hint" data-writing-hint>Dùng bút, ngón tay hoặc chuột. Nét bút sẽ thay đổi nhẹ theo lực nhấn.</p>
        <p class="kanji-writing-status" data-writing-status role="status" aria-live="polite"></p>
        <div class="kanji-writing-sheet">
          <span class="kanji-writing-guide" lang="ja" aria-hidden="true">${escapeHtml(kanji)}</span>
          <canvas class="kanji-writing-canvas" width="512" height="512" aria-label="Vùng viết chữ ${escapeHtml(kanji)}"></canvas>
        </div>
      </div>
      <footer class="modal-footer kanji-writing-actions">
        <button type="button" class="profile-skip-btn" data-writing-action="undo" aria-label="Xóa nét vừa viết">↶ Nét trước</button>
        <button type="button" class="profile-skip-btn" data-writing-action="clear" aria-label="Làm sạch bảng viết">Xóa bảng</button>
        <button type="button" class="complete-modal-btn" data-writing-action="close">Xong</button>
      </footer>
    </section>`;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector('canvas');
  const context = canvas.getContext('2d');
  const sheet = overlay.querySelector('.kanji-writing-sheet');
  const statusEl = overlay.querySelector('[data-writing-status]');
  const hintEl = overlay.querySelector('[data-writing-hint]');
  const strokes = [];
  /** Expected strokes in writing order, in 0..1 space. Empty = freeform mode. */
  let guideStrokes = [];
  let currentStroke = null;
  let modalDialog = null;
  let closed = false;

  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = '#141210';

  const guided = () => guideStrokes.length > 0;

  function setStatus(message, kind = '') {
    statusEl.textContent = message;
    statusEl.dataset.tone = kind;
  }

  function progressMessage() {
    if (!guided()) return '';
    if (strokes.length >= guideStrokes.length) return `Xong cả ${guideStrokes.length} nét. Viết rất tốt!`;
    return `Nét ${strokes.length + 1}/${guideStrokes.length}`;
  }

  function clearCanvas() {
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  const canvasPoints = (stroke) => stroke.map((point) => ({
    x: point.x * canvas.width,
    y: point.y * canvas.height,
  }));

  function tracePath(points) {
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
  }

  /**
   * The whole character, faint, drawn from the very strokes that are being
   * checked.
   *
   * The tracing outline used to be a font glyph centred in the sheet, which
   * could never line up with KanjiVG's 109-unit box: a font has its own em
   * square and side bearings, and the two were sized independently. Drawing
   * both from one source makes a mismatch impossible rather than tuned away.
   */
  function drawGhost() {
    if (!guided()) return;
    context.save();
    context.strokeStyle = 'rgba(20, 18, 16, .13)';
    context.lineWidth = 11;
    for (const stroke of guideStrokes) {
      const points = canvasPoints(stroke);
      if (points.length >= 2) tracePath(points);
    }
    context.restore();
  }

  /** The next expected stroke, faint, with a dot at the point to start from. */
  function drawGuide() {
    if (!guided() || strokes.length >= guideStrokes.length) return;
    const points = canvasPoints(guideStrokes[strokes.length]);
    if (points.length < 2) return;

    context.save();
    context.strokeStyle = 'rgba(196, 64, 48, .55)';
    context.lineWidth = 9;
    context.setLineDash([14, 10]);
    tracePath(points);

    context.setLineDash([]);
    context.fillStyle = 'rgba(196, 64, 48, .7)';
    context.beginPath();
    context.arc(points[0].x, points[0].y, 9, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function redraw() {
    clearCanvas();
    drawGhost();
    drawGuide();
    strokes.forEach((stroke) => {
      if (stroke.length === 1) drawSegment(context, stroke[0], stroke[0]);
      for (let index = 1; index < stroke.length; index += 1) {
        drawSegment(context, stroke[index - 1], stroke[index]);
      }
    });
  }

  /** Flash the sheet so a rejected stroke reads as rejected, not as a glitch. */
  function rejectStroke(reason) {
    setStatus(STROKE_FEEDBACK[reason] || STROKE_FEEDBACK['wrong-place'], 'error');
    sheet.classList.remove('is-rejected');
    // Reading offsetWidth restarts the animation when two strokes in a row miss.
    void sheet.offsetWidth;
    sheet.classList.add('is-rejected');
    redraw();
  }

  function commitStroke(points) {
    strokes.push(points);
    redraw();
    setStatus(progressMessage(), strokes.length >= guideStrokes.length ? 'done' : 'ok');
  }

  /** Accept the finished stroke, or throw it away with a reason why. */
  function judgeStroke(points) {
    if (!guided()) {
      strokes.push(points);
      return;
    }
    const expected = guideStrokes[strokes.length];
    const drawn = points.map((point) => ({ x: point.x / canvas.width, y: point.y / canvas.height }));
    const verdict = matchStroke(drawn, expected);
    if (verdict.ok) commitStroke(points);
    else rejectStroke(verdict.reason);
  }

  function close() {
    if (closed) return;
    closed = true;
    modalDialog?.release();
    overlay.remove();
    if (activePad?.element === overlay) activePad = null;
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.pointerType !== 'pen') return;
    if (guided() && strokes.length >= guideStrokes.length) return;
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    currentStroke = [pointerPoint(event, canvas)];
    drawSegment(context, currentStroke[0], currentStroke[0]);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!currentStroke) return;
    event.preventDefault();
    const next = pointerPoint(event, canvas);
    drawSegment(context, currentStroke[currentStroke.length - 1], next);
    currentStroke.push(next);
  });
  const finishStroke = (event) => {
    if (!currentStroke) return;
    event.preventDefault();
    const points = currentStroke;
    currentStroke = null;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    judgeStroke(points);
    if (!guided()) redraw();
  };
  canvas.addEventListener('pointerup', finishStroke);
  canvas.addEventListener('pointercancel', finishStroke);

  overlay.addEventListener('click', (event) => {
    const action = event.target.closest('[data-writing-action]')?.dataset.writingAction;
    if (action === 'undo') {
      strokes.pop();
      redraw();
      setStatus(progressMessage());
    } else if (action === 'clear') {
      strokes.length = 0;
      currentStroke = null;
      redraw();
      setStatus(progressMessage());
    } else if (action === 'close' || event.target === overlay) {
      close();
    }
  });

  modalDialog = activateModalDialog(overlay, {
    trigger,
    initialFocus: overlay.querySelector('[aria-label="Đóng bảng luyện viết"]'),
    onEscape: close,
  });
  activePad = { element: overlay, close };

  // Guided mode arrives asynchronously. Until it does the pad behaves exactly
  // as it always did, so a slow network never blocks practice.
  void loadStrokeData().then((data) => {
    if (closed) return;
    const paths = data?.strokes?.[kanji];
    if (!Array.isArray(paths) || !paths.length) return;
    const viewBox = Number(data.viewBox) || 109;
    guideStrokes = paths
      .map((d) => samplePath(d, viewBox, 24))
      .filter((points) => points.length >= 2);
    if (!guideStrokes.length) return;
    hintEl.textContent = 'Viết theo đúng thứ tự nét. Nét sai chỗ hoặc sai chiều sẽ không được nhận.';
    // The font glyph would sit at its own size and position next to the real
    // outline, so it steps aside once the outline is available.
    sheet.dataset.guided = 'true';
    redraw();
    setStatus(progressMessage());
  });

  return activePad;
}

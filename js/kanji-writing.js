import { activateModalDialog } from './modal-dialog.js';

let activePad = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
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
        <p class="kanji-writing-hint">Dùng bút, ngón tay hoặc chuột. Nét bút sẽ thay đổi nhẹ theo lực nhấn.</p>
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
  const strokes = [];
  let currentStroke = null;
  let modalDialog = null;
  let closed = false;

  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = '#141210';

  function clearCanvas() {
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  function redraw() {
    clearCanvas();
    strokes.forEach((stroke) => {
      if (stroke.length === 1) drawSegment(context, stroke[0], stroke[0]);
      for (let index = 1; index < stroke.length; index += 1) {
        drawSegment(context, stroke[index - 1], stroke[index]);
      }
    });
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
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    currentStroke = [pointerPoint(event, canvas)];
    strokes.push(currentStroke);
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
    currentStroke = null;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerup', finishStroke);
  canvas.addEventListener('pointercancel', finishStroke);

  overlay.addEventListener('click', (event) => {
    const action = event.target.closest('[data-writing-action]')?.dataset.writingAction;
    if (action === 'undo') {
      strokes.pop();
      redraw();
    } else if (action === 'clear') {
      strokes.length = 0;
      currentStroke = null;
      clearCanvas();
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
  return activePad;
}


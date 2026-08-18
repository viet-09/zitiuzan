// js/exam.js — Mock JLPT exam: pick a sitting → answer every section under
// real exam timing → AI-graded review → targeted retest. Reuses lesson.js's
// .quiz-* markup for visual consistency but with its own interaction
// (select-only during the real exam — no reveal; immediate reveal during
// the retest, like lesson practice quizzes).

import { renderFurigana } from './furigana.js';
import { getClient, currentUser } from './supabase.js';
import { examHistoryStore } from './exam-history.js';

const SECTION_LABELS = {
  vocab_grammar: '文字・語彙・文法',
  reading: '読解',
  listening: '聴解',
};

// Real JLPT N2 timing (from the exam cover page): 言語知識・読解 105 min,
// 聴解 50 min, taken in that fixed order with no going back once advanced.
const PHASES = [
  { id: 'language', label: '言語知識・読解', sectionIds: ['vocab_grammar', 'reading'], durationMs: 105 * 60 * 1000 },
  { id: 'listening', label: '聴解', sectionIds: ['listening'], durationMs: 50 * 60 * 1000 },
];

let rootEl = null;
let mountToken = 0;
let timerInterval = null;

const state = {
  view: 'picker', // picker | taking | score | review | retest
  examList: [],
  listLoading: false,
  listError: '',
  level: '',
  sitting: '',
  content: null,
  phaseIndex: 0,
  phaseDeadline: 0,
  activeSectionId: '',
  answers: new Map(), // `${section}:${part}:${number}` -> selectedIndex
  submitting: false,
  submitError: '',
  review: null,
  history: [],
  historyLoading: false,
  retest: { answers: new Map() },
  audioPartIndex: 0, // which entry of state.content.audioUrls is currently loaded
  explainLoading: false,
  explainError: '',
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function qKey(section, part, number) {
  return `${section}:${part}:${number}`;
}

function formatClock(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function invokeExamFn(name, body) {
  const sb = await getClient();
  if (!sb) throw new Error('Chưa đăng nhập — vui lòng đăng nhập để làm bài thi thử.');
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let message = error.message || 'Yêu cầu thất bại';
    try {
      const body2 = await error.context?.clone()?.json();
      if (body2?.error) message = body2.error;
    } catch { /* ignore */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

function clearTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

function resetForNewExam() {
  state.phaseIndex = 0;
  state.phaseDeadline = Date.now() + PHASES[0].durationMs;
  state.activeSectionId = '';
  state.answers = new Map();
  state.review = null;
  state.submitError = '';
  state.audioPartIndex = 0;
  state.explainLoading = false;
  state.explainError = '';
}

async function loadExamList(token) {
  state.listLoading = true;
  state.listError = '';
  paint();
  try {
    const data = await invokeExamFn('exam-fetch', {});
    if (token !== mountToken) return;
    state.examList = Array.isArray(data?.exams) ? data.exams : [];
  } catch (err) {
    if (token !== mountToken) return;
    state.listError = err instanceof Error ? err.message : String(err);
  } finally {
    if (token === mountToken) {
      state.listLoading = false;
      paint();
    }
  }
}

async function loadHistory(token) {
  state.historyLoading = true;
  try {
    const sb = await getClient();
    const user = sb ? await currentUser() : null;
    if (!user) return;
    const { data } = await sb
      .from('exam_attempts')
      .select('id,jlpt_level,source_file,score,created_at')
      .order('created_at', { ascending: false })
      .limit(10);
    if (token !== mountToken) return;
    state.history = data || [];
    examHistoryStore.replace(state.history);
  } catch {
    // history is a nice-to-have; ignore failures
  } finally {
    if (token === mountToken) {
      state.historyLoading = false;
      paint();
    }
  }
}

async function pickExam(level, sitting, token) {
  state.listError = '';
  try {
    const data = await invokeExamFn('exam-fetch', { level, sitting });
    if (token !== mountToken) return;
    state.level = level;
    state.sitting = sitting;
    state.content = data;
    resetForNewExam();
    state.activeSectionId = firstSectionIdForPhase(0);
    state.view = 'taking';
    paint();
    startPhaseTimer(token);
  } catch (err) {
    if (token !== mountToken) return;
    state.listError = err instanceof Error ? err.message : String(err);
    paint();
  }
}

function firstSectionIdForPhase(phaseIndex) {
  const phase = PHASES[phaseIndex];
  const sections = state.content?.sections || [];
  const match = sections.find((s) => phase.sectionIds.includes(s.id));
  return match?.id || '';
}

function startPhaseTimer(token) {
  clearTimer();
  timerInterval = setInterval(() => {
    if (token !== mountToken || state.view !== 'taking') {
      clearTimer();
      return;
    }
    const msLeft = state.phaseDeadline - Date.now();
    if (msLeft <= 0) {
      clearTimer();
      void advancePhaseOrSubmit(token, true);
      return;
    }
    const el = rootEl?.querySelector('[data-timer]');
    if (el) el.textContent = formatClock(msLeft);
  }, 1000);
}

/** Called on manual "next phase / submit" click, or automatically at 0:00. */
async function advancePhaseOrSubmit(token, auto = false) {
  if (state.phaseIndex < PHASES.length - 1) {
    state.phaseIndex += 1;
    state.activeSectionId = firstSectionIdForPhase(state.phaseIndex);
    state.phaseDeadline = Date.now() + PHASES[state.phaseIndex].durationMs;
    state.audioPartIndex = 0;
    if (auto) state.submitError = '';
    paint();
    startPhaseTimer(token);
    playFirstListeningPart();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    await submitExam(token, auto);
  }
}

function playFirstListeningPart() {
  window.setTimeout(() => {
    const el = rootEl?.querySelector('audio[data-exam-audio]');
    if (el) el.play().catch(() => { /* autoplay may be blocked — controls remain visible */ });
  }, 0);
}

/** Large listening files are split into multiple parts (see
 * scripts/upload-exam-audio.mjs + exam-fetch's resolveAudioUrls) — advance
 * to the next part and keep playing when the current one ends, so the
 * audio reads as one continuous track to the test-taker. */
function handleAudioPartEnded() {
  const urls = state.content?.audioUrls || [];
  if (state.audioPartIndex >= urls.length - 1) return;
  state.audioPartIndex += 1;
  const el = rootEl?.querySelector('audio[data-exam-audio]');
  if (el) {
    el.src = urls[state.audioPartIndex];
    el.play().catch(() => { /* autoplay may be blocked — controls remain visible */ });
  }
}

/** Every paint() fully replaces rootEl's innerHTML, which destroys and
 * recreates the <audio> element even when the user just answered a
 * question — without this, listening playback would restart from 0 on
 * every click. Captures {currentTime, paused} before the swap. */
function captureAudioState() {
  const el = rootEl?.querySelector('audio[data-exam-audio]');
  return el ? { currentTime: el.currentTime, paused: el.paused } : null;
}

/** Restores playback position/state after a paint() swap, and (re)wires
 * the ended handler onto whichever <audio> element now exists in the DOM. */
function applyAudioState(saved) {
  const el = rootEl?.querySelector('audio[data-exam-audio]');
  if (!el) return;
  el.onended = handleAudioPartEnded;
  if (saved) {
    el.currentTime = saved.currentTime;
    if (!saved.paused) el.play().catch(() => { /* autoplay may be blocked — controls remain visible */ });
  }
}

async function submitExam(token, auto = false) {
  if (state.submitting) return;
  clearTimer();
  state.submitting = true;
  state.submitError = auto ? 'Hết giờ — đang tự động nộp bài…' : '';
  paint();
  const answers = Array.from(state.answers.entries()).map(([key, selectedIndex]) => {
    const [section, part, number] = key.split(':');
    return { section, part, number: Number(number), selectedIndex };
  });
  try {
    // exam-review only grades — instant, no AI call — so the score always
    // comes back right away. The AI explanation/weakness/retest is a
    // separate opt-in step (see requestDetailedReview), fetched only if the
    // user clicks "Xem chi tiết" on the score screen.
    const review = await invokeExamFn('exam-review', { level: state.level, sitting: state.sitting, answers });
    if (token !== mountToken) return;
    state.review = review;
    examHistoryStore.add({
      id: review.session_id,
      score: review.score,
      source_file: state.sitting,
      created_at: new Date().toISOString(),
    });
    state.retest = { answers: new Map() };
    state.view = 'score';
  } catch (err) {
    if (token !== mountToken) return;
    state.submitError = err instanceof Error ? err.message : String(err);
  } finally {
    if (token === mountToken) {
      state.submitting = false;
      paint();
    }
  }
}

async function requestDetailedReview(token) {
  if (state.explainLoading || !state.review?.session_id) return;
  state.explainLoading = true;
  state.explainError = '';
  paint();
  try {
    const detailed = await invokeExamFn('exam-review-explain', { attempt_id: state.review.session_id });
    if (token !== mountToken) return;
    state.review = detailed;
    state.view = 'review';
  } catch (err) {
    if (token !== mountToken) return;
    state.explainError = err instanceof Error ? err.message : String(err);
  } finally {
    if (token === mountToken) {
      state.explainLoading = false;
      paint();
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderPicker() {
  const listBody = state.listLoading
    ? '<p class="dash-empty-state">Đang tải danh sách đề…</p>'
    : state.listError
    ? `<p class="dash-empty-state" role="alert">${esc(state.listError)}</p>`
    : state.examList.length === 0
    ? '<p class="dash-empty-state">Chưa có đề thi nào được tải lên.</p>'
    : `<div class="exam-picker-grid">${state.examList.map((e) => `
        <button type="button" class="exam-pick-btn" data-action="pick-exam" data-level="${esc(e.level)}" data-sitting="${esc(e.sitting)}">
          <span class="exam-pick-level">${esc(e.level)}</span>
          <span class="exam-pick-sitting">${esc(e.sitting)}</span>
        </button>`).join('')}</div>`;

  const historyBody = state.history.length === 0
    ? ''
    : `<section class="exam-history">
        <h3 class="subheading">Lịch sử thi thử</h3>
        <ul class="exam-history-list">
          ${state.history.map((a) => `
            <li class="exam-history-item">
              <span>${esc(a.jlpt_level)} · ${esc(a.source_file)}</span>
              <span class="exam-history-score">${esc(a.score?.total)}/${esc(a.score?.max)} (${esc(a.score?.percentage)})</span>
            </li>`).join('')}
        </ul>
      </section>`;

  rootEl.innerHTML = `
    <section class="exam-page">
      <h2 class="sr-only" data-route-heading>Thi thử JLPT</h2>
      <header class="exam-picker-head">
        <h1 class="section-heading">📝 Thi thử JLPT</h1>
        <p class="exam-picker-sub">Chọn một đề để làm thử — tính thời gian như thi thật (言語知識・読解 105 phút, 聴解 50 phút), chấm điểm và nhận xét chi tiết bằng AI ngay sau khi nộp.</p>
      </header>
      ${listBody}
      ${historyBody}
    </section>`;
}

function questionAnswered(section, part, number) {
  return state.answers.has(qKey(section, part, number));
}

function renderQuestionCard(section, part, question, { reveal = false } = {}) {
  const key = qKey(section, part, question.number);
  const selected = reveal ? question.selectedIndex ?? -1 : state.answers.get(key) ?? -1;
  const correct = reveal ? question.answerIndex : -1;
  const options = Array.isArray(question.options) ? question.options : [];

  if (question.audioOnly) {
    const buttonsHtml = options.map((option, idx) => {
      const classes = ['exam-audio-choice'];
      if (reveal) {
        if (idx === correct) classes.push('is-correct');
        else if (idx === selected) classes.push('is-incorrect');
      } else if (idx === selected) {
        classes.push('is-selected');
      }
      const disabledAttr = reveal ? ' disabled' : '';
      return `<button type="button" class="${classes.join(' ')}" data-action="quiz-option" data-key="${esc(key)}" data-idx="${idx}"${disabledAttr}>${esc(option)}</button>`;
    }).join('');
    return `
      <div class="quiz-question${reveal ? ' is-answered' : ''}" data-key="${esc(key)}">
        <div class="quiz-q-text">🎧 (${question.number}) Nghe rồi chọn đáp án đúng — câu này không in trên đề, giống tờ phiếu trả lời khi thi thật.</div>
        <div class="exam-audio-choices">${buttonsHtml}</div>
      </div>`;
  }

  const optionsHtml = options.map((option, idx) => {
    const classes = ['quiz-option'];
    if (reveal) {
      if (idx === correct) classes.push('is-correct');
      else if (idx === selected) classes.push('is-incorrect');
    } else if (idx === selected) {
      classes.push('is-selected');
    }
    const disabledAttr = reveal ? ' disabled' : '';
    return `<button type="button" class="${classes.join(' ')}" data-action="quiz-option" data-key="${esc(key)}" data-idx="${idx}" lang="ja"${disabledAttr}>${renderFurigana(option)}</button>`;
  }).join('');
  const explainHtml = reveal && question.explanation
    ? `<div class="quiz-explain" role="status">${esc(question.explanation)}</div>`
    : '';
  return `
    <div class="quiz-question${reveal ? ' is-answered' : ''}" data-key="${esc(key)}">
      <div class="quiz-q-text" lang="ja">(${question.number}) ${renderFurigana(question.prompt)}</div>
      <div class="quiz-options">${optionsHtml}</div>
      ${explainHtml}
    </div>`;
}

function renderPart(section, part) {
  const passages = Array.isArray(part.passages) ? part.passages : [];
  const passagesHtml = passages.map((p) => `
    <div class="passage-block">
      <div class="passage-text" lang="ja">${renderFurigana(p.text)}</div>
    </div>`).join('');
  const questions = Array.isArray(part.questions) ? part.questions : [];
  return `
    <div class="exam-part" data-part="${esc(part.part)}">
      <h4 class="quiz-section-title" lang="ja">${esc(part.part)}</h4>
      ${part.instructionJa ? `<p class="exam-part-instruction" lang="ja">${renderFurigana(part.instructionJa)}</p>` : ''}
      ${passagesHtml}
      ${questions.map((q) => renderQuestionCard(section, part.part, q)).join('')}
    </div>`;
}

function sectionProgress(section) {
  let total = 0;
  let done = 0;
  for (const part of section.parts) {
    for (const q of part.questions) {
      total += 1;
      if (questionAnswered(section.id, part.part, q.number)) done += 1;
    }
  }
  return { total, done };
}

/** Answer-sheet-style navigator: every question in the visible sections as a
 * small cell, green once answered — click jumps straight to that question. */
function renderTracker(visibleSections) {
  const cells = visibleSections.flatMap((section) => section.parts.flatMap((part) =>
    part.questions.map((q) => {
      const key = qKey(section.id, part.part, q.number);
      const answered = questionAnswered(section.id, part.part, q.number);
      return `<button type="button" class="exam-tracker-cell${answered ? ' is-answered' : ''}" data-action="exam-jump" data-key="${esc(key)}" title="Câu ${esc(q.number)}${answered ? ' — đã làm' : ' — chưa làm'}">${esc(q.number)}</button>`;
    })
  )).join('');
  return `
    <aside class="exam-tracker" aria-label="Theo dõi câu đã làm">
      <h4 class="exam-tracker-title">Theo dõi</h4>
      <div class="exam-tracker-grid">${cells}</div>
    </aside>`;
}

function renderAudioPlayer() {
  const urls = Array.isArray(state.content?.audioUrls) ? state.content.audioUrls : [];
  if (urls.length === 0) return '<p class="dash-empty-state">🎧 Chưa có file nghe cho đề này.</p>';
  const src = urls[state.audioPartIndex] || urls[0];
  const partHint = urls.length > 1 ? ` File dài được chia làm ${urls.length} phần — hết phần này sẽ tự phát tiếp phần sau, không cần bấm gì.` : '';
  return `
    <div class="exam-audio-player">
      <audio data-exam-audio controls preload="auto" src="${esc(src)}"></audio>
      <p class="exam-audio-hint">Bật âm lượng — audio phát liên tục như thi thật, không tua lại giữa các câu.${esc(partHint)}</p>
    </div>`;
}

function renderTaking() {
  const sections = state.content?.sections || [];
  const phase = PHASES[state.phaseIndex];
  const visibleSections = sections.filter((s) => phase.sectionIds.includes(s.id));
  const activeSection = visibleSections.find((s) => s.id === state.activeSectionId) || visibleSections[0];

  const tabs = visibleSections.length > 1 ? visibleSections.map((section) => {
    const { total, done } = sectionProgress(section);
    const active = section.id === activeSection?.id;
    return `<button type="button" class="tab-btn${active ? ' active' : ''}" data-action="exam-section-tab" data-id="${esc(section.id)}" aria-pressed="${active}">
      ${esc(SECTION_LABELS[section.id] || section.nameJa)} <span class="exam-tab-count">${done}/${total}</span>
    </button>`;
  }).join('') : '';

  const audioHtml = phase.id === 'listening' ? renderAudioPlayer() : '';
  const partsHtml = activeSection ? activeSection.parts.map((part) => renderPart(activeSection.id, part)).join('') : '';

  const totalAnswered = visibleSections.reduce((sum, s) => sum + sectionProgress(s).done, 0);
  const totalQuestions = visibleSections.reduce((sum, s) => sum + sectionProgress(s).total, 0);
  const isLastPhase = state.phaseIndex >= PHASES.length - 1;
  const msLeft = state.phaseDeadline - Date.now();
  const advanceLabel = state.submitting ? 'Đang chấm bài…' : isLastPhase ? 'Nộp bài & xem kết quả' : 'Nộp phần này → chuyển sang Nghe';
  const advanceButton = (extraClass) => `
    <button type="button" class="complete-modal-btn${extraClass ? ' ' + extraClass : ''}" data-action="exam-advance" ${state.submitting ? 'disabled' : ''}>
      ${advanceLabel}
    </button>`;

  rootEl.innerHTML = `
    <section class="exam-page">
      <h2 class="sr-only" data-route-heading>Đang thi ${esc(state.level)} ${esc(state.sitting)}</h2>
      <header class="exam-timer-bar">
        <span class="exam-timer-phase">${esc(phase.label)}</span>
        <span class="exam-timer-clock" data-timer>${formatClock(msLeft)}</span>
        <span class="lesson-meta">${totalAnswered}/${totalQuestions} câu</span>
        ${advanceButton('exam-advance-top')}
      </header>
      ${renderTracker(visibleSections)}
      ${tabs ? `<div class="category-tabs" role="group" aria-label="Phần thi">${tabs}</div>` : ''}
      ${audioHtml}
      <div class="exam-questions">${partsHtml}</div>
      ${state.submitError ? `<p class="dash-empty-state" role="alert">${esc(state.submitError)}</p>` : ''}
      <footer class="exam-submit-bar">
        ${advanceButton()}
      </footer>
    </section>`;
}

/** Shown immediately after grading — score is already final at this point
 * (exam-review never calls Gemini). "Xem chi tiết" is the only thing that
 * triggers the AI explanation/weakness/retest generation; "Kết thúc" skips
 * it entirely and the attempt just sits in history as a bare score. */
function renderScore() {
  const review = state.review;
  if (!review) return renderPicker();
  const bySection = review.score?.bySection || {};
  const sectionRows = Object.entries(bySection).map(([id, v]) => `
    <div class="stat-item">
      <div class="stat-value">${esc(v.correct)}/${esc(v.total)}</div>
      <div class="stat-label">${esc(SECTION_LABELS[id] || id)}</div>
    </div>`).join('');

  rootEl.innerHTML = `
    <section class="exam-page">
      <h2 class="sr-only" data-route-heading>Kết quả thi thử</h2>
      <header class="exam-review-head">
        <h1 class="section-heading">Kết quả: ${esc(review.score?.total)}/${esc(review.score?.max)} (${esc(review.score?.percentage)})</h1>
      </header>
      <section class="stats-bar">${sectionRows}</section>
      ${state.explainError ? `<p class="dash-empty-state" role="alert">${esc(state.explainError)}</p>` : ''}
      <footer class="exam-submit-bar">
        <button type="button" class="complete-modal-btn" data-action="exam-view-detail" ${state.explainLoading ? 'disabled' : ''}>
          ${state.explainLoading ? 'Đang tạo nhận xét…' : 'Xem chi tiết'}
        </button>
        <button type="button" class="tts-btn back-btn" data-action="exam-exit">Kết thúc</button>
      </footer>
    </section>`;
}

function renderReview() {
  const review = state.review;
  if (!review) return renderPicker();
  const bySection = review.score?.bySection || {};
  const sectionRows = Object.entries(bySection).map(([id, v]) => `
    <div class="stat-item">
      <div class="stat-value">${esc(v.correct)}/${esc(v.total)}</div>
      <div class="stat-label">${esc(SECTION_LABELS[id] || id)}</div>
    </div>`).join('');

  const wrongItems = (review.detailed_review || []).filter((r) => !r.is_correct);
  const reviewHtml = wrongItems.length === 0
    ? '<p class="dash-empty-state">🎉 Làm đúng hết! Không có câu nào cần xem lại.</p>'
    : wrongItems.map((r) => `
        <article class="exam-review-item">
          <div class="exam-review-id">${esc(r.question_id)}</div>
          <div class="correction-original">Bạn chọn: ${esc(r.user_answer)}</div>
          <div class="correction-fixed">Đáp án đúng: ${esc(r.correct_answer)}</div>
          ${r.explanation ? `<p class="exam-review-explain">${esc(r.explanation)}</p>` : ''}
          ${r.remediation_rule ? `<p class="exam-review-rule">📌 ${esc(r.remediation_rule)}</p>` : ''}
        </article>`).join('');

  const tagsHtml = (review.weakness_tags || []).length
    ? `<div class="exam-weakness-tags">${review.weakness_tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join('')}</div>`
    : '';

  const retestCta = review.retest_generated
    ? `<button type="button" class="complete-modal-btn" data-action="exam-start-retest">Làm bài luyện tập củng cố (${review.retest_questions.length} câu)</button>`
    : '';

  rootEl.innerHTML = `
    <section class="exam-page">
      <h2 class="sr-only" data-route-heading>Kết quả thi thử</h2>
      <header class="exam-review-head">
        <h1 class="section-heading">Kết quả: ${esc(review.score?.total)}/${esc(review.score?.max)} (${esc(review.score?.percentage)})</h1>
      </header>
      <section class="stats-bar">${sectionRows}</section>
      ${tagsHtml}
      <h3 class="subheading">Xem lại câu sai</h3>
      <div class="exam-review-list">${reviewHtml}</div>
      <footer class="exam-submit-bar">
        ${retestCta}
        <button type="button" class="tts-btn back-btn" data-action="exam-exit">← Chọn đề khác</button>
      </footer>
    </section>`;
}

function renderRetest() {
  const questions = state.review?.retest_questions || [];
  const items = questions.map((q, idx) => renderQuestionCard('retest', 'retest', {
    number: idx + 1,
    prompt: q.prompt,
    options: q.options,
    answerIndex: q.answerIndex,
    explanation: q.explanation,
    selectedIndex: state.retest.answers.get(idx) ?? -1,
  }, { reveal: state.retest.answers.has(idx) })).join('');

  rootEl.innerHTML = `
    <section class="exam-page">
      <h2 class="sr-only" data-route-heading>Luyện tập củng cố</h2>
      <header class="lesson-toolbar">
        <button type="button" class="tts-btn back-btn" data-action="exam-back-to-review">← Quay lại kết quả</button>
        <span class="lesson-meta">Luyện tập củng cố · ${state.retest.answers.size}/${questions.length} câu</span>
      </header>
      <div class="exam-questions" data-retest="1">${items}</div>
    </section>`;
}

function paint() {
  if (!rootEl) return;
  const savedAudio = captureAudioState();
  if (state.view === 'taking' && state.content) renderTaking();
  else if (state.view === 'score') renderScore();
  else if (state.view === 'review') renderReview();
  else if (state.view === 'retest') renderRetest();
  else renderPicker();
  applyAudioState(savedAudio);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function onRootClick(event) {
  const token = mountToken;
  const pick = event.target.closest('[data-action="pick-exam"]');
  if (pick) {
    void pickExam(pick.getAttribute('data-level'), pick.getAttribute('data-sitting'), token);
    return;
  }
  const tab = event.target.closest('[data-action="exam-section-tab"]');
  if (tab) {
    state.activeSectionId = tab.getAttribute('data-id') || '';
    paint();
    return;
  }
  const jump = event.target.closest('[data-action="exam-jump"]');
  if (jump) {
    const key = jump.getAttribute('data-key') || '';
    const [section] = key.split(':');
    if (section && section !== state.activeSectionId) {
      state.activeSectionId = section;
      paint();
    }
    rootEl?.querySelector(`.quiz-question[data-key="${key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const option = event.target.closest('[data-action="quiz-option"]');
  if (option && !option.disabled) {
    const key = option.getAttribute('data-key');
    const idx = Number(option.getAttribute('data-idx'));
    if (state.view === 'retest') {
      const numberMatch = /:(\d+)$/.exec(key);
      const qIndex = numberMatch ? Number(numberMatch[1]) - 1 : -1;
      if (qIndex >= 0 && !state.retest.answers.has(qIndex)) {
        state.retest.answers.set(qIndex, idx);
        paint();
      }
      return;
    }
    state.answers.set(key, idx);
    paint();
    return;
  }
  if (event.target.closest('[data-action="exam-exit"]')) {
    clearTimer();
    state.view = 'picker';
    paint();
    void loadExamList(token);
    void loadHistory(token);
    return;
  }
  if (event.target.closest('[data-action="exam-view-detail"]')) {
    void requestDetailedReview(token);
    return;
  }
  if (event.target.closest('[data-action="exam-advance"]')) {
    void advancePhaseOrSubmit(token, false);
    return;
  }
  if (event.target.closest('[data-action="exam-start-retest"]')) {
    state.view = 'retest';
    paint();
    return;
  }
  if (event.target.closest('[data-action="exam-back-to-review"]')) {
    state.view = 'review';
    paint();
  }
}

export function renderExam(root) {
  const token = ++mountToken;
  rootEl = root;
  root.addEventListener('click', onRootClick);
  paint();
  if (state.view === 'picker') {
    if (state.examList.length === 0) void loadExamList(token);
    void loadHistory(token);
  } else if (state.view === 'taking') {
    startPhaseTimer(token);
  }
  return {
    preserveScroll: false,
    cleanup() {
      clearTimer();
      root.removeEventListener('click', onRootClick);
    },
  };
}

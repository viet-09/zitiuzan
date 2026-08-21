// js/lesson.js — book-backed lesson renderer, quizzes, TTS, tutor context,
// and cached Vietnamese explanations for tappable Japanese headwords.
import {
  findLesson,
  getBookContent,
  getKanjiGloss,
  setKanjiGloss,
  setTutorContext,
  clearTutorHistory,
  isDone,
} from './store.js';
import { navigate, getCurrentRoute, isRouteActive } from './router.js';
import { buildFuriganaMarkup, renderFurigana, setFurigana, getFurigana } from './furigana.js';
import { askText } from './gemini.js';
import { renderTutor } from './tutor.js';
import { getQuestionClassification, getLessonImages, getVietnameseExplanation } from './store.js';
import { questionTypeInfo } from './question-types.js';
import { hydrateLessonAudio } from './lesson-audio.js';
import { startLessonTimer } from './study-time.js';
import { toggleLessonCompletion } from './completion.js';
import { learningState } from './learning-state.js';
import { buildBookViewerModel, renderBookViewerStrip } from './book-viewer.js';
import { activateModalDialog } from './modal-dialog.js';
import { openKanjiWritingPad } from './kanji-writing.js?v=21';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function plainJapanese(value) {
  return String(value ?? '').replace(/\{([^{}|]*)\|([^{}]*)\}/g, '$1').trim();
}

// Grammar `form`/`connection` fields transcribe the book's own conjugation-grouping
// notation, including a literal <s>…</s> strikethrough mark for the part that's dropped
// (e.g. "V<s>ます</s>がち"). renderFurigana HTML-escapes everything, so re-open just that
// one known-safe tag pair afterward — never re-open anything else.
function renderGrammarNotation(value) {
  return renderFurigana(value)
    .replace(/&lt;s&gt;/g, '<s>')
    .replace(/&lt;\/s&gt;/g, '</s>');
}

let voices = [];
function refreshVoices() {
  if (typeof speechSynthesis !== 'undefined') voices = speechSynthesis.getVoices() || [];
}
if (typeof speechSynthesis !== 'undefined') {
  refreshVoices();
  speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
}

function speak(text) {
  if (typeof speechSynthesis === 'undefined') return;
  const clean = plainJapanese(text);
  if (!clean) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = 'ja-JP';
  utterance.voice = voices.find((voice) => /^ja(?:-|$)/i.test(voice.lang || '')) || null;
  speechSynthesis.speak(utterance);
}

function ttsButton(text) {
  if (!String(text || '').trim()) return '';
  return `<button type="button" class="tts-btn" data-action="speak" data-jp="${escapeHtml(text)}" aria-label="Nghe phát âm tiếng Nhật">🔊</button>`;
}

function wordButton(word, reading = '', label = null) {
  const display = label || buildFuriganaMarkup(word, reading);
  return `<button type="button" class="explain-word-btn" data-action="explain-word" data-word="${escapeHtml(word)}" data-reading="${escapeHtml(reading)}" lang="ja">${renderFurigana(display)}</button>`;
}

function renderJapaneseLine(text, className = 'jp-sentence', { tts = true } = {}) {
  const ttsMarkup = tts ? ttsButton(text) : '';
  return `<div class="${className}" lang="ja"><button type="button" class="jp-text explain-word-btn" data-action="explain-sentence" data-jp="${escapeHtml(text || '')}" aria-label="Dịch câu này sang tiếng Việt">${renderFurigana(text || '')}</button>${ttsMarkup}</div>`;
}

function answerIndex(question) {
  const index = Number(question?.answerIndex);
  return Number.isInteger(index) ? index : -1;
}

function renderQuestionHeader(lessonId, questionIndex) {
  const info = getQuestionClassification(lessonId, questionIndex);
  if (!info) return '';
  const t = questionTypeInfo(info.type);
  const label = escapeHtml(t.label || info.type);
  const tip = t.tip ? ` title="${escapeHtml(t.tip)}" aria-label="${escapeHtml(t.tip)}"` : '';
  return `<header class="quiz-q-header"><span class="quiz-q-type-badge" data-question-type="${escapeHtml(info.type)}"${tip}>${label}</span></header>`;
}

function renderImagesSection(lessonId) {
  // Lesson page no longer inlines images — they're all behind the "📖 Xem sách"
  // button in the toolbar. Kept as a no-op so older callers don't break.
  return '';
}

function renderQuestions(questions, lessonId, title = '練習') {
  if (!Array.isArray(questions) || !questions.length) return '';
  const groups = groupQuestionsBySection(questions);
  return `
    <section class="quiz-block" aria-labelledby="quiz-heading">
      <h3 class="subheading" id="quiz-heading" lang="ja">${escapeHtml(title)}</h3>
      ${groups.map((group) => `
        <div class="quiz-section">
          ${group.label ? `<h4 class="quiz-section-title" lang="ja">${escapeHtml(group.label)}</h4>` : ''}
          ${group.items.map((item) => renderQuestionItem(item, lessonId)).join('')}
        </div>`).join('')}
    </section>`;
}

// Grammar book splits practice into 練習I (binary a/b: choose correct form)
// and 練習II (4-blank word order: ＿＿ ＿＿ ＿＿ ＿＿). Each 練習II item is
// printed as 4 sibling questions, one per blank position, sharing the same
// sentence + 4 candidate words but each asking independently "what goes at
// position N" with its own answer — NOT one combined reorder-all-4 puzzle.
// (An earlier version collapsed these into a single multi-slot widget, but
// that answered nothing until all 4 slots were filled, and a bug marked the
// whole thing "answered" after the very first click — silently ignoring
// every click after that. Rendering each sibling as its own normal
// single-choice question sidesteps both problems and matches the book.)
function groupQuestionsBySection(questions) {
  const groups = [];
  let current = { label: '', items: [] };
  const pushCurrent = () => { if (current.items.length) groups.push(current); current = { label: '', items: [] }; };
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const opts = Array.isArray(q?.options) ? q.options : [];
    if (opts.length === 2 && current.label !== '練習Ⅰ') {
      pushCurrent();
      current.label = '練習Ⅰ';
    } else if (opts.length >= 3 && current.label !== '練習Ⅱ') {
      pushCurrent();
      current.label = '練習Ⅱ';
    }
    current.items.push({ ...q, _originalIndex: i });
  }
  pushCurrent();
  return groups;
}

function renderQuestionItem(question, lessonId, questionIndex) {
  const options = Array.isArray(question?.options) ? question.options : [];
  const headerIndex = question?._originalIndex ?? questionIndex;
  const header = renderQuestionHeader(lessonId, headerIndex);
  const correct = answerIndex(question);
  // Book-style "price tag" for reading questions whose options are amounts
  // of money (e.g. "7,000円" / "8,000円"). Rendered as a row of circular
  // price pills alongside the prompt.
  const isPriceQuestion = options.length >= 2
    && options.every((o) => /[\d,]+円/.test(String(o).replace(/\{([^|}]+)\|[^}]+\}/g, '$1')));
  const priceTags = isPriceQuestion
    ? `<div class="price-tag-row" aria-label="選択肢（金額）">${options.map((o, i) => `<button type="button" class="price-tag" data-action="quiz-option" data-idx="${i}" lang="ja">${renderFurigana(o)}</button>`).join('')}</div>`
    : '';
  return `
    <div class="quiz-question${isPriceQuestion ? ' quiz-question-price' : ''}" data-correct-idx="${correct}" data-review-key="${escapeHtml(`${lessonId}:q${headerIndex}`)}">
      ${header}
      <div class="quiz-q-text" lang="ja">${renderFurigana(question?.prompt || question?.q || '')}</div>
      ${priceTags}
      <div class="quiz-options"${isPriceQuestion ? ' hidden' : ''}>
        ${options.map((option, optionIndex) => `<button type="button" class="quiz-option" data-action="quiz-option" data-idx="${optionIndex}" lang="ja">${renderFurigana(option)}</button>`).join('')}
      </div>
      <div class="quiz-explain" role="status" hidden></div>
    </div>`;
}

function renderKanji(lessonId, content) {
  // Vietnamese explanations (data/book/kanji.vietnamese.json) are one string
  // per kanji card, in kanji[] order followed by reviewKanji[] order — the
  // exact same flattening scripts/generate-vietnamese-explanations.mjs uses.
  const kanjiList = Array.isArray(content.kanji) ? content.kanji : [];
  const cards = kanjiList.map((item, index) => `
    <article class="kanji-item">
      <div class="kanji-char-row">
        <div class="kanji-char">${wordButton(item?.char || '', [item?.on, item?.kun].filter(Boolean).join(' / '))}</div>
        <button type="button" class="kanji-writing-trigger" data-action="practice-kanji" data-kanji="${escapeHtml(item?.char || '')}" aria-label="Luyện viết chữ ${escapeHtml(item?.char || '')}" title="Luyện viết"><span aria-hidden="true">✎</span></button>
      </div>
      <div class="kanji-readings" lang="ja">
        ${item?.on ? `<span class="kanji-on">音: ${escapeHtml(item.on)}</span>` : ''}
        ${item?.kun ? `<span class="kanji-kun">訓: ${escapeHtml(item.kun)}</span>` : ''}
        ${Number.isFinite(Number(item?.strokes)) ? `<span>${escapeHtml(item.strokes)} nét</span>` : ''}
      </div>
      ${(() => { const vi = getVietnameseExplanation(lessonId, index); return vi ? `<p class="kanji-vi">${escapeHtml(vi)}</p>` : ''; })()}
      <ul class="kanji-word-list">
        ${(Array.isArray(item?.words) ? item.words : []).map((word) => `<li>${wordButton(word?.jp || '', word?.reading || '')}${word?.en ? `<span class="book-meaning" lang="en">${escapeHtml(word.en)}</span>` : ''}</li>`).join('')}
      </ul>
    </article>`).join('');
  const review = Array.isArray(content.reviewKanji) ? content.reviewKanji : [];
  return `
    <section class="content-section kanji-section">
      <h2 class="section-heading">Hán tự</h2>
      ${renderImagesSection(lessonId)}
      <div class="kanji-grid">${cards || '<p class="text-muted">Không có mục Hán tự trong bài này.</p>'}</div>
      ${review.length ? `<section class="review-kanji"><h3 class="subheading" lang="ja">よめるかな？</h3><div class="review-kanji-list">${review.map((item) => wordButton(item?.char || '', [item?.on, item?.kun].filter(Boolean).join(' / '))).join('')}</div></section>` : ''}
      ${renderQuestions(content.practice, lessonId, '練習')}
    </section>`;
}

function renderVocabulary(lessonId, content) {
  // Vietnamese explanations (data/book/vocabulary.vietnamese.json) are one
  // string per word, flattened across every section's words[] in order —
  // the exact same flattening scripts/generate-vietnamese-explanations.mjs
  // uses — so the index counter runs across sections, not per-section.
  let wordIndex = 0;
  const sections = (Array.isArray(content.sections) ? content.sections : []).map((section) => `
    <section class="vocab-book-section">
      ${section?.heading ? `<h3 class="subheading" lang="ja">${renderFurigana(section.heading)}</h3>` : ''}
      <div class="vocab-list">
        ${(Array.isArray(section?.words) ? section.words : []).map((word) => {
          const vi = getVietnameseExplanation(lessonId, wordIndex);
          wordIndex += 1;
          return `
          <article class="vocab-item">
            <div class="vocab-word">${wordButton(word?.jp || '', word?.reading || '')}</div>
            ${word?.en ? `<div class="vocab-meaning" lang="en">${escapeHtml(word.en)}</div>` : ''}
            ${vi ? `<div class="vocab-meaning-vi">${escapeHtml(vi)}</div>` : ''}
            ${word?.note ? `<div class="lesson-notes" lang="en">${escapeHtml(word.note)}</div>` : ''}
          </article>`;
        }).join('')}
      </div>
    </section>`).join('');
  return `<section class="content-section vocab-section"><h2 class="section-heading">Từ vựng</h2>${renderImagesSection(lessonId)}${sections}${renderQuestions(content.practice, lessonId, '練習 · Luyện tập')}</section>`;
}

function renderGrammar(lessonId, content) {
  // Vietnamese explanations (data/book/grammar.vietnamese.json) are one
  // string per pattern, in patterns[] order.
  const patterns = (Array.isArray(content.patterns) ? content.patterns : []).map((pattern, index) => `
    <article class="grammar-point">
      <h3 class="grammar-title" lang="ja">${renderGrammarNotation(pattern?.form || '')}</h3>
      ${pattern?.meaningEn ? `<p class="grammar-meaning" lang="en">${escapeHtml(pattern.meaningEn)}</p>` : ''}
      ${(() => { const vi = getVietnameseExplanation(lessonId, index); return vi ? `<p class="grammar-meaning-vi">${escapeHtml(vi)}</p>` : ''; })()}
      ${pattern?.connection ? `<p class="grammar-formation"><strong>Kết nối:</strong> <span lang="ja">${renderGrammarNotation(pattern.connection)}</span></p>` : ''}
      ${(Array.isArray(pattern?.examples) ? pattern.examples : []).map((example) => `
        <div class="example-box">
          ${renderJapaneseLine(example?.jp || '')}
          ${example?.en ? `<div class="vi-sentence example-meaning-en" lang="en">${escapeHtml(example.en)}</div>` : ''}
        </div>`).join('')}
    </article>`).join('');
  return `<section class="content-section grammar-section"><h2 class="section-heading">Ngữ pháp</h2>${patterns}${renderQuestions(content.practice, lessonId, '練習 · Luyện tập')}</section>`;
}

// Detect lines that look like a speaker turn in dialogue:
// "夫：" / "妻：" / "店の人：" / "アナウンス：" / "ナレーター：" / etc.
// Anything before a Japanese colon (：or :) + at least one kanji.
const SPEAKER_LINE = /^[^\s：:]{1,8}[：:]\s*/;

// Detect a passage that is a "document mock" — a printed DM / flyer / form
// with price tags, special headings, dates. Heuristic: more than 2 lines
// contain currency symbols (円/% OFF) or full-width date patterns.
const DOCUMENT_HINT = /(?:円|％|%|OFF|年会費|月会費|有効期限|開催期間|特典|20XX|年.{0,3}月.{0,3}日)/;

function classifyPassage(lines) {
  let dialogueHits = 0;
  let documentHits = 0;
  for (const line of lines) {
    if (SPEAKER_LINE.test(line)) dialogueHits++;
    if (DOCUMENT_HINT.test(line)) documentHits++;
  }
  if (dialogueHits >= 2) return 'dialogue';
  if (documentHits >= 3) return 'document';
  return 'plain';
}

function renderDialoguePassage(lines) {
  return `<div class="script-frame">${lines.map((line, idx) => {
    const m = line.match(SPEAKER_LINE);
    if (m) {
      const speaker = m[0].replace(/[：:]\s*$/, '');
      const rest = line.slice(m[0].length);
      return `<p class="line"><span class="num">${idx + 1}</span><span><span class="speaker">${escapeHtml(speaker)}</span>${renderFurigana(rest)}</span></p>`;
    }
    return `<p class="line"><span class="num">${idx + 1}</span><span>${renderFurigana(line)}</span></p>`;
  }).join('')}</div>`;
}

// A document-mock passage: detect heading-like lines (text matching one
// of a short whitelist of DM-style section headers) and render them as
// black pills; everything else stays as plain text.
const DOC_HEADING_WORDS = /^(開催期間|特典[12]|店名|期間|対象商品|条件|料金|サービス内容|ご注意|有効期限)$/;

function renderDocumentPassage(lines) {
  return `<div class="dm-frame">${lines.map((line) => {
    if (DOC_HEADING_WORDS.test(line.trim())) {
      return `<div class="dm-row heading">${escapeHtml(line.trim())}</div>`;
    }
    return `<div class="dm-row">${renderFurigana(line)}</div>`;
  }).join('')}</div>`;
}

function renderReading(lessonId, content) {
  const passages = (Array.isArray(content.passages) ? content.passages : []).map((passage) => {
    const lines = String(passage?.text || '').split(/\n+/).filter(Boolean);
    const fullText = lines.join('\n');
    const kind = classifyPassage(lines);
    const heading = passage?.heading
      ? `<div class="passage-title-row"><h3 class="passage-title" lang="ja">${renderFurigana(passage.heading)}</h3>${ttsButton(fullText)}</div>`
      : `<div class="passage-title-row">${ttsButton(fullText)}</div>`;
    const body = kind === 'dialogue'
      ? renderDialoguePassage(lines)
      : kind === 'document'
        ? renderDocumentPassage(lines)
        : lines.map((line) => renderJapaneseLine(line, 'passage-line', { tts: false })).join('');
    return `
    <article class="passage-block">
      ${heading}
      ${body}
    </article>`;
  }).join('');
  return `
    <section class="content-section reading-section">
      <h2 class="section-heading">Đọc hiểu</h2>
      ${content.intro ? `<p class="section-intro" lang="ja">${renderFurigana(content.intro)}</p>` : ''}
      ${renderImagesSection(lessonId)}
      ${passages}
      ${renderQuestions(content.questions, lessonId, 'Câu hỏi đọc hiểu')}
    </section>`;
}

function renderListening(lessonId, content) {
  const scriptLines = String(content.script || '').split(/\n+/).filter(Boolean);
  const scriptFull = scriptLines.join('\n');
  const scriptKind = classifyPassage(scriptLines);
  const scriptBody = scriptKind === 'dialogue'
    ? renderDialoguePassage(scriptLines)
    : scriptLines.map((line) => renderJapaneseLine(line, 'transcript-line', { tts: false })).join('');
  const script = `${scriptLines.length ? `<div class="script-title-row"><h3 class="subheading" lang="ja">Bản ghi</h3>${ttsButton(scriptFull)}</div>` : ''}${scriptBody}`;
  const audioTracks = Array.isArray(content.audioTracks) ? content.audioTracks : [];
  const introTracks = Array.isArray(content.introTracks) ? content.introTracks : [];
  const coverage = content.audioCoverage && typeof content.audioCoverage === 'object'
    ? content.audioCoverage
    : null;
  const trackMarkup = audioTracks.length
    ? `<div class="lesson-audio-list">${audioTracks.map((track) => `
        <figure class="lesson-audio-track">
          <figcaption>${escapeHtml(track?.label || 'Audio')}</figcaption>
          <audio controls preload="metadata" data-lesson-audio-key="${escapeHtml(track?.src || '')}">Trình duyệt không hỗ trợ phát âm thanh.</audio>
        </figure>`).join('')}</div>`
    : content.audio
      ? `<audio class="lesson-audio" controls preload="metadata" data-lesson-audio-key="${escapeHtml(content.audio)}">Trình duyệt không hỗ trợ phát âm thanh.</audio>`
      : '<p class="text-muted">Bản ghi bài tập của bài này chưa có trong bộ nguồn cục bộ.</p>';
  const coverageMarkup = coverage
    ? `<p class="audio-coverage audio-coverage--${escapeHtml(coverage.status || 'missing')}" role="status">Audio bài tập: ${escapeHtml(coverage.present ?? 0)}/${escapeHtml(coverage.required ?? 0)} track cục bộ${Number(coverage.missing) > 0 ? ` · thiếu ${escapeHtml(coverage.missing)}` : ' · đủ bộ'}.</p>`
    : '';
  const introMarkup = introTracks.length
    ? `<details class="lesson-audio-intros"><summary>Audio giới thiệu chương (${introTracks.length})</summary>${introTracks.map((track) => `
        <figure class="lesson-audio-track">
          <figcaption>${escapeHtml(track?.label || 'Intro')}</figcaption>
          <audio controls preload="metadata" data-lesson-audio-key="${escapeHtml(track?.src || '')}">Trình duyệt không hỗ trợ phát âm thanh.</audio>
        </figure>`).join('')}</details>`
    : '';
  return `
    <section class="content-section listening-section">
      <h2 class="section-heading">Nghe hiểu</h2>
      ${coverageMarkup}${trackMarkup}${introMarkup}
      ${renderImagesSection(lessonId)}
      ${script ? `<div class="transcript-block">${script}</div>` : ''}
      ${renderQuestions(content.questions, lessonId, 'Câu hỏi nghe hiểu')}
    </section>`;
}

function renderBookContent(categoryId, content, lessonId = '') {
  if (!content || typeof content !== 'object') return `
    <div class="lesson-empty-state" role="status">
      <p>Nội dung sách của bài này chưa được trích xuất và xác minh.</p>
      <p class="text-muted">Ứng dụng không tự sáng tác nội dung thay cho sách.</p>
    </div>`;
  if (categoryId === 'kanji') return renderKanji(lessonId, content);
  if (categoryId === 'vocabulary') return renderVocabulary(lessonId, content);
  if (categoryId === 'grammar') return renderGrammar(lessonId, content);
  if (categoryId === 'reading') return renderReading(lessonId, content);
  if (categoryId === 'listening') return renderListening(lessonId, content);
  return '<p class="text-muted">Không có renderer cho danh mục này.</p>';
}

function renderToolbar(done, bookmarked) {
  return `
    <div class="lesson-toolbar">
      <button type="button" class="back-btn" data-action="back">← Quay lại</button>
      <div class="lesson-toolbar-actions">
        <button type="button" class="furigana-toggle-btn" data-action="toggle-furigana" aria-pressed="${getFurigana()}">${getFurigana() ? 'あ' : 'ア'}<span class="sr-only">Furigana</span></button>
        <button type="button" class="bookmark-btn${bookmarked ? ' is-saved' : ''}" data-action="bookmark" aria-pressed="${bookmarked}" aria-label="${bookmarked ? 'Bỏ lưu bài học' : 'Lưu bài học'}">${bookmarked ? '★' : '☆'}</button>
        <button type="button" class="complete-toggle-btn${done ? ' is-done' : ''}" data-action="toggle-complete" aria-pressed="${done}">${done ? 'Bỏ đánh dấu' : 'Đánh dấu đã học'}</button>
      </div>
    </div>`;
}

function pageHtml(found, lessonId, content) {
  const { lesson, category, week } = found;
  const unit = category?.id === 'listening' ? 'Chương' : 'Tuần';
  const title = content?.title || lesson.title || '';
  const titleEn = content?.titleEn || lesson.titleEn || '';
  return `
    <article class="lesson-page">
      ${renderToolbar(isDone(lesson.id), learningState.isBookmarked(lesson.id))}
      <header class="lesson-header">
        <div class="lesson-header-meta">${escapeHtml(category?.name || '')} • ${unit} ${escapeHtml(week?.week ?? '')} • Ngày ${escapeHtml(lesson.day ?? '')}</div>
        <div class="lesson-header-title-row">
          <h1 class="lesson-header-title" data-route-heading lang="ja">${renderFurigana(title)}</h1>
          <button type="button" class="view-book-btn view-book-btn-header" data-action="view-book" aria-label="Xem trang sách">📖 Xem sách</button>
        </div>
        ${titleEn ? `<p class="lesson-title-en" lang="en">${escapeHtml(titleEn)}</p>` : ''}
      </header>
      <nav class="lesson-local-nav" aria-label="Mục lục bài học">
        <a href="#lesson-content">Nội dung</a>
        <a href="#lesson-practice" data-lesson-practice-link>Luyện tập</a>
        <button type="button" data-action="ask-tutor">Gia sư</button>
        <span class="lesson-local-progress"><strong data-lesson-progress-text>0/0 câu</strong><progress max="1" value="0" data-lesson-progress aria-label="Tiến độ câu luyện tập"></progress></span>
      </nav>
      <div class="lesson-body" id="lesson-content">${renderBookContent(category?.id, content, lessonId)}</div>
      <div class="lesson-footer-actions">
        <button type="button" class="tutor-lesson-btn" data-action="ask-tutor">🎓 Hỏi gia sư AI</button>
        <button type="button" class="back-btn back-btn-bottom" data-action="back">← Quay lại tổng quan</button>
      </div>
    </article>`;
}

function handleQuiz(button, lessonId, categoryId) {
  const container = button.closest('.quiz-question');
  if (!container || container.classList.contains('is-answered')) return;
  container.classList.add('is-answered');
  const correct = Number(container.dataset.correctIdx);
  const selected = Number(button.dataset.idx);
  // Pick the selector set: price-tag questions have hidden .quiz-options
  // and use .price-tag instead.
  const targets = container.classList.contains('quiz-question-price')
    ? [...container.querySelectorAll('.price-tag')]
    : [...container.querySelectorAll('.quiz-option')];
  targets.forEach((option) => {
    option.disabled = true;
    const index = Number(option.dataset.idx);
    if (correct >= 0 && index === correct) option.classList.add('is-correct');
    else if (index === selected) option.classList.add(correct < 0 ? 'is-unverified' : 'is-incorrect');
  });
  const status = container.querySelector('.quiz-explain');
  if (status) {
    status.hidden = false;
    const correctTarget = targets[correct];
    status.textContent = correct >= 0 && correctTarget
      ? `Đáp án: ${correctTarget.textContent.trim()}`
      : 'Đáp án của câu này chưa được xác minh.';
  }
  const reviewKey = container.dataset.reviewKey || `${lessonId}:quiz`;
  const wasCorrect = selected === correct;
  const alreadyTracked = learningState.getReviews().some((review) => review.key === reviewKey);
  if (correct >= 0 && (!wasCorrect || alreadyTracked)) {
    learningState.recordReview({
      key: reviewKey,
      lessonId,
      categoryId,
      prompt: container.querySelector('.quiz-q-text')?.textContent?.trim() || 'Câu hỏi ôn tập',
      correctAnswer: targets[correct]?.textContent?.trim() || '',
      options: targets.map((target) => target.textContent?.trim() || ''),
      correctIndex: correct,
      selectedAnswer: targets[selected]?.textContent?.trim() || '',
      source: 'lesson',
      correct: wasCorrect,
      now: new Date(),
    });
  }
  if (correct >= 0 && !wasCorrect && !container.querySelector('.quiz-inline-coach')) {
    container.insertAdjacentHTML('beforeend', `
      <div class="quiz-inline-coach">
        <span>Đã ghi vào sổ lỗi và lên lịch ôn.</span>
        <button type="button" class="study-btn" data-action="ask-tutor">Hỏi gia sư về lỗi này</button>
      </div>`);
  }
  updateLessonProgress(container.closest('.lesson-page'));
}

function updateLessonProgress(scope) {
  if (!scope) return;
  const questions = [...scope.querySelectorAll('.quiz-question')];
  const answered = questions.filter((question) => question.classList.contains('is-answered')).length;
  const output = scope.querySelector('[data-lesson-progress-text]');
  const progress = scope.querySelector('[data-lesson-progress]');
  if (output) output.textContent = `${answered}/${questions.length} câu`;
  if (progress) {
    progress.max = Math.max(1, questions.length);
    progress.value = answered;
    progress.setAttribute('aria-label', `Đã làm ${answered} trên ${questions.length} câu luyện tập`);
  }
  const block = scope.querySelector('.quiz-block');
  const link = scope.querySelector('[data-lesson-practice-link]');
  if (block) block.id = 'lesson-practice';
  if (link) {
    link.hidden = !block;
    link.setAttribute('aria-disabled', String(!block));
  }
}

function lessonContext(found, content) {
  const compact = JSON.stringify(content || {}).slice(0, 10000);
  return {
    lessonId: found.lesson.id,
    category: found.category?.name || found.category?.id || '',
    title: plainJapanese(content?.title || found.lesson.title || ''),
    titleEn: content?.titleEn || found.lesson.titleEn || '',
    content: compact,
  };
}

export function renderLesson(root, id) {
  let popup = null;
  let popupTrigger = null;
  let popupDialog = null;
  let tutorModal = null;
  let tutorController = null;
  let tutorTrigger = null;
  let tutorDialog = null;
  let bookViewer = null;
  let bookViewerTrigger = null;
  let bookViewerDialog = null;
  let writingPad = null;
  const studyTimer = startLessonTimer(id);

  const closePopup = () => {
    if (!popup) return;
    popupDialog?.release();
    popupDialog = null;
    popup.remove();
    popup = null;
    popupTrigger?.focus?.();
    popupTrigger = null;
  };

  const closeTutorModal = () => {
    if (!tutorModal) return;
    tutorController?.cleanup?.();
    tutorController = null;
    tutorDialog?.release();
    tutorDialog = null;
    tutorModal.remove();
    tutorModal = null;
    tutorTrigger?.focus?.();
    tutorTrigger = null;
  };

  const paint = () => {
    const found = findLesson(id);
    if (!found) {
      root.innerHTML = '<div class="lesson-page lesson-not-found"><p role="alert">Không tìm thấy bài học.</p><button type="button" class="back-btn" data-action="back">← Quay lại</button></div>';
      return;
    }
    root.innerHTML = pageHtml(found, id, getBookContent(id));
    updateLessonProgress(root.querySelector('.lesson-page'));
    hydrateLessonAudio(root);
  };

  // Shared popup lifecycle for both tap-a-word (definition) and tap-a-sentence
  // (translation) explanations — same backdrop/cache/error handling, different prompt.
  const showExplanationPopup = async ({ trigger, titleHtml, cacheKey, buildPrompt }) => {
    closePopup();
    popupTrigger = trigger;
    const cached = getKanjiGloss(cacheKey);
    const dialog = document.createElement('div');
    dialog.className = 'word-popup-backdrop';
    dialog.innerHTML = `
      <section class="word-popup" role="dialog" aria-modal="true" aria-labelledby="word-popup-title">
        <button type="button" class="word-popup-close" data-popup-close aria-label="Đóng giải thích">×</button>
        <h2 id="word-popup-title" lang="ja">${titleHtml}</h2>
        <div class="word-popup-body" role="status" aria-live="polite">${cached ? renderFurigana(cached) : 'Đang hỏi Gemini…'}</div>
      </section>`;
    document.body.appendChild(dialog);
    popup = dialog;
    dialog.querySelector('[data-popup-close]')?.addEventListener('click', closePopup);
    dialog.addEventListener('click', (event) => { if (event.target === dialog) closePopup(); });
    popupDialog = activateModalDialog(dialog, {
      trigger,
      initialFocus: dialog.querySelector('[data-popup-close]'),
      onEscape: closePopup,
    });
    if (cached) return;

    const epoch = getCurrentRoute().epoch;
    try {
      const result = await askText(buildPrompt());
      if (!isRouteActive('lesson', id, epoch)) return;
      setKanjiGloss(cacheKey, result);
      const body = popup?.querySelector('.word-popup-body');
      if (body) body.innerHTML = renderFurigana(result);
    } catch (error) {
      const body = popup?.querySelector('.word-popup-body');
      if (body) body.textContent = `Không thể tải giải thích: ${error?.message || 'lỗi không xác định'}`;
    }
  };

  const openExplanation = (button) => {
    const word = button.dataset.word || '';
    const reading = button.dataset.reading || '';
    if (!word) return;
    const found = findLesson(id);
    const lessonTitle = plainJapanese(getBookContent(id)?.title || found?.lesson?.title || '');
    const context = button.closest('.kanji-item, .vocab-item, .example-box, .quiz-question, .transcript-line')
      ?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 320) || '';
    return showExplanationPopup({
      trigger: button,
      titleHtml: `${escapeHtml(word)}${reading ? `（${escapeHtml(reading)}）` : ''}`,
      cacheKey: `${id}|word|${word}|${reading}|${context}`,
      buildPrompt: () => ({
        system: 'Bạn là giáo viên tiếng Nhật N2. Trả lời ngắn gọn bằng tiếng Việt, không dùng HTML.',
        user: `Người học vừa bấm vào 「${word}」${reading ? `(${reading})` : ''} trong bài "${lessonTitle}"${context ? `, ngữ cảnh: "${context}"` : ''}. Hãy giải thích ngắn gọn bằng tiếng Việt nghĩa phù hợp ngữ cảnh và cách dùng. Kèm 1 ví dụ ngắn có furigana {漢字|かな}.`,
      }),
    });
  };

  const openSentenceExplanation = (button) => {
    const jp = plainJapanese(button.dataset.jp || '');
    if (!jp) return;
    const found = findLesson(id);
    const lessonTitle = plainJapanese(getBookContent(id)?.title || found?.lesson?.title || '');
    return showExplanationPopup({
      trigger: button,
      titleHtml: 'Dịch sang tiếng Việt',
      cacheKey: `${id}|sentence|${jp}`,
      buildPrompt: () => ({
        system: 'Bạn là giáo viên tiếng Nhật N2. Trả lời ngắn gọn bằng tiếng Việt, không dùng HTML.',
        user: `Người học vừa bấm vào câu tiếng Nhật sau trong bài "${lessonTitle}": "${jp}". Hãy dịch câu này sang tiếng Việt, và nếu có điểm ngữ pháp hoặc từ vựng đáng chú ý thì giải thích thật ngắn gọn.`,
      }),
    });
  };

  const onClick = async (event) => {
    const image = event.target.closest('.lesson-image-figure img');
    if (image) {
      if (document.fullscreenElement === image) document.exitFullscreen?.();
      else image.requestFullscreen?.();
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'back') navigate('#/');
    else if (action === 'toggle-furigana') { setFurigana(!getFurigana()); paint(); }
    else if (action === 'toggle-complete') {
      const found = findLesson(id);
      const result = await toggleLessonCompletion({ lessonId: id, categoryId: found?.category?.id || '' });
      if (result.requiresAuth) return;
      paint();
    }
    else if (action === 'bookmark') {
      learningState.toggleBookmark(id);
      paint();
    }
    else if (action === 'view-book') openBookViewer(button);
    else if (action === 'speak') speak(button.dataset.jp || '');
    else if (action === 'quiz-option') handleQuiz(button, id, findLesson(id)?.category?.id || '');
    else if (action === 'explain-word') openExplanation(button);
    else if (action === 'explain-sentence') openSentenceExplanation(button);
    else if (action === 'practice-kanji') {
      writingPad?.close?.();
      writingPad = openKanjiWritingPad({ character: button.dataset.kanji || '', trigger: button });
    }
    else if (action === 'ask-tutor') openTutorModal(button);
  };

  const openTutorModal = (trigger) => {
    const found = findLesson(id);
    if (!found) return;
    closeTutorModal();
    clearTutorHistory();
    setTutorContext(lessonContext(found, getBookContent(id)));
    tutorTrigger = trigger;
    const dialog = document.createElement('div');
    dialog.className = 'modal-overlay active tutor-modal-overlay';
    dialog.innerHTML = `
      <div class="modal-card tutor-modal-card" role="dialog" aria-modal="true" aria-labelledby="tutor-modal-title">
        <div class="modal-header">
          <h3 id="tutor-modal-title">🎓 Hỏi gia sư AI</h3>
          <button type="button" class="modal-close" data-tutor-modal-close aria-label="Đóng gia sư AI">×</button>
        </div>
        <div class="modal-body tutor-modal-body"></div>
      </div>`;
    document.body.appendChild(dialog);
    tutorModal = dialog;
    dialog.querySelector('[data-tutor-modal-close]')?.addEventListener('click', closeTutorModal);
    dialog.addEventListener('click', (event) => { if (event.target === dialog) closeTutorModal(); });
    tutorController = renderTutor(dialog.querySelector('.tutor-modal-body'));
    tutorDialog = activateModalDialog(dialog, {
      trigger,
      initialFocus: dialog.querySelector('[data-tutor-modal-close]'),
      onEscape: closeTutorModal,
    });
  };

  const closeBookViewer = () => {
    if (!bookViewer) return;
    bookViewerDialog?.release();
    bookViewerDialog = null;
    bookViewer.remove();
    bookViewer = null;
    bookViewerTrigger?.focus?.();
    bookViewerTrigger = null;
  };

  const openBookViewer = (trigger) => {
    const pages = buildBookViewerModel(getLessonImages(id));
    if (!pages.length) {
      alert('Bài này chưa có ảnh trang sách.');
      return;
    }

    closeBookViewer();
    bookViewerTrigger = trigger;
    const dialog = document.createElement('div');
    dialog.className = 'modal-overlay active book-viewer-overlay';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Xem trang sách');
    dialog.innerHTML = `
      <div class="modal-card book-viewer-card">
        <div class="modal-header">
          <h3 lang="ja">📖 ${escapeHtml(plainJapanese(getBookContent(id)?.title || ''))}</h3>
          <button type="button" class="modal-close" data-book-viewer-close aria-label="Đóng trình đọc sách">×</button>
        </div>
        <div class="modal-body book-viewer-body">
          ${renderBookViewerStrip(pages)}
        </div>
      </div>`;
    document.body.appendChild(dialog);
    bookViewer = dialog;
    dialog.querySelector('[data-book-viewer-close]')?.addEventListener('click', closeBookViewer);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeBookViewer();
    });
    bookViewerDialog = activateModalDialog(dialog, {
      trigger,
      initialFocus: dialog.querySelector('[data-book-viewer-close]'),
      onEscape: closeBookViewer,
    });
    dialog.querySelector('.book-viewer-body')?.addEventListener('click', (event) => {
      const image = event.target.closest('.book-viewer-page');
      if (!image) return;
      if (document.fullscreenElement) document.exitFullscreen?.();
      else image.closest('.book-viewer-strip')?.requestFullscreen?.();
    });
  };

  root.addEventListener('click', onClick);
  paint();

  return {
    cleanup() {
      root.removeEventListener('click', onClick);
      closePopup();
      closeTutorModal();
      closeBookViewer();
      writingPad?.close?.();
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
      studyTimer.flush();
    },
  };
}

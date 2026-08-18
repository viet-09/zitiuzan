// js/tutor.js
// AI text tutor chat: renders inside #app, persists conversation via store.js,
// drives Gemini through gemini.js, and renders Japanese via furigana.js.

import { TUTOR_SYSTEM_PROMPT } from './config.js';
import {
  getTutorHistory,
  setTutorHistory,
  clearTutorHistory,
  getTutorContext,
  setTutorContext,
  getTutorMemory,
  setTutorMemory,
} from './store.js';
import { getProfile } from './profile.js';
import { renderFurigana } from './furigana.js';
import { askText, openSettings } from './gemini.js';
import { learningState } from './learning-state.js';
import { buildWeaknessProfile, formatWeaknessContext } from './learning-engine.js';

// How many new chat turns (user+model) pass between background memory refreshes.
const MEMORY_REFRESH_EVERY = 6;
let memoryRefreshInFlight = false;

const FIRST_CHALLENGE_PROMPT = '始めましょう。最初の課題をください。';

// Module state — one tutor view is mounted at a time.
let rootEl = null;
let history = [];
let isLoading = false;
let errorText = null;
let lessonContext = null;
let weaknessProfile = null;
let mountToken = 0;

function systemPrompt() {
  let prompt = TUTOR_SYSTEM_PROMPT;

  const name = (getProfile()?.name || '').trim();
  if (name) {
    prompt += `\n\nTên người học: ${name}. Hãy chào hỏi và xưng hô với người học bằng tên này một cách tự nhiên, thân thiện — không cần lặp lại ở mọi câu.`;
  }

  const memory = getTutorMemory().trim();
  if (memory) {
    prompt += `\n\nGhi nhớ về người học từ các buổi học trước (thói quen, lỗi thường gặp, chủ đề quan tâm, cách trò chuyện họ thích) — áp dụng một cách tự nhiên khi phù hợp, không đọc lại nguyên văn: ${memory}`;
  }

  if (lessonContext) {
    prompt += `\n\nNgữ cảnh bài học đang mở (nội dung nguồn sách, không được thay thế hoặc bịa thêm):\nDanh mục: ${lessonContext.category || ''}\nTiêu đề: ${lessonContext.title || ''}\nTiêu đề tiếng Anh: ${lessonContext.titleEn || ''}\nDữ liệu: ${lessonContext.content || ''}\nHãy tập trung câu hỏi và giải thích vào đúng bài này.`;
  }

  const weaknessContext = formatWeaknessContext(weaknessProfile);
  if (weaknessContext) {
    prompt += `\n\nHồ sơ điểm yếu được ghi tự động từ các câu người học đã làm (dùng đúng dữ liệu này, không bịa thêm):\n${weaknessContext}\nƯu tiên điểm yếu đang đến hạn và hỏi từng câu ngắn một. Sau mỗi câu, giải thích vì sao đáp án cũ dễ nhầm rồi mới chuyển sang thử thách tiếp theo.`;
  }

  return prompt;
}

// Best-effort, silent background summary of the learner's habits/style so future
// sessions (and other lesson-seeded chats) can pick up where this one left off.
// Never blocks the visible conversation and never surfaces its own errors.
async function maybeRefreshMemory() {
  if (memoryRefreshInFlight) return;
  if (history.length < MEMORY_REFRESH_EVERY || history.length % MEMORY_REFRESH_EVERY !== 0) return;
  memoryRefreshInFlight = true;
  try {
    const priorMemory = getTutorMemory().trim();
    const recent = history.slice(-MEMORY_REFRESH_EVERY * 2);
    const transcript = recent.map((m) => `${m.role === 'user' ? 'Học viên' : 'Gia sư'}: ${m.text}`).join('\n');
    const summary = await askText({
      system: 'Bạn là trợ lý tổng hợp hồ sơ học viên. Chỉ trả về một đoạn ghi chú ngắn (dưới 500 ký tự), tiếng Việt, không chào hỏi, không lặp lại hội thoại — mô tả thói quen học, lỗi thường lặp lại, chủ đề quan tâm, và cách trò chuyện học viên có vẻ thích. Nếu có ghi chú cũ, hãy cập nhật/hợp nhất thay vì viết lại từ đầu.',
      history: [],
      user: `Ghi chú cũ (nếu có): ${priorMemory || '(chưa có)'}\n\nĐoạn hội thoại gần đây:\n${transcript}`,
    });
    setTutorMemory(summary);
  } catch {
    // Silent — this is a nice-to-have, never worth surfacing an error for.
  } finally {
    memoryRefreshInFlight = false;
  }
}

/**
 * Render the tutor chat UI into `root`.
 * @param {HTMLElement} root
 */
export function renderTutor(root) {
  const token = ++mountToken;
  rootEl = root;
  isLoading = false;
  errorText = null;
  history = getTutorHistory();
  lessonContext = getTutorContext();
  const reviews = learningState.getReviews();
  weaknessProfile = buildWeaknessProfile(reviews, {
    lessonId: lessonContext?.lessonId || '',
    limit: 5,
  });
  if (!weaknessProfile.total && lessonContext?.lessonId) {
    weaknessProfile = buildWeaknessProfile(reviews, { limit: 5 });
  }

  root.innerHTML = shellTemplate();
  bindShellEvents();
  paintMessages();

  if (history.length === 0) {
    fetchFirstChallenge(token);
  } else {
    scrollToBottom();
  }

  return {
    cleanup() {
      if (mountToken === token) mountToken += 1;
      if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    },
  };
}

// ---------------------------------------------------------------------------
// Shell (rendered once per renderTutor call)
// ---------------------------------------------------------------------------

function shellTemplate() {
  return `
    <div class="chat-wrap">
      <h1 class="sr-only" data-route-heading>Gia sư AI</h1>
      ${lessonContext ? `<aside class="tutor-context-banner" aria-label="Ngữ cảnh bài học"><strong>Đang học:</strong> <span lang="ja">${renderFurigana(lessonContext.title || '')}</span><button type="button" id="tutor-context-clear" aria-label="Bỏ ngữ cảnh bài học">×</button></aside>` : ''}
      ${weaknessProfile?.total ? `<aside class="tutor-weakness-banner" aria-label="Điểm yếu đang ưu tiên"><strong>${weaknessProfile.due || weaknessProfile.total} điểm yếu ưu tiên</strong><span>Gia sư sẽ dùng đúng các lỗi đã ghi, không hỏi ngẫu nhiên.</span></aside>` : ''}
      <div class="chat-toolbar">
        <button type="button" id="tutor-clear-btn" class="chat-clear-btn">
          🗑️ Xóa hội thoại
        </button>
        <button type="button" id="tutor-settings-btn" class="chat-settings-btn">
          ⚙ Cài đặt
        </button>
      </div>
      <div class="chat-messages" id="tutor-messages" role="log" aria-live="polite" aria-relevant="additions text"></div>
      <form class="chat-input-row" id="tutor-form">
        <label for="tutor-input" class="sr-only">Câu trả lời hoặc câu hỏi cho gia sư</label>
        <input
          type="text"
          id="tutor-input"
          placeholder="Nhập câu trả lời của bạn..."
          autocomplete="off"
          autocapitalize="off"
        />
        <button
          type="submit"
          id="tutor-send-btn"
          class="chat-send-btn"
        >
          Gửi
        </button>
      </form>
    </div>
  `;
}

function bindShellEvents() {
  const form = rootEl.querySelector('#tutor-form');
  const clearBtn = rootEl.querySelector('#tutor-clear-btn');
  const settingsBtn = rootEl.querySelector('#tutor-settings-btn');
  const contextClearBtn = rootEl.querySelector('#tutor-context-clear');
  const messagesEl = rootEl.querySelector('#tutor-messages');

  if (form) {
    form.addEventListener('submit', (evt) => {
      evt.preventDefault();
      const input = rootEl.querySelector('#tutor-input');
      if (!input) return;
      const text = input.value;
      input.value = '';
      handleSend(text);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (isLoading) return;
      clearTutorHistory();
      history = [];
      errorText = null;
      paintMessages();
      fetchFirstChallenge(mountToken);
    });
  }

  contextClearBtn?.addEventListener('click', () => {
    setTutorContext(null);
    lessonContext = null;
    weaknessProfile = buildWeaknessProfile(learningState.getReviews(), { limit: 5 });
    rootEl.innerHTML = shellTemplate();
    bindShellEvents();
    paintMessages();
  });

  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      openSettings();
    });
  }

  // Delegated click handler for per-message TTS buttons (survives innerHTML repaints
  // of #tutor-messages because the container element itself is never replaced).
  if (messagesEl) {
    messagesEl.addEventListener('click', (evt) => {
      const btn = evt.target.closest('.tts-btn');
      if (!btn || !messagesEl.contains(btn)) return;
      const idx = Number(btn.getAttribute('data-tts-idx'));
      const msg = history[idx];
      if (msg && typeof msg.text === 'string') speak(msg.text);
    });
  }
}

// ---------------------------------------------------------------------------
// Message flow
// ---------------------------------------------------------------------------

async function fetchFirstChallenge(token = mountToken) {
  isLoading = true;
  errorText = null;
  paintMessages();
  setFormDisabled(true);

  try {
    const prompt = weaknessProfile?.total
      ? 'Hãy bắt đầu ngay bằng một câu hỏi ngắn nhắm vào điểm yếu ưu tiên số 1 trong hồ sơ; chưa đưa đáp án trước khi tôi trả lời.'
      : lessonContext
        ? 'Hãy bắt đầu bằng một câu hỏi hoặc thử thách ngắn dựa đúng vào bài học trong ngữ cảnh.'
        : FIRST_CHALLENGE_PROMPT;
    const reply = await askText({ system: systemPrompt(), history: [], user: prompt });
    if (token !== mountToken) return;
    history = [{ role: 'model', text: reply }];
    setTutorHistory(history);
    isLoading = false;
  } catch (err) {
    if (token !== mountToken) return;
    isLoading = false;
    errorText = messageFromError(err);
  }

  setFormDisabled(false);
  paintMessages();
  scrollToBottom();
}

async function handleSend(rawText) {
  const text = String(rawText || '').trim();
  if (!text || isLoading) return;

  const priorHistory = history.slice();
  history = [...priorHistory, { role: 'user', text }];
  setTutorHistory(history);
  errorText = null;
  isLoading = true;
  paintMessages();
  setFormDisabled(true);
  scrollToBottom();

  const token = mountToken;
  try {
    const reply = await askText({ system: systemPrompt(), history: priorHistory, user: text });
    if (token !== mountToken) return;
    history = [...history, { role: 'model', text: reply }];
    setTutorHistory(history);
    isLoading = false;
    maybeRefreshMemory();
  } catch (err) {
    if (token !== mountToken) return;
    isLoading = false;
    errorText = messageFromError(err);
  }

  setFormDisabled(false);
  paintMessages();
  scrollToBottom();
}

function messageFromError(err) {
  const raw = err && err.message ? String(err.message) : 'Đã có lỗi không xác định.';
  return raw;
}

function setFormDisabled(disabled) {
  if (!rootEl) return;
  const input = rootEl.querySelector('#tutor-input');
  const sendBtn = rootEl.querySelector('#tutor-send-btn');
  const clearBtn = rootEl.querySelector('#tutor-clear-btn');
  if (input) input.disabled = disabled;
  if (sendBtn) sendBtn.disabled = disabled;
  if (clearBtn) clearBtn.disabled = disabled;
  if (!disabled && input) input.focus();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function paintMessages() {
  const container = rootEl && rootEl.querySelector('#tutor-messages');
  if (!container) return;

  const parts = history.map((msg, idx) => renderMessage(msg, idx));
  if (isLoading) parts.push(loadingBubble());
  if (errorText) parts.push(errorBubble(errorText));

  container.innerHTML = parts.join('') || emptyState();
}

function renderMessage(msg, idx) {
  const isUser = msg.role === 'user';
  const roleClass = isUser ? 'user' : 'model';

  const bodyHtml = isUser
    ? escapeHtml(msg.text).replace(/\r\n|\r|\n/g, '<br>')
    : renderFurigana(msg.text);

  const ttsBtn = isUser
    ? ''
    : `<button type="button" class="tts-btn" data-tts-idx="${idx}" aria-label="Phát âm">🔊</button>`;

  return `
    <div class="chat-msg ${roleClass}">
      <div class="chat-msg-row">
        <div class="chat-msg-bubble">${bodyHtml}</div>
        ${ttsBtn}
      </div>
    </div>
  `;
}

function loadingBubble() {
  return `
    <div class="chat-msg model chat-loading" role="status">
      <div class="chat-msg-bubble">
        Đang soạn câu trả lời…
      </div>
    </div>
  `;
}

function errorBubble(message) {
  return `
    <div class="chat-msg model chat-error" role="alert">
      <div class="chat-msg-bubble">
        ⚠️ Rất tiếc, đã có lỗi xảy ra: ${escapeHtml(message)}<br>
        Nếu chưa đăng nhập, hãy đăng nhập rồi thử lại — trợ lý AI cần tài khoản để hoạt động.
      </div>
    </div>
  `;
}

function emptyState() {
  return `
    <div class="chat-empty">
      Chưa có tin nhắn nào.
    </div>
  `;
}

function scrollToBottom() {
  const container = rootEl && rootEl.querySelector('#tutor-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip {base|reading} furigana markup down to the base text for TTS. */
function stripFuriganaMarkup(text) {
  return String(text).replace(/\{([^{}|]+)\|([^{}|]+)\}/g, '$1');
}

/** Speak Japanese text aloud using SpeechSynthesis (ja-JP), preferring a ja voice. */
function speak(text) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const plain = stripFuriganaMarkup(text);
  if (!plain.trim()) return;

  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(plain);
    utter.lang = 'ja-JP';
    const voices = window.speechSynthesis.getVoices();
    const jaVoice = voices.find((v) => v && v.lang && v.lang.toLowerCase().startsWith('ja'));
    if (jaVoice) utter.voice = jaVoice;
    window.speechSynthesis.speak(utter);
  } catch (err) {
    // Speech synthesis unsupported/blocked — silently ignore.
  }
}

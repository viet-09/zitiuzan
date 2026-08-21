// js/voice.js — Voice conversation trainer: topic picker → live roleplay → AI review.
// Exports: renderVoice(root)

import { VOICE_TOPICS } from './config.js';
import { renderFurigana } from './furigana.js';
import { askJSON, askAudio, openSettings } from './gemini.js';
import {
  getSettings,
  getVoiceTranscript,
  setVoiceTranscript,
  clearVoiceTranscript,
} from './store.js';
import { createLiveSession, getLiveSupport } from './live.js';
import { getClient } from './supabase.js';

/** Mint a short-lived Gemini Live access token via the mint-live-token Edge
 *  Function — the real GEMINI_API_KEY never reaches this file. Throws if
 *  the user isn't signed in, is rate-limited, or the mint call fails; the
 *  caller already falls back to turn-based (record → send) mode on error. */
async function mintLiveAccessToken(model) {
  const sb = await getClient();
  if (!sb) throw new Error('Chưa đăng nhập — vui lòng đăng nhập để dùng luyện nói trực tiếp.');
  const { data, error } = await sb.functions.invoke('mint-live-token', { body: { model } });
  if (error) throw new Error(error.message || 'Không thể tạo access token cho Gemini Live.');
  if (!data || typeof data.accessToken !== 'string' || !data.accessToken) {
    throw new Error((data && data.error) || 'Gemini trả về token rỗng.');
  }
  return data.accessToken;
}

// ---------------------------------------------------------------------------
// Gemini response schemas
// ---------------------------------------------------------------------------

const OPENING_SCHEMA = {
  type: 'OBJECT',
  properties: {
    correction: { type: 'STRING' },
    reply: { type: 'STRING' },
    replyFurigana: { type: 'STRING' },
    vi: { type: 'STRING' },
  },
  required: ['correction', 'reply', 'replyFurigana', 'vi'],
};

const TURN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    heard: { type: 'STRING' },
    correction: { type: 'STRING' },
    reply: { type: 'STRING' },
    replyFurigana: { type: 'STRING' },
    vi: { type: 'STRING' },
  },
  required: ['heard', 'correction', 'reply', 'replyFurigana', 'vi'],
};

const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    overallVi: { type: 'STRING' },
    score: { type: 'NUMBER' },
    corrections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          original: { type: 'STRING' },
          corrected: { type: 'STRING' },
          explainVi: { type: 'STRING' },
        },
      },
    },
    grammarPointsVi: { type: 'ARRAY', items: { type: 'STRING' } },
    vocabSuggestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { jp: { type: 'STRING' }, vi: { type: 'STRING' } },
      },
    },
    encouragementVi: { type: 'STRING' },
  },
  required: ['overallVi', 'score', 'corrections', 'grammarPointsVi', 'vocabSuggestions', 'encouragementVi'],
};

const REVIEW_SYSTEM = 'Bạn là giáo viên N2 khó tính nhưng thân thiện. Đánh giá đoạn hội thoại của người học.';

// ---------------------------------------------------------------------------
// Module state (persists across internal re-renders within the same mount)
// ---------------------------------------------------------------------------

let rootEl = null;
let mediaRecorder = null;
let mediaChunks = [];
let activeStream = null;
let liveSession = null;
let mountToken = 0;
let liveInputCaption = '';
let liveOutputCaption = '';
let liveCommittedSequence = 0;
let liveCommittedTurnCount = 0;
let liveObservedTurnCount = 0;
let liveHighestRequestedTurn = 0;
let liveTranscriptSessionId = '';
let liveSeenTranscriptSequences = new Set();
let liveCurrentLearnerTurn = 0;
let liveTextPending = false;
let liveTextTargetTurn = 0;

const state = {
  view: 'topics', // 'topics' | 'conversation' | 'review'
  topic: null,
  history: [], // [{role:'user'|'model', text}] sent to gemini
  transcript: [], // [{speaker:'learner'|'partner', jp, jpPlain, vi}] for display + review
  pending: false,
  error: '',
  micDenied: false,
  recording: false,
  review: null,
  reviewPending: false,
  reviewError: '',
  transport: 'live', // 'live' | 'fallback'
  liveActive: false,
  liveStatus: '',
  fallbackNotice: '',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripFurigana(text) {
  return String(text == null ? '' : text).replace(/\{([^|{}]*)\|([^{}]*)\}/g, '$1');
}

function describeError(err) {
  const msg = err && err.message ? err.message : String(err);
  return `Đã có lỗi xảy ra: ${msg}. Nếu chưa đăng nhập, hãy đăng nhập rồi thử lại.`;
}

/**
 * @param {{jp:string}} topic
 * @param {{spoken?:boolean}} [options] `spoken: true` targets the Live audio
 *   session (no JSON schema exists there — the model must say everything
 *   out loud); omitted/false targets the JSON-schema turn-based fallback.
 */
function buildSystemPrompt(topic, { spoken = false } = {}) {
  const workflow = [
    `Bạn là gia sư AI luyện nói tiếng Nhật — kiên nhẫn, nhiệt tình, luôn động viên — đang trò chuyện với người học N2 về chủ đề "${topic.jp}".`,
    'Làm đúng quy trình này ở mỗi lượt:',
    '1) Sửa & hướng dẫn: nếu câu vừa nói của người học bị vỡ câu, sai ngữ pháp hoặc không tự nhiên, đưa ngay phiên bản tự nhiên/đúng mà người Nhật thật sự dùng, rồi mời người học lặp lại.',
    '2) Tiếp tục hội thoại: sau đó hỏi ĐÚNG MỘT câu hỏi ngắn, đơn giản, liên quan chủ đề để duy trì hội thoại tự nhiên.',
    '3) Tổng hợp: khoảng mỗi 2–3 lượt trao đổi (tự ước lượng dựa trên lịch sử hội thoại), thay vì hỏi câu mới hãy gộp lại ý chính vừa trao đổi thành MỘT câu hoàn chỉnh, trau chuốt, và mời người học lặp lại câu đó để ghi nhớ ngữ cảnh/từ vựng.',
    'Câu tiếng Nhật ngắn, rõ, dễ nhại lại theo.',
  ];

  if (spoken) {
    workflow.push('Đây là hội thoại bằng âm thanh trực tiếp — nói tất cả nội dung trên thành lời tự nhiên (câu sửa + mời lặp lại, rồi câu hỏi hoặc câu tổng hợp), không cần theo format JSON. Không đọc bản dịch tiếng Việt thành tiếng.');
  } else {
    workflow.push('Trả về JSON {correction, reply, replyFurigana, vi} — correction = phiên bản sửa tự nhiên/đúng của câu người học vừa nói, chú furigana dạng {漢字|かんじ}, để trống "" nếu không cần sửa; reply = câu nói chính của bạn (câu hỏi tiếp theo, hoặc câu tổng hợp mời lặp lại); replyFurigana = đúng câu reply nhưng chú {漢字|かんじ} cho mỗi từ có kanji; vi = dịch tiếng Việt của reply.');
  }

  return workflow.join(' ');
}

function buildTranscriptText(transcript) {
  return transcript
    .map((t) => `${t.speaker === 'learner' ? 'Học viên' : 'Đối tác'}: ${stripFurigana(t.jpPlain || t.jp || '')}`)
    .join('\n');
}

function persistTranscript() {
  const topicId = state.topic?.id || '';
  setVoiceTranscript(state.transcript.map((turn) => ({ ...turn, topicId })));
}

function appendTranscript(turn) {
  if (!turn || !turn.jp) return;
  state.transcript.push(turn);
  persistTranscript();
}

async function stopLive(reason = 'client-stop') {
  const session = liveSession;
  liveSession = null;
  state.liveActive = false;
  liveInputCaption = '';
  liveOutputCaption = '';
  if (session) {
    try { await session.stop({ reason }); } catch (error) { /* teardown is best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Text-to-speech (ja-JP)
// ---------------------------------------------------------------------------

let cachedVoices = null;
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.addEventListener('voiceschanged', () => {
    cachedVoices = window.speechSynthesis.getVoices();
  });
}

function pickJaVoice() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices && voices.length) cachedVoices = voices;
  const list = cachedVoices || voices || [];
  return list.find((v) => /^ja/i.test(v.lang) || /japan/i.test(v.name || '')) || null;
}

function speak(text) {
  const clean = stripFurigana(text).trim();
  if (!clean || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = 'ja-JP';
    const voice = pickJaVoice();
    if (voice) utter.voice = voice;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  } catch (e) {
    // TTS is best-effort only; ignore failures silently.
  }
}

// ---------------------------------------------------------------------------
// Microphone recording helpers
// ---------------------------------------------------------------------------

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  return '';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Không đọc được dữ liệu ghi âm.'));
    reader.readAsDataURL(blob);
  });
}

function releaseMic() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.removeEventListener('stop', onRecordingStop);
      mediaRecorder.stop();
    } catch (e) {
      // ignore
    }
  }
  if (activeStream) {
    activeStream.getTracks().forEach((t) => t.stop());
    activeStream = null;
  }
  mediaRecorder = null;
  mediaChunks = [];
}

async function startRecording() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    state.micDenied = true;
    state.error = 'Thiết bị/trình duyệt không hỗ trợ ghi âm. Bạn vẫn có thể nhập văn bản bên dưới.';
    renderView();
    return;
  }
  const token = mountToken;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (token !== mountToken || state.view !== 'conversation') {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    activeStream = stream;
    const mimeType = pickMimeType();
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    mediaChunks = [];
    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) mediaChunks.push(e.data);
    });
    mediaRecorder.addEventListener('stop', onRecordingStop);
    mediaRecorder.start();
    state.recording = true;
    state.micDenied = false;
    state.error = '';
    renderView();
  } catch (err) {
    state.micDenied = true;
    state.recording = false;
    state.error = 'Không thể truy cập microphone (có thể do bị từ chối quyền). Bạn vẫn có thể nhập văn bản để trò chuyện.';
    renderView();
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  state.recording = false;
}

function toggleRecording() {
  if (state.pending) return;
  if (state.recording) {
    stopRecording();
  } else {
    startRecording();
  }
}

async function onRecordingStop() {
  const token = mountToken;
  const actualMimeType = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
  const blob = new Blob(mediaChunks, { type: actualMimeType });
  mediaChunks = [];
  if (activeStream) {
    activeStream.getTracks().forEach((t) => t.stop());
    activeStream = null;
  }
  if (!blob.size) {
    renderView();
    return;
  }
  state.pending = true;
  renderView();
  try {
    const audioBase64 = await blobToBase64(blob);
    const promptText =
      'Hãy nghe đoạn ghi âm tiếng Nhật của người học và trả lời JSON với: ' +
      '(1) heard = chép lại chính xác câu tiếng Nhật người học vừa nói (giữ nguyên, không tự sửa lỗi); ' +
      '(2) reply = câu tiếng Nhật tự nhiên, ngắn gọn để tiếp tục hội thoại; ' +
      '(3) replyFurigana = đúng câu reply nhưng chú thích {漢字|かんじ} cho mỗi từ có kanji; ' +
      '(4) vi = bản dịch tiếng Việt của reply. Chỉ trả JSON đúng schema, không thêm chữ nào khác.';
    const data = await askAudio({
      system: buildSystemPrompt(state.topic),
      history: state.history,
      audioBase64,
      mimeType: actualMimeType,
      promptText,
      schema: TURN_SCHEMA,
    });
    if (token !== mountToken) return;
    applyAudioTurnResult(data);
  } catch (err) {
    if (token !== mountToken) return;
    state.error = describeError(err);
  } finally {
    if (token === mountToken) {
      state.pending = false;
      renderView();
    }
  }
}

function applyAudioTurnResult(data) {
  const heard = (data && data.heard) || '';
  const correction = (data && data.correction) || '';
  const replyFurigana = (data && (data.replyFurigana || data.reply)) || '';
  const replyPlain = (data && data.reply) || stripFurigana(replyFurigana);
  const vi = (data && data.vi) || '';
  if (heard) {
    appendTranscript({ speaker: 'learner', jp: heard, jpPlain: heard, vi: '' });
    state.history.push({ role: 'user', text: heard });
  }
  appendTranscript({ speaker: 'partner', jp: replyFurigana, jpPlain: replyPlain, vi, correction });
  state.history.push({ role: 'model', text: replyPlain });
  speak(correction ? `${correction}。${replyFurigana}` : replyFurigana);
}

// ---------------------------------------------------------------------------
// Gemini Live transport with automatic record→send fallback
// ---------------------------------------------------------------------------

function mergeCaption(current, incoming) {
  const next = String(incoming || '');
  if (!next) return current;
  if (!current || next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  const overlapLimit = Math.min(current.length, next.length);
  for (let size = overlapLimit; size > 0; size -= 1) {
    if (current.endsWith(next.slice(0, size))) return current + next.slice(size);
  }
  return current + next;
}

function updateLiveCaptionDom() {
  const input = rootEl?.querySelector('#live-input-caption');
  const output = rootEl?.querySelector('#live-output-caption');
  if (input) input.textContent = liveInputCaption;
  if (output) output.textContent = liveOutputCaption;
}

function rebuildHistoryFromTranscript() {
  state.history = state.transcript
    .filter((turn) => turn && (turn.speaker === 'learner' || turn.speaker === 'partner'))
    .map((turn) => ({
      role: turn.speaker === 'partner' ? 'model' : 'user',
      text: stripFurigana(turn.jpPlain || turn.jp || '').trim(),
    }))
    .filter((turn) => turn.text);
}

function liveEntryKey(turn, direction) {
  return `${liveTranscriptSessionId}:${turn}:${direction}`;
}

function allocateLiveLearnerTurn() {
  if (liveCurrentLearnerTurn <= liveObservedTurnCount) {
    liveCurrentLearnerTurn = Math.max(
      liveObservedTurnCount + 1,
      liveHighestRequestedTurn + 1
    );
    liveHighestRequestedTurn = liveCurrentLearnerTurn;
  }
  return liveCurrentLearnerTurn;
}

function upsertLiveTranscript({ direction, text, sequence }) {
  const value = String(text || '');
  const numericSequence = Number(sequence) || 0;
  if (!value || (numericSequence && liveSeenTranscriptSequences.has(numericSequence))) return;
  if (numericSequence) liveSeenTranscriptSequences.add(numericSequence);

  const pendingTurn = liveObservedTurnCount + 1;
  // Local speech/text starts establish the client turn before either transcript
  // direction arrives, so reordered and post-turnComplete fragments remain on
  // the correct logical turn.
  const turnNumber = direction === 'input'
    ? (liveCurrentLearnerTurn || allocateLiveLearnerTurn())
    : liveCurrentLearnerTurn > liveObservedTurnCount
      ? liveCurrentLearnerTurn
      : (liveObservedTurnCount || Math.max(1, liveHighestRequestedTurn));
  const key = liveEntryKey(turnNumber, direction);
  const speaker = direction === 'input' ? 'learner' : 'partner';
  let index = state.transcript.findIndex((turn) => turn.liveKey === key);
  if (index < 0) {
    const entry = {
      speaker,
      jp: value,
      jpPlain: value,
      vi: '',
      liveKey: key,
      liveTurn: turnNumber,
      liveDirection: direction,
      livePending: turnNumber > liveCommittedTurnCount,
    };
    if (direction === 'input') {
      const outputIndex = state.transcript.findIndex(
        (turn) => turn.liveKey === liveEntryKey(turnNumber, 'output')
      );
      if (outputIndex >= 0) state.transcript.splice(outputIndex, 0, entry);
      else state.transcript.push(entry);
    } else {
      state.transcript.push(entry);
    }
    index = state.transcript.findIndex((turn) => turn.liveKey === key);
  } else {
    const merged = mergeCaption(state.transcript[index].jpPlain || '', value);
    state.transcript[index] = { ...state.transcript[index], jp: merged, jpPlain: merged };
  }

  rebuildHistoryFromTranscript();
  persistTranscript();
}

function appendLiveTextInput(text) {
  const turnNumber = allocateLiveLearnerTurn();
  const key = liveEntryKey(turnNumber, 'input');
  const existing = state.transcript.findIndex((turn) => turn.liveKey === key);
  if (existing >= 0) {
    const merged = mergeCaption(state.transcript[existing].jpPlain || '', text);
    state.transcript[existing] = { ...state.transcript[existing], jp: merged, jpPlain: merged };
  } else {
    state.transcript.push({
      speaker: 'learner',
      jp: text,
      jpPlain: text,
      vi: '',
      liveKey: key,
      liveTurn: turnNumber,
      liveDirection: 'input',
      livePending: true,
    });
  }
  rebuildHistoryFromTranscript();
  persistTranscript();
}

function settleLiveTranscript(snapshot) {
  if (!snapshot) return;
  const turnCompleteCount = Number(snapshot.turnCompleteCount) || 0;
  const sequence = Number(snapshot.sequence) || 0;
  if (turnCompleteCount > liveCommittedTurnCount) {
    for (const turn of state.transcript) {
      if (turn.liveKey?.startsWith(`${liveTranscriptSessionId}:`)
          && Number(turn.liveTurn) <= turnCompleteCount) {
        turn.livePending = false;
      }
    }
    liveCommittedTurnCount = turnCompleteCount;
    liveInputCaption = '';
    liveOutputCaption = '';
    rebuildHistoryFromTranscript();
    persistTranscript();
    renderView();
  } else if (sequence > liveCommittedSequence
      && liveCurrentLearnerTurn <= liveCommittedTurnCount) {
    // A final late fragment for an already completed turn should not leave the
    // live-caption panel populated forever.
    liveInputCaption = '';
    liveOutputCaption = '';
    updateLiveCaptionDom();
  }
  liveCommittedSequence = Math.max(liveCommittedSequence, sequence);
}

let fallbackStarting = false;

async function startFallbackOpening(error = null) {
  if (fallbackStarting || state.view !== 'conversation') return;
  fallbackStarting = true;
  const token = mountToken;
  await stopLive('fallback');
  state.transport = 'fallback';
  state.fallbackNotice = error
    ? `Gemini Live không khả dụng (${error.message || error}). Đã chuyển sang chế độ ghi rồi gửi.`
    : 'Đang dùng chế độ ghi rồi gửi.';
  state.liveStatus = '';
  state.pending = true;
  renderView();
  try {
    const data = await askJSON({
      system: buildSystemPrompt(state.topic),
      history: state.history,
      user: state.history.length
        ? '前の流れから会話を続け、質問を一つしてください。'
        : '会話を始めましょう。',
      schema: OPENING_SCHEMA,
    });
    if (token !== mountToken || state.view !== 'conversation') return;
    const correction = (data && data.correction) || '';
    const replyFurigana = (data && (data.replyFurigana || data.reply)) || '';
    const replyPlain = (data && data.reply) || stripFurigana(replyFurigana);
    const vi = (data && data.vi) || '';
    state.history.push({ role: 'model', text: replyPlain });
    appendTranscript({ speaker: 'partner', jp: replyFurigana, jpPlain: replyPlain, vi, correction });
    speak(correction ? `${correction}。${replyFurigana}` : replyFurigana);
  } catch (fallbackError) {
    if (token === mountToken) state.error = describeError(fallbackError);
  } finally {
    fallbackStarting = false;
    if (token === mountToken) {
      state.pending = false;
      renderView();
    }
  }
}

async function startLiveConversation() {
  const token = mountToken;
  const support = getLiveSupport();
  if (!support.supported) {
    await startFallbackOpening(new Error('trình duyệt không hỗ trợ WebSocket/Web Audio/microphone'));
    return;
  }

  const settings = getSettings();
  state.transport = 'live';
  state.liveStatus = 'Đang kết nối Gemini Live…';
  state.fallbackNotice = '';
  state.pending = true;
  liveCommittedSequence = 0;
  liveCommittedTurnCount = 0;
  liveObservedTurnCount = 0;
  liveHighestRequestedTurn = 1;
  liveTranscriptSessionId = `live-${Date.now()}`;
  liveSeenTranscriptSequences = new Set();
  liveCurrentLearnerTurn = 0;
  liveTextPending = false;
  liveTextTargetTurn = 0;
  renderView();

  try {
    const accessToken = await mintLiveAccessToken(settings.liveModel);
    if (token !== mountToken) return;

    const session = createLiveSession({
      accessToken,
      model: settings.liveModel,
      systemInstruction: buildSystemPrompt(state.topic, { spoken: true }),
      contextWindowCompression: { slidingWindow: {} },
      callbacks: {
        onInputTranscript: ({ text }) => {
          if (token !== mountToken) return;
          liveInputCaption = mergeCaption(liveInputCaption, text);
          updateLiveCaptionDom();
        },
        onOutputTranscript: ({ text }) => {
          if (token !== mountToken) return;
          liveOutputCaption = mergeCaption(liveOutputCaption, text);
          updateLiveCaptionDom();
        },
        onTranscript: (fragment) => {
          if (token === mountToken) upsertLiveTranscript(fragment);
        },
        onTranscriptSettled: ({ snapshot }) => {
          if (token === mountToken) settleLiveTranscript(snapshot);
        },
        onActivityStart: () => {
          if (token !== mountToken) return;
          allocateLiveLearnerTurn();
        },
        onTurnComplete: ({ transcriptSnapshot } = {}) => {
          if (token !== mountToken) return;
          const observed = Number(transcriptSnapshot?.turnCompleteCount) || 0;
          liveObservedTurnCount = Math.max(liveObservedTurnCount, observed);
          liveHighestRequestedTurn = Math.max(liveHighestRequestedTurn, liveObservedTurnCount);
          if (liveTextPending && liveObservedTurnCount >= liveTextTargetTurn) {
            liveTextPending = false;
            liveTextTargetTurn = 0;
            state.pending = false;
            renderView();
          }
        },
        onInterruption: () => {
          if (token === mountToken) {
            state.liveStatus = 'Đã ngắt lời — đang nghe bạn…';
            const status = rootEl?.querySelector('#live-call-status');
            if (status) status.textContent = state.liveStatus;
          }
        },
        onMicrophoneState: ({ active }) => {
          if (token !== mountToken) return;
          state.liveStatus = active ? 'Đang nghe liên tục · có thể ngắt lời AI' : 'Microphone đã dừng';
          const status = rootEl?.querySelector('#live-call-status');
          if (status) status.textContent = state.liveStatus;
        },
        onFallback: ({ error }) => {
          if (token === mountToken) void startFallbackOpening(error);
        },
      },
    });
    liveSession = session;

    await session.start();
    if (token !== mountToken || state.view !== 'conversation') {
      await session.stop({ reason: 'stale-route' });
      return;
    }
    state.liveActive = true;
    state.pending = false;
    state.liveStatus = 'Đang nghe liên tục · có thể ngắt lời AI';
    renderView();
    if (state.history.length) {
      session.sendClientContent(state.history.map((turn) => ({
        role: turn.role === 'model' ? 'model' : 'user',
        parts: [{ text: turn.text }],
      })), { turnComplete: true });
    } else {
      session.sendText('会話を始めましょう。');
    }
  } catch (error) {
    if (token === mountToken) await startFallbackOpening(error);
  }
}

// ---------------------------------------------------------------------------
// Conversation flow
// ---------------------------------------------------------------------------

async function startConversation(topicId) {
  const topic = VOICE_TOPICS.find((t) => t.id === topicId) || VOICE_TOPICS[0];
  releaseMic();
  await stopLive('new-topic');
  state.view = 'conversation';
  state.topic = topic;
  state.history = [];
  state.transcript = [];
  clearVoiceTranscript();
  state.error = '';
  state.micDenied = false;
  state.recording = false;
  state.review = null;
  state.reviewError = '';
  state.transport = 'live';
  state.liveActive = false;
  state.liveStatus = '';
  state.fallbackNotice = '';
  liveInputCaption = '';
  liveOutputCaption = '';
  liveCommittedSequence = 0;
  liveCommittedTurnCount = 0;
  liveObservedTurnCount = 0;
  liveHighestRequestedTurn = 0;
  liveTranscriptSessionId = '';
  liveSeenTranscriptSequences = new Set();
  liveCurrentLearnerTurn = 0;
  liveTextPending = false;
  liveTextTargetTurn = 0;
  await startLiveConversation();
}

async function resumeConversation() {
  if (!state.transcript.length) return;
  const topicId = state.transcript.find((turn) => turn.topicId)?.topicId;
  state.topic = VOICE_TOPICS.find((topic) => topic.id === topicId) || state.topic || VOICE_TOPICS[0];
  state.history = state.transcript.map((turn) => ({
    role: turn.speaker === 'partner' ? 'model' : 'user',
    text: stripFurigana(turn.jpPlain || turn.jp || ''),
  })).filter((turn) => turn.text);
  state.view = 'conversation';
  state.error = '';
  state.review = null;
  state.reviewError = '';
  state.transport = 'live';
  state.fallbackNotice = '';
  await startLiveConversation();
}

async function sendTextTurn(rawText) {
  const trimmed = (rawText || '').trim();
  if (!trimmed || state.pending) return;

  if (state.transport === 'live' && liveSession?.ready) {
    appendLiveTextInput(trimmed);
    state.error = '';
    state.pending = true;
    liveTextPending = true;
    liveTextTargetTurn = liveCurrentLearnerTurn;
    try {
      liveSession.sendText(trimmed);
      renderView();
    } catch (error) {
      state.pending = false;
      liveTextPending = false;
      liveTextTargetTurn = 0;
      await startFallbackOpening(error);
    }
    return;
  }

  appendTranscript({ speaker: 'learner', jp: trimmed, jpPlain: trimmed, vi: '' });
  state.error = '';
  state.pending = true;
  renderView();
  const token = mountToken;
  try {
    const data = await askJSON({
      system: buildSystemPrompt(state.topic),
      history: state.history,
      user: trimmed,
      schema: OPENING_SCHEMA,
    });
    if (token !== mountToken) return;
    const correction = (data && data.correction) || '';
    const replyFurigana = (data && (data.replyFurigana || data.reply)) || '';
    const replyPlain = (data && data.reply) || stripFurigana(replyFurigana);
    const vi = (data && data.vi) || '';
    state.history.push({ role: 'user', text: trimmed });
    state.history.push({ role: 'model', text: replyPlain });
    appendTranscript({ speaker: 'partner', jp: replyFurigana, jpPlain: replyPlain, vi, correction });
    speak(correction ? `${correction}。${replyFurigana}` : replyFurigana);
  } catch (err) {
    if (token !== mountToken) return;
    state.error = describeError(err);
  } finally {
    if (token === mountToken) {
      state.pending = false;
      renderView();
    }
  }
}

async function endAndReview() {
  if (state.pending || state.reviewPending) return;
  if (!state.transcript.length) {
    state.error = 'Chưa có nội dung hội thoại nào để đánh giá.';
    renderView();
    return;
  }
  releaseMic();
  await stopLive('review');
  persistTranscript();
  state.view = 'review';
  state.reviewPending = true;
  state.reviewError = '';
  renderView();
  const token = mountToken;
  try {
    const transcriptText = buildTranscriptText(state.transcript);
    const data = await askJSON({
      system: REVIEW_SYSTEM,
      history: [],
      user: transcriptText,
      schema: REVIEW_SCHEMA,
    });
    if (token !== mountToken) return;
    state.review = data;
  } catch (err) {
    if (token !== mountToken) return;
    state.reviewError = describeError(err);
  } finally {
    if (token === mountToken) {
      state.reviewPending = false;
      renderView();
    }
  }
}

function goToTopics() {
  releaseMic();
  void stopLive('change-topic');
  state.view = 'topics';
  state.error = '';
  state.micDenied = false;
  state.recording = false;
  state.pending = false;
  state.review = null;
  state.reviewError = '';
  state.reviewPending = false;
  renderView();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderView() {
  if (!rootEl) return;
  if (state.view === 'conversation') {
    renderConversationView();
  } else if (state.view === 'review') {
    renderReviewView();
  } else {
    renderTopicPicker();
  }
}

/** The chat routes collapse the masthead tools, so each voice view carries its
 *  own settings button. One binder covers whichever view was just painted. */
function bindVoiceSettingsButtons() {
  rootEl.querySelectorAll('[data-voice-settings]').forEach((btn) => {
    btn.addEventListener('click', () => openSettings());
  });
}

function renderTopicPicker() {
  const savedTopic = state.transcript.find((turn) => turn.topicId)?.topicId;
  const savedTopicLabel = VOICE_TOPICS.find((topic) => topic.id === savedTopic)?.label || state.topic?.label || '';
  rootEl.innerHTML = `
    <section class="voice-page">
      <div class="lesson-toolbar">
        <h1 class="section-title" data-route-heading>🎙️ Luyện hội thoại theo chủ đề</h1>
        <button type="button" class="chat-settings-btn" data-voice-settings>⚙ Cài đặt</button>
      </div>
      <p class="vi-sentence">Chọn một chủ đề bên dưới để bắt đầu trò chuyện cùng gia sư AI bằng tiếng Nhật.</p>
      ${state.transcript.length ? `<button type="button" class="voice-resume-btn" id="voice-resume-btn">Tiếp tục hội thoại đã lưu${savedTopicLabel ? ` · ${esc(savedTopicLabel)}` : ''}</button>` : ''}
      <div class="topic-grid">
        ${VOICE_TOPICS.map(
          (t) => `
          <button type="button" class="tab-btn voice-topic-btn" data-topic-id="${esc(t.id)}">
            <span class="voice-topic-label">${esc(t.label)}</span>
            <span class="voice-topic-jp" lang="ja">${esc(t.jp)}</span>
          </button>`
        ).join('')}
      </div>
    </section>
  `;
  rootEl.querySelectorAll('.voice-topic-btn').forEach((btn) => {
    btn.addEventListener('click', () => startConversation(btn.getAttribute('data-topic-id')));
  });
  rootEl.querySelector('#voice-resume-btn')?.addEventListener('click', resumeConversation);
  bindVoiceSettingsButtons();
}

function renderConversationView() {
  const topic = state.topic || VOICE_TOPICS[0];

  const bubbles = state.transcript
    .map((t) => {
      const isLearner = t.speaker === 'learner';
      const jpHtml = renderFurigana(t.jp || '');
      const viHtml = t.vi ? `<div class="vi-sentence">${esc(t.vi)}</div>` : '';
      const spokenText = t.correction ? `${t.correction}。${t.jpPlain || t.jp || ''}` : (t.jpPlain || t.jp || '');
      const ttsBtn = !isLearner
        ? `<button type="button" class="tts-btn" data-speak="${esc(spokenText)}" aria-label="Nghe lại câu tiếng Nhật">🔊</button>`
        : '';
      const correctionHtml = !isLearner && t.correction ? `
        <div class="voice-correction">
          <span class="voice-correction-label">✏️ Nói thế này (lặp lại nhé!)</span>
          <div class="jp-sentence" lang="ja">${renderFurigana(t.correction)}</div>
        </div>` : '';
      return `
        <div class="chat-msg ${isLearner ? 'user' : 'model'}">
          ${correctionHtml}
          <div class="jp-sentence" lang="ja">${jpHtml}${ttsBtn}</div>
          ${viHtml}
        </div>`;
    })
    .join('');

  const micLabel = state.recording ? '⏹ Dừng' : '⏺ Nói';
  const disabledAttr = state.pending ? 'disabled' : '';

  rootEl.innerHTML = `
    <section class="voice-page">
      <h1 class="sr-only" data-route-heading>Luyện nói trực tiếp</h1>
      <div class="lesson-toolbar">
        <button type="button" class="tts-btn back-btn" id="voice-back-btn">← Đổi chủ đề</button>
        <span class="lesson-meta">${esc(topic.label)} · <span lang="ja">${esc(topic.jp)}</span></span>
        <button type="button" class="chat-settings-btn" data-voice-settings>⚙ Cài đặt</button>
      </div>
      ${state.transport === 'live' ? `
        <section class="live-call-panel" aria-label="Trạng thái cuộc gọi trực tiếp">
          <span class="live-call-indicator" aria-hidden="true"></span>
          <p id="live-call-status" role="status" aria-live="polite">${esc(state.liveStatus || 'Đang chuẩn bị Gemini Live…')}</p>
          <div class="live-captions" aria-label="Phụ đề trực tiếp">
            <p><strong>Bạn:</strong> <span id="live-input-caption" lang="ja">${esc(liveInputCaption)}</span></p>
            <p><strong>AI:</strong> <span id="live-output-caption" lang="ja">${esc(liveOutputCaption)}</span></p>
          </div>
        </section>` : ''}
      ${state.fallbackNotice ? `<p class="live-fallback-notice" role="status">${esc(state.fallbackNotice)}</p>` : ''}
      <div class="chat-wrap" id="voice-chat-wrap" role="log" aria-live="polite" aria-relevant="additions text">
        ${bubbles || '<p class="vi-sentence">Đang bắt đầu hội thoại...</p>'}
        ${state.pending ? '<div class="chat-msg model chat-loading" role="status"><em>Đang xử lý...</em></div>' : ''}
      </div>
      ${state.error ? `<p class="lesson-error" role="alert">${esc(state.error)}</p>` : ''}
      ${
        state.micDenied && state.transport === 'fallback'
          ? '<p class="voice-note">🎙️ Không dùng được microphone. Bạn vẫn có thể nhập văn bản để trò chuyện bên dưới.</p>'
          : ''
      }
      <div class="chat-input-row">
        ${
          state.micDenied || state.transport === 'live'
            ? ''
            : `<button type="button" class="study-btn record-btn${state.recording ? ' recording' : ''}" id="voice-record-btn" ${disabledAttr}>${micLabel}</button>`
        }
        <label for="voice-text-input" class="sr-only">Nhập câu tiếng Nhật</label>
        <input type="text" id="voice-text-input" lang="ja" placeholder="Hoặc nhập câu tiếng Nhật..." ${disabledAttr}/>
        <button type="button" class="study-btn" id="voice-send-btn" ${disabledAttr}>Gửi</button>
      </div>
      <button type="button" class="study-btn voice-end-btn" id="voice-end-btn">🔚 Kết thúc &amp; Đánh giá</button>
    </section>
  `;

  const backBtn = rootEl.querySelector('#voice-back-btn');
  if (backBtn) backBtn.addEventListener('click', goToTopics);

  const recordBtn = rootEl.querySelector('#voice-record-btn');
  if (recordBtn) recordBtn.addEventListener('click', toggleRecording);

  const sendBtn = rootEl.querySelector('#voice-send-btn');
  const textInput = rootEl.querySelector('#voice-text-input');
  const submitText = () => {
    if (!textInput) return;
    const val = textInput.value;
    textInput.value = '';
    sendTextTurn(val);
  };
  if (sendBtn) sendBtn.addEventListener('click', submitText);
  if (textInput) {
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitText();
      }
    });
  }

  rootEl.querySelectorAll('[data-speak]').forEach((btn) => {
    btn.addEventListener('click', () => speak(btn.getAttribute('data-speak') || ''));
  });

  const endBtn = rootEl.querySelector('#voice-end-btn');
  if (endBtn) endBtn.addEventListener('click', endAndReview);

  bindVoiceSettingsButtons();

  const wrap = rootEl.querySelector('#voice-chat-wrap');
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

function renderReviewView() {
  if (state.reviewPending) {
    rootEl.innerHTML = `
      <section class="voice-page">
        <div class="review-card">
          <p>⏳ Đang phân tích hội thoại của bạn...</p>
        </div>
      </section>
    `;
    return;
  }

  if (state.reviewError) {
    rootEl.innerHTML = `
      <section class="voice-page">
        <div class="review-card">
          <p class="lesson-error">${esc(state.reviewError)}</p>
          <div class="review-actions">
            <button type="button" class="study-btn" id="voice-review-retry">Thử lại</button>
            <button type="button" class="study-btn" id="voice-review-back">← Chọn chủ đề khác</button>
          </div>
        </div>
      </section>
    `;
    const retryBtn = rootEl.querySelector('#voice-review-retry');
    const backBtn = rootEl.querySelector('#voice-review-back');
    if (retryBtn) retryBtn.addEventListener('click', endAndReview);
    if (backBtn) backBtn.addEventListener('click', goToTopics);
    return;
  }

  const r = state.review || {};
  const scoreNum = typeof r.score === 'number' ? r.score : parseFloat(r.score);
  const score = Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, Math.round(scoreNum))) : null;
  const corrections = Array.isArray(r.corrections) ? r.corrections : [];
  const grammarPoints = Array.isArray(r.grammarPointsVi) ? r.grammarPointsVi : [];
  const vocabSuggestions = Array.isArray(r.vocabSuggestions) ? r.vocabSuggestions : [];
  const topicLabel = state.topic ? state.topic.label : '';

  rootEl.innerHTML = `
    <section class="voice-page">
      <div class="review-card">
        <h3>📊 Đánh giá hội thoại${topicLabel ? ` — ${esc(topicLabel)}` : ''}</h3>
        <p class="review-score">
          Điểm: ${score === null ? '—' : esc(String(score))}<span class="review-score-max">/100</span>
        </p>
        <p>${esc(r.overallVi || '')}</p>
        ${
          corrections.length
            ? `<h4>Sửa lỗi</h4>${corrections
                .map(
                  (c) => `
              <div class="example-box">
                <div class="jp-sentence correction-original">${esc(c.original || '')}</div>
                <div class="jp-sentence correction-fixed">${esc(c.corrected || '')}</div>
                <div class="vi-sentence">${esc(c.explainVi || '')}</div>
              </div>`
                )
                .join('')}`
            : ''
        }
        ${
          grammarPoints.length
            ? `<h4>Điểm ngữ pháp cần chú ý</h4>
               <ul class="review-grammar-list">${grammarPoints.map((g) => `<li class="quiz-option">${esc(g)}</li>`).join('')}</ul>`
            : ''
        }
        ${
          vocabSuggestions.length
            ? `<h4>Gợi ý từ vựng</h4>${vocabSuggestions
                .map(
                  (v) => `
              <div class="vocab-item"><strong>${renderFurigana(v.jp || '')}</strong> — <span class="vi-sentence">${esc(v.vi || '')}</span></div>`
                )
                .join('')}`
            : ''
        }
        <p class="review-encouragement">${esc(r.encouragementVi || '')}</p>
        <button type="button" class="study-btn" id="voice-review-back">← Chọn chủ đề khác</button>
      </div>
    </section>
  `;
  const backBtn = rootEl.querySelector('#voice-review-back');
  if (backBtn) backBtn.addEventListener('click', goToTopics);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function renderVoice(root) {
  const token = ++mountToken;
  rootEl = root;
  releaseMic();
  void stopLive('remount');
  const savedTranscript = getVoiceTranscript();
  state.view = 'topics';
  const savedTopicId = savedTranscript.find((turn) => turn && turn.topicId)?.topicId;
  state.topic = VOICE_TOPICS.find((topic) => topic.id === savedTopicId) || null;
  state.history = [];
  state.transcript = savedTranscript.filter((turn) => turn && (turn.speaker === 'learner' || turn.speaker === 'partner'));
  state.pending = false;
  state.error = '';
  state.micDenied = false;
  state.recording = false;
  state.review = null;
  state.reviewPending = false;
  state.reviewError = '';
  state.transport = 'live';
  state.liveActive = false;
  state.liveStatus = '';
  state.fallbackNotice = '';
  liveInputCaption = '';
  liveOutputCaption = '';
  renderView();

  return {
    cleanup() {
      if (mountToken === token) mountToken += 1;
      releaseMic();
      void stopLive('route-exit');
      if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
      if (rootEl === root) rootEl = null;
    },
  };
}

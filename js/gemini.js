// js/gemini.js
// Gemini client + a settings modal for editing the model choice.
// The raw API key never reaches this file (or the browser) at all — every
// call is proxied through the `gemini-proxy` Supabase Edge Function, which
// holds GEMINI_API_KEY as a server-side secret and forwards the request.
// This means AI features (tutor chat, tap-kanji gloss, voice review) now
// require the user to be signed in — there is no anonymous/free-for-all key.

import { getSettings, setSettings } from './store.js';
import { getClient } from './supabase.js';
import { activateModalDialog } from './modal-dialog.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Best-effort extraction of the `{error}` JSON body a non-2xx gemini-proxy
 *  response attaches to `error.context` (a Response). Falls back to the
 *  generic supabase-js message across client versions that shape this
 *  differently. */
async function extractFunctionError(error) {
  try {
    const ctx = error && error.context;
    if (ctx && typeof ctx.clone === 'function' && typeof ctx.json === 'function') {
      const body = await ctx.clone().json();
      if (body && typeof body.error === 'string' && body.error) return body.error;
    }
  } catch {
    // fall through to the generic message below
  }
  return (error && error.message) || 'Gemini request failed';
}

/**
 * Call the gemini-proxy Edge Function and return the raw response text.
 * Throws a readable Vietnamese Error on any failure (not signed in, rate
 * limited, network, or an empty/blocked Gemini response).
 * @param {{system?:string, history?:Array, user?:string, schema?:object, audio?:{base64:string,mimeType:string}}} body
 * @returns {Promise<string>}
 */
// Client-side timeout for an individual chat or voice turn.
//
// The server has its own fallback chain (gemini-proxy -> _shared/gemini-models.js)
// which tries up to 4 models. A slow/thinking model can take 15-20s, and walking
// 2-3 fallback models when earlier ones 429 takes ~30-40s total server-side.
// We set a 60s client ceiling so legitimate server completions are not cut
// short, while still guarding the learner against an indefinitely hung socket.
export const CLIENT_TIMEOUT_MS = 60_000;

export const TIMEOUT_MESSAGE = 'Trợ lý AI phản hồi quá lâu. Vui lòng bấm thử lại hoặc kiểm tra kết nối.';

/**
 * Whether a failure from `functions.invoke` was a timeout or caller abort
 * rather than an HTTP/relay error.
 *
 * `invoke()` does not throw when the fetch fails — it *resolves* with a
 * `FunctionsFetchError` in `{ error }`. That error's own `message` is the
 * fixed string "Failed to send a request to the Edge Function" and its `name`
 * is 'FunctionsFetchError', so neither ever mentions a timeout. The original
 * fetch rejection — an `AbortError`, which is what both the `timeout` option
 * and a caller-supplied `AbortSignal` produce — is nested in `.context`.
 * Checking that is the only way to tell "the server is slow" apart from
 * "the server said no".
 *
 * @param {unknown} error a value from `{ error }` or a rejection
 * @returns {boolean}
 */
export function isInvokeTimeout(error) {
  // A FunctionsHttpError carries a Response in `.context`, which has no `name`
  // or `message`, so treating it as the cause is harmless and correctly
  // reports "not a timeout". A plain object context (e.g. `{requestId}`) is
  // likewise inert.
  const cause = (error && typeof error === 'object' && error.context) || error;
  if (cause?.name === 'AbortError' || cause?.name === 'TimeoutError') return true;
  // Bare DOMException/Error rejections from other fetch wrappers.
  return /\btimed?\s*out\b|\baborted\b/i.test(String(cause?.message || ''));
}

/**
 * Call the gemini-proxy Edge Function and return the raw response text.
 * Throws a readable Vietnamese Error on any failure (not signed in, rate
 * limited, network, timeout, or an empty/blocked Gemini response).
 * @param {{system?:string, history?:Array, user?:string, schema?:object, audio?:{base64:string,mimeType:string}}} body
 * @returns {Promise<string>}
 */
async function callGeminiProxy(body, feature, { signal } = {}) {
  const sb = await getClient();
  if (!sb) {
    throw new Error('Chưa đăng nhập. Vui lòng đăng nhập để dùng trợ lý AI.');
  }

  let data;
  let error;
  try {
    ({ data, error } = await sb.functions.invoke('gemini-proxy', {
      body: { ...body, feature },
      // supabase-js aborts the request itself after this many milliseconds and
      // surfaces a FunctionsFetchError, so a hung upstream cannot keep the
      // learner's chat spinning through the server's whole model chain.
      timeout: CLIENT_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    }));
  } catch (networkErr) {
    // `invoke()` resolves {data, error} rather than rejecting, so this branch
    // only fires on a hard throw from a future/patched build.
    if (isInvokeTimeout(networkErr)) throw new Error(TIMEOUT_MESSAGE);
    throw new Error(`Không thể kết nối tới máy chủ AI: ${networkErr && networkErr.message ? networkErr.message : networkErr}`);
  }

  if (error) {
    if (isInvokeTimeout(error)) throw new Error(TIMEOUT_MESSAGE);
    throw new Error(await extractFunctionError(error));
  }
  if (!data || typeof data.text !== 'string' || !data.text) {
    throw new Error((data && data.error) || 'Gemini trả về nội dung trống.');
  }
  return data.text;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ask Gemini a plain-text question.
 * @param {{system?:string, history?:Array<{role:string,text:string}>, user:string, signal?:AbortSignal}} args
 * @returns {Promise<string>}
 */
export async function askText({ system, history = [], user, signal }) {
  return callGeminiProxy({ system, history, user: String(user || '') }, 'tutor', { signal });
}

/**
 * Ask Gemini for a JSON-shaped answer; the response text is JSON.parse'd.
 * @param {{system?:string, history?:Array<{role:string,text:string}>, user:string, schema?:object, signal?:AbortSignal}} args
 * @returns {Promise<object>}
 */
export async function askJSON({ system, history = [], user, schema, signal }) {
  const text = await callGeminiProxy({ system, history, user: String(user || ''), schema }, 'voice', { signal });
  try {
    return JSON.parse(text);
  } catch (parseErr) {
    throw new Error(`Gemini trả về JSON không hợp lệ: ${parseErr.message}`);
  }
}

/**
 * Ask Gemini about a recorded audio clip (base64, no `data:` prefix).
 * If `schema` is given, the response is parsed as JSON; otherwise the raw
 * text is returned.
 * @param {{system?:string, history?:Array<{role:string,text:string}>, audioBase64:string, mimeType:string, promptText?:string, schema?:object}} args
 * @returns {Promise<object|string>}
 */
export async function askAudio({ system, history = [], audioBase64, mimeType, promptText, schema, signal }) {
  if (!audioBase64) {
    throw new Error('Thiếu dữ liệu âm thanh để gửi tới Gemini.');
  }

  const text = await callGeminiProxy({
    system,
    history,
    user: promptText ? String(promptText) : undefined,
    schema,
    audio: { base64: audioBase64, mimeType: mimeType || 'audio/webm' },
  }, 'voice', { signal });

  if (schema) {
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`Gemini trả về JSON không hợp lệ: ${parseErr.message}`);
    }
  }

  return text;
}

// ---------------------------------------------------------------------------
// Settings modal — live voice model choice only. Chat and voice-turn text
// always run on the fast model server-side (see gemini-proxy's CHAT_MODEL);
// only the live-conversation model is still a real choice, since both
// options there are already speed-tuned for real-time audio. No API key
// field: the key lives only in `supabase secrets` on the server (see
// supabase/functions/gemini-proxy).
// ---------------------------------------------------------------------------

const MODAL_ID = 'gemini-settings-overlay';
let activeSettingsDialog = null;

const LIVE_MODEL_SUGGESTIONS = [
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-latest',
];

function closeExistingSettingsModal() {
  if (activeSettingsDialog) {
    activeSettingsDialog.close();
    return;
  }
  const existing = document.getElementById(MODAL_ID);
  if (existing) existing.remove();
}

/**
 * Build and show a modal (reusing the `.modal-overlay`/`.modal-card` look)
 * to edit the Gemini `liveModel` setting. Saves via `store.setSettings` and
 * closes on backdrop click, Escape, or the close button.
 */
export function openSettings() {
  closeExistingSettingsModal();

  const current = getSettings();
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay settings-modal active';
  overlay.id = MODAL_ID;

  const card = document.createElement('section');
  card.className = 'modal-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'gemini-settings-title');

  // Header ------------------------------------------------------------
  const header = document.createElement('div');
  header.className = 'modal-header';

  const title = document.createElement('h2');
  title.id = 'gemini-settings-title';
  title.textContent = '⚙ Cài đặt AI';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-close';
  closeBtn.setAttribute('aria-label', 'Đóng');
  closeBtn.innerHTML = '&times;';

  header.appendChild(title);
  header.appendChild(closeBtn);

  // Body ----------------------------------------------------------------
  const body = document.createElement('div');
  body.className = 'modal-body';

  const help = document.createElement('p');
  help.className = 'settings-help';
  help.textContent = 'Trợ lý AI (gia sư, luyện nói, giải nghĩa hán tự) chạy qua máy chủ nên bạn cần đăng nhập để dùng. Chat và luyện nói luôn dùng model nhanh nhất để trả lời tức thì; hết lượt trong ngày, máy chủ tự chuyển sang model khác. Ở đây bạn chỉ chọn model cho hội thoại trực tiếp (Live).';

  const liveLabel = document.createElement('label');
  liveLabel.setAttribute('for', 'gemini-settings-live-model');
  liveLabel.textContent = 'Live model';

  const liveInput = document.createElement('input');
  liveInput.type = 'text';
  liveInput.id = 'gemini-settings-live-model';
  liveInput.setAttribute('list', 'gemini-settings-live-model-options');
  liveInput.autocomplete = 'off';
  liveInput.spellcheck = false;
  liveInput.placeholder = LIVE_MODEL_SUGGESTIONS[0];
  liveInput.value = current.liveModel || '';

  const liveDatalist = document.createElement('datalist');
  liveDatalist.id = 'gemini-settings-live-model-options';
  LIVE_MODEL_SUGGESTIONS.forEach((model) => {
    const option = document.createElement('option');
    option.value = model;
    liveDatalist.appendChild(option);
  });

  body.appendChild(help);
  body.appendChild(liveLabel);
  body.appendChild(liveInput);
  body.appendChild(liveDatalist);

  // Footer ----------------------------------------------------------------
  const footer = document.createElement('div');
  footer.className = 'modal-footer';

  const status = document.createElement('span');
  status.className = 'settings-status';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'complete-modal-btn';
  saveBtn.textContent = 'Lưu';

  footer.appendChild(status);
  footer.appendChild(saveBtn);

  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(footer);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  let modalDialog = null;

  function close() {
    overlay.removeEventListener('click', onOverlayClick);
    modalDialog?.release();
    overlay.remove();
    activeSettingsDialog = null;
  }

  function onOverlayClick(e) {
    if (e.target === overlay) close();
  }

  overlay.addEventListener('click', onOverlayClick);
  closeBtn.addEventListener('click', close);

  saveBtn.addEventListener('click', () => {
    const nextLiveModel = liveInput.value.trim() || current.liveModel;
    setSettings({ liveModel: nextLiveModel });
    status.textContent = 'Đã lưu!';
    status.classList.add('ok');
    setTimeout(close, 600);
  });

  modalDialog = activateModalDialog(overlay, { trigger, initialFocus: liveInput, onEscape: close });
  activeSettingsDialog = { close };
}

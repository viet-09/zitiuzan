# N2_web — BUILD SPEC (HISTORICAL — superseded, do not treat as authoritative)

> **Stale as of 2026-08.** This describes an early version of the app (11 JS files, GitHub Pages
> deployment, client-held Gemini API key, an older font set). The current app has 21+ JS files, a
> Supabase backend (Postgres + Edge Functions + Storage), deploys to Vercel, and routes all Gemini
> calls through server-side Edge Functions — none of which is reflected below. Kept for historical
> context only; read the actual `js/*.js` files and `README.md` for the current architecture.

This is a **vanilla ES-modules SPA** (no framework, no build step) deployed on GitHub Pages.
Every file below is loaded over http (GitHub Pages / `python -m http.server`). Use **relative** paths only.
Design language = existing editorial style (read the CURRENT `index.html` for the exact CSS tokens & component styles and KEEP that look).

Language of UI text: **Vietnamese** (labels/buttons), Japanese for study material.

## Golden rules for every agent
- Write **only** the file(s) assigned to you. Do NOT edit other files.
- Match the **exact** export/import names and signatures in this spec — other files depend on them.
- ES modules: every `js/*.js` uses `export`/`import` with relative paths (`./store.js`).
- No external libraries, no CDN JS. Google Fonts `<link>` is allowed (already present).
- Escape user/AI text before inserting as HTML (except furigana renderer output, which is trusted HTML it builds itself).
- Mobile-first; touch targets ≥44px; must work on iPhone Safari.

---

## File map & ownership
```
index.html            shell: fonts, <header>, bottom nav, #app mount, <script type="module" src="js/app.js">
css/styles.css        ALL styles (port existing look + new components)
js/config.js          constants, default settings, tutor prompt, voice topics
js/store.js           localStorage: progress, streak, lessons, content-cache, tutor history, settings
js/furigana.js        furigana markup renderer + global on/off toggle
js/router.js          hash router
js/gemini.js          Gemini REST client (text/json/audio) + settings modal
js/dashboard.js       dashboard list + stats + streak (port from current index.html JS)
js/lesson.js          dedicated lesson page: content render + furigana + AI generate + TTS
js/tutor.js           AI text tutor chat
js/voice.js           voice conversation trainer + post-conversation review
js/app.js             bootstrap: load lessons.json, wire router + nav + furigana toggle + settings btn
data/lessons.json     existing structure + `content` added to a few SEED lessons (schema below)
```

---

## config.js (exports)
```js
export const STORAGE = {
  progress: 'n2_progress_v2', streak: 'n2_streak_v2', settings: 'n2_settings_v2',
  content: 'n2_content_v2', tutor: 'n2_tutor_v2',
};
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  furigana: true,
};
// EXACT tutor system prompt — do not alter wording:
export const TUTOR_SYSTEM_PROMPT = `Act as my expert Japanese language teacher and memory coach. My current level is JLPT N3/N2. Follow these rules for our interaction: Give me one vocabulary word or short sentence at my level at a time. Provide the Vietnamese translation. Include kanji/kana and furigana if necessary. Wait for me to reply with my translation or attempt to use the word in a sentence. Critique my response, correct my mistakes gently, explain the nuance of the particles or grammar used, and then give me the next challenge.
FORMAT: When you write Japanese that has kanji, annotate every kanji word using the markup {漢字|かんじ} (base|reading). Keep replies concise. Respond in a friendly tone, mixing Japanese and Vietnamese explanations.`;
export const VOICE_TOPICS = [
  { id:'daily',    label:'Hội thoại hằng ngày', jp:'日常会話' },
  { id:'travel',   label:'Du lịch',             jp:'旅行' },
  { id:'work',     label:'Công việc',           jp:'仕事・ビジネス' },
  { id:'shopping', label:'Mua sắm',             jp:'買い物' },
  { id:'restaurant',label:'Nhà hàng',           jp:'レストランで注文' },
  { id:'hobby',    label:'Sở thích',            jp:'趣味' },
  { id:'health',   label:'Sức khỏe / khám bệnh',jp:'病院で' },
  { id:'free',     label:'Tự do',               jp:'フリートーク' },
];
```

## store.js (exports) — thin localStorage wrapper, all reads defensive (try/catch → default)
```js
// lessons (in-memory + set once at boot)
export function setLessons(data)                 // stores full lessons.json object
export function getLessons()                      // -> object | null
export function findLesson(id)                    // -> { lesson, category, week } | null  (search all categories)
export function allLessons()                      // -> [ {...lesson, categoryId, categoryName, week} ]
export function countProgress()                   // -> { total, done, byCategory:{catId:{total,done}} }
// progress
export function isDone(id)                         // -> boolean
export function toggleDone(id)                     // flips, persists, calls touchStreak() when it becomes true, returns new boolean
// streak
export function touchStreak()                      // updates streak by today's date (yesterday→+1, else reset to 1; same day→noop)
export function getStreak()                         // -> { streak, lastDate }
// per-lesson generated content cache
export function getContent(id)                      // -> object | null
export function setContent(id, obj)
// tutor chat history: array of { role:'user'|'model', text }
export function getTutorHistory()                   // -> array
export function setTutorHistory(arr)
export function clearTutorHistory()
// settings (merges over DEFAULT_SETTINGS)
export function getSettings()                       // -> { apiKey, model, furigana }
export function setSettings(patch)                  // shallow-merge + persist
```

## furigana.js (exports)
Markup convention used everywhere: `{漢字|かんじ}` → ruby. Plain text passes through. `\n` → `<br>`.
```js
export function renderFurigana(text)   // -> trusted HTML string. Escapes HTML in base & reading, then wraps {b|r} as <ruby>b<rt>r</rt></ruby>
export function initFuriganaToggle()   // reads store.getSettings().furigana, applies body class, no button creation
export function setFurigana(on)        // toggles <body class="furigana-off">, persists via store.setSettings({furigana:on})
export function getFurigana()          // -> boolean (from settings)
```
CSS contract: when furigana OFF, `body.furigana-off rt { display:none; }` (styles.css must include this).

## router.js (exports)
```js
export function initRouter(routes, rootEl)   // routes = { dashboard, lesson, tutor, voice }; binds hashchange + initial render
export function navigate(hash)               // sets location.hash (e.g. '#/lesson/g1d1')
```
Route parsing from `location.hash`:
- ``, `#`, `#/`            → routes.dashboard(rootEl)
- `#/lesson/<id>`          → routes.lesson(rootEl, id)
- `#/tutor`                → routes.tutor(rootEl)
- `#/voice`                → routes.voice(rootEl)
Also: after each route render, update `.nav-btn.active` (match `data-route`), and scroll `#app` to top.

## gemini.js (exports) — REST, no SDK
Endpoint: `POST {GEMINI_BASE}/{model}:generateContent?key={apiKey}` with `Content-Type: application/json`.
Request body shape:
```json
{ "system_instruction": {"parts":[{"text": "<system>"}]},
  "contents": [ {"role":"user|model","parts":[{"text":"..."}]} , ... ],
  "generationConfig": { "temperature":0.7 } }
```
For JSON mode add `generationConfig.responseMimeType:"application/json"` (+ `responseSchema` if provided).
For audio, a user part is `{"inline_data":{"mime_type": mimeType, "data": base64}}` (base64 WITHOUT the `data:` prefix).
Response text at `data.candidates[0].content.parts[].text` (concatenate parts). Throw `Error` with readable message on non-200 (include `data.error.message` if present) or blocked content.
```js
export async function askText({ system, history=[], user })            // -> string
export async function askJSON({ system, history=[], user, schema })     // -> parsed object (JSON.parse the text)
export async function askAudio({ system, history=[], audioBase64, mimeType, promptText, schema }) // -> parsed object (JSON) or string
export function openSettings()   // build/overlay a modal to edit apiKey + model (+ link explaining key), Save→store.setSettings, close on backdrop
```
`history` items are `{role:'user'|'model', text}`; map to contents. Prepend/append the new `user` turn.
On error, throw — callers show the message in the UI.

## Page modules — each exports one render fn that fills `rootEl` (the #app element)
### dashboard.js
```js
export function renderDashboard(root)   // stats bar (done/total, %, streak), category filter tabs, week cards, lesson items
```
- Port the CURRENT index.html dashboard (categories→weeks→lessons, completed styling, progress bars).
- Clicking a lesson **checkbox area** toggles done (store.toggleDone) and re-renders stats.
- Clicking the lesson **"Học" button** navigates to `#/lesson/<id>` (use router.navigate).
- Category tabs filter in place (client-side), remember active tab in a module variable.

### lesson.js
```js
export function renderLesson(root, id)   // dedicated full-page lesson view
```
- `store.findLesson(id)`; if missing → "Không tìm thấy bài học" + back link.
- Header: back button (→ `#/`), category name, day, lesson title (furigana-rendered), a **furigana toggle button** (calls setFurigana + re-render, label あ/ア), a **"Đánh dấu đã học/Bỏ đánh dấu"** button (store.toggleDone).
- Content resolution order: `lesson.content` (from lessons.json) → `store.getContent(id)` → none.
- If none: show a **"✨ Tạo bài học bằng AI"** button. On click → build a category-specific prompt (see below) → `gemini.askJSON({system, user, schema})` → `store.setContent(id, obj)` → re-render. Show loading + error states.
- Render content by category using the CONTENT SCHEMA below, all Japanese via `renderFurigana`.
- Every Japanese example/passage/transcript line gets a small **🔊 button** → `speak(text)` (strip furigana markup first) using SpeechSynthesis ja-JP.
- Provide a local `speak(text)` helper (lang 'ja-JP', pick a ja voice if available). Strip `{b|r}`→ b for TTS. Requires a user gesture (button click) — fine.
- AI generation prompts (Vietnamese meanings, JP with {kanji|reading} furigana markup). Ask the model to return ONLY JSON matching the schema. Example grammar user prompt:
  `Bạn là giáo viên tiếng Nhật. Tạo bài học N2 cho mẫu ngữ pháp "<title>". Trả về JSON: {pattern, meaningVi, formation, explanationVi, examples:[{jp,vi}](4-5 câu), notes}. Trong mọi câu/từ tiếng Nhật, chú furigana theo dạng {漢字|かんじ} cho mỗi từ có kanji.`
  (Analogous prompts for vocab/kanji/reading/listening per schema.)

### tutor.js
```js
export function renderTutor(root)   // chat UI
```
- System prompt = `TUTOR_SYSTEM_PROMPT`. History persisted via store tutor history.
- On open: render history. If empty → auto call `askText({system, history:[], user:'始めましょう。最初の課題をください。'})`, push model reply, persist, render.
- Input box + send. On send: push `{role:'user',text}`, render, call `askText({system:TUTOR_SYSTEM_PROMPT, history, user})`, push `{role:'model',text}`, persist, render, scroll to bottom.
- Assistant bubbles render Japanese via `renderFurigana`; add 🔊 TTS button per assistant message.
- Buttons: "Xóa hội thoại" (clearTutorHistory + reset), settings link. Loading indicator while waiting.
- Show a friendly error bubble if gemini throws (mention checking API key in ⚙).

### voice.js
```js
export function renderVoice(root)   // topic picker → live voice conversation → review
```
Three sub-views inside #app (manage with internal state, no router change needed):
1. **Topic picker**: buttons from `VOICE_TOPICS`. Selecting one starts a conversation.
2. **Conversation**: roleplay system prompt, e.g.
   `Bạn là người Nhật, đang trò chuyện tự nhiên với người học N2 về chủ đề "<jp>". Nói bằng tiếng Nhật tự nhiên, câu ngắn, mỗi lượt hỏi 1 câu để duy trì hội thoại. Trả về JSON {reply, replyFurigana, vi} — reply = câu tiếng Nhật, replyFurigana = cùng câu nhưng chú {漢字|かんじ}, vi = dịch tiếng Việt.`
   - On start: askJSON with user `会話を始めましょう。` → show opening line (furigana), speak it.
   - **Record button** (getUserMedia + MediaRecorder). Tap to start (label "⏺ Nói"), tap again to stop (label "⏹ Dừng"). On stop → blob → base64 → `askAudio({system, history, audioBase64, mimeType, promptText, schema})` where promptText asks the model to (a) transcribe the learner's Japanese as `heard` and (b) continue the conversation; schema `{heard, reply, replyFurigana, vi}`. Append both learner (`heard`) and partner (`reply`) to an in-memory transcript + chat history; render + speak reply.
   - **Text fallback** input (type instead of speak) — same handling minus audio.
   - MediaRecorder mimeType: try `'audio/webm'` then `'audio/mp4'` (iOS). Store the actual `recorder.mimeType`.
   - Handle mic permission denial gracefully (show message, keep text fallback).
3. **Review**: "🔚 Kết thúc & Đánh giá" button → `askJSON` over the full transcript:
   system `Bạn là giáo viên N2 khó tính nhưng thân thiện. Đánh giá đoạn hội thoại của người học.` user = transcript, schema:
   `{overallVi, score (0-100), corrections:[{original, corrected, explainVi}], grammarPointsVi:[...], vocabSuggestions:[{jp,vi}], encouragementVi}`.
   Render a nice report; button to return to topic picker.
- TTS `speak(text)` same as lesson.js (can duplicate the helper locally).

### app.js (bootstrap)
```js
import { setLessons } from './store.js';
import { initRouter } from './router.js';
import { initFuriganaToggle } from './furigana.js';
import { openSettings } from './gemini.js';
import { renderDashboard } from './dashboard.js';
import { renderLesson } from './lesson.js';
import { renderTutor } from './tutor.js';
import { renderVoice } from './voice.js';
// fetch('data/lessons.json') -> setLessons; initFuriganaToggle();
// wire header ⚙ button -> openSettings; bottom nav buttons -> navigate('#/'|'#/tutor'|'#/voice')
// initRouter({dashboard:renderDashboard, lesson:renderLesson, tutor:renderTutor, voice:renderVoice}, document.getElementById('app'))
```

## index.html contract
- `<head>`: charset, viewport `width=device-width, initial-scale=1` (allow zoom — remove maximum-scale for a11y), title, existing Google Fonts link, `<link rel="stylesheet" href="css/styles.css">`.
- `<header class="container">`: top-bar (brand + date), hero title `日本語総まとめ N2`, subtitle, and a control row with `⚙` settings button (`id="btn-settings"`).
- `<div id="app" class="container"></div>` — the router mount.
- `<nav class="bottom-nav">` fixed bottom: 3 `.nav-btn` with `data-route` = `dashboard` / `tutor` / `voice`, labels 総まとめ / 家庭教師AI / 会話練習 (+ small VI subtitle). ≥44px targets.
- `<script type="module" src="js/app.js"></script>`.

## CSS class contract (styles.css must define; keep existing tokens/look)
Existing tokens to KEEP (from current index.html): `--bg-page,--bg-card,--text-primary,--text-muted,--accent-red,--accent-gold,--border-color,--border-dark`, fonts Cinzel/Newsreader/Plus Jakarta Sans, shadows.
New/reused classes: `.container .bottom-nav .nav-btn.active` (fixed bottom bar, add body padding-bottom≈72px),
`.chat-wrap .chat-msg.user .chat-msg.model .chat-input-row`,
`.lesson-page .lesson-toolbar .content-section .example-box .jp-sentence .vi-sentence .tts-btn`,
`.vocab-item .kanji-item .quiz-option .review-card`,
`.settings-modal` (reuse `.modal-overlay/.modal-card` look),
`body.furigana-off rt{display:none}`, `ruby rt{font-size:.6em;color:var(--text-muted)}`.
Dashboard classes already in current file (`.stats-bar,.stat-item,.category-tabs,.tab-btn,.week-card,.lessons-grid,.lesson-item,.custom-checkbox,.study-btn` …) — port them.

## CONTENT SCHEMA (lesson content object; also what AI generation returns)
All Japanese strings use `{漢字|かんじ}` furigana markup.
```
grammar:  { pattern, meaningVi, formation, explanationVi, examples:[{jp,vi}], notes }
vocab:    { introVi, items:[{word, reading, meaningVi, example:{jp,vi}}] }
kanji:    { introVi, items:[{kanji, on, kun, meaningVi, examples:[{jp,vi}]}] }
reading:  { title, passage, vocabulary:[{word,vi}], questions:[{q, options:[..], answer, explainVi}] }
listening:{ scenario, transcript, vocabulary:[{word,vi}], questions:[{q, options:[..], answer, explainVi}] }
```
`practice` type lessons: treat like their parent category (grammar practice → grammar renderer with a "đề luyện tập" heading), or generate a short quiz. Renderer should not crash if fields missing.

## data/lessons.json SEED content (shell+data agent)
Keep the existing structure untouched; ADD a `content` field (matching schema) to these lessons with REAL, correct N2 material + accurate furigana + Vietnamese:
`g1d1 (熱っぽい/気味), g1d2, g1d3, g1d4, g1d5, g1d6`, `v1d1`, `k1d1`, `r1d1`, `l1d1`.
(Everything else stays content-less → generated on demand.) Ensure valid JSON.

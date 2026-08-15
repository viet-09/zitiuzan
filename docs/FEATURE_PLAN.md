# N2_web — MASTER FEATURE PLAN (v2, book-based) — SHIPPED, kept as historical record

> **All of R1–R7 below are implemented and live.** This is no longer a forward-looking plan — treat
> it as a record of decisions made on 2026-08-06, not current instructions. Notably: the pet is no
> longer a chibi SVG (cat/dog/dragon) — it went through a fox/rabbit chibi-SVG redesign and is now a
> small animated emoji (see `js/pet.js`); the app deploys to Vercel, not GitHub Pages. For current
> architecture, read `js/*.js` and `README.md` directly.

Authoritative plan for the next build round. All sub-agents read this + the referenced specs
(`EXTRACT_SPEC.md` for book schema, `DESIGN_TYPO.md` for the Typography-First look, `BUILD_SPEC.md` for module contracts).
Vanilla ES-modules SPA, no framework/build step, deployed on GitHub Pages. UI language = Vietnamese; study material = Japanese; book meanings = English (verbatim). No AI-authored study content.

## Confirmed user decisions (2026-08-06)
- **Structure follows the BOOK**, not the old fixed 219/6-week data. Rebuild `data/lessons.json` from each book's real table of contents (Kanji = 8 weeks × 7 days = 56 lessons; read each other book's TOC for its real week/day counts). lessonIds must match the extracted `data/book/*.json`.
- **Meanings shown in English** exactly as printed. **Tapping any kanji word → inline Gemini popup explaining it in Vietnamese** (the only AI/Vietnamese path for meanings).
- **Pet = chibi SVG/CSS**, animated in-code (no external images). Cat / dog / dragon selectable + accessory; expression & level driven by streak.
- **Voice = realtime call (Gemini Live over WebSocket)**: mic always-on, barge-in (interruptible), low latency, auto-saved transcript; graceful fallback to the existing record→send flow if Live/model unavailable.

## Requirement → implementation map (7 asks)

### R1. Structure per book
- Read TOC of all 5 books; regenerate `data/lessons.json`: categories = kanji/vocabulary/grammar/reading/listening, each with real weeks→days and the book's real JP titles (+ English subtitle). Keep a stable id scheme `{k|v|g|r|l}{week}d{day}`.
- Delete reliance on the old counts. The dashboard already renders from lessons.json, so it adapts automatically.

### R2. Ask-AI inside every lesson
- On the lesson page add an **"🎓 Hỏi gia sư AI"** action that opens the tutor **seeded with this lesson's context** (category, title, and the specific kanji/pattern/vocab on the page). Reuse `tutor.js` engine; pass an initial system/context so answers are about the current lesson. Must work for all categories.

### R3. User profile (name + avatar)
- New `profile.js` + store keys: `{ name, avatarType, avatarData }`. Avatar = pick from a preset set (chibi faces / emoji-style) OR upload an image (stored as data URL in localStorage, never uploaded anywhere).
- Show name + avatar in the masthead. First-visit gentle prompt to set name (skippable).

### R4. Streak pet (chibi SVG/CSS)
- New `pet.js` renders an inline animated chibi **cat/dog/dragon** (user-selectable) with an accessory (scarf/beanie). Idle animation (blink, bob, sparkle) via CSS.
- **Streak-driven states**: e.g. 0 = sad/asleep, 1-2 = waking, 3-6 = happy, 7-13 = excited + sparkles, 14+ = crown/aura. Expression + accessory shift by tier. Pet appears on the dashboard near the streak stat; tap = playful reaction.
- Design prompt the user provided (chibi, big sparkling eyes, pastel, tiny accessory, expressive, soft look, 9:16) is the *visual North Star* to emulate in SVG. Keep it on-brand with Typography-First (ink + vermillion + one pet pastel accent).
- Store: `{ petType, petAccessory }` in settings/profile.

### R5. Back button at the BOTTOM of each lesson page
- Add a second back control at the end of `renderLesson` content (in addition to the top toolbar one). Same `data-action="back"`.

### R6. Restore dashboard position on back
- Before navigating into a lesson, capture dashboard scrollY + active category tab + which week(s) expanded. On returning to `#/`, restore scroll position and UI state instead of resetting to top. Implement via a small module-level `dashboardState` + capture on `navigate` to lesson / restore in `renderDashboard`.
- NOTE: router currently force-scrolls #app to top after each render — make it skip the scroll-reset when returning to a dashboard that has a saved position.

### R7. Voice call = Gemini Live (realtime)
- New realtime client (WebSocket to Gemini Live API `BidiGenerateContent`). Mic streamed continuously (AudioWorklet/ScriptProcessor → PCM16 16kHz), model audio played back via Web Audio; support **barge-in** (stop playback when user speaks). Persist running transcript to chat history; show live captions.
- Requires a **Live-capable model** (e.g. a `*-flash-live` model). Add a separate "Live model" field in ⚙ settings; if Live fails (model/key/unsupported), fall back to current record→send `voice.js` flow with a visible notice.
- Keep topic picker + post-call review (existing) on top of the new transport.
- Security note to surface to user: baked Gemini key is public on GitHub Pages; a WebSocket key is equally exposed. Recommend restricting the key or self-hosting privately.

## Cross-cutting
- All new UI obeys `DESIGN_TYPO.md` (Fraunces / Space Grotesk / Zen Kaku Gothic New; ink-on-paper + vermillion; one soft pastel reserved for the pet). Every page & button synchronized.
- Furigana toggle continues to work app-wide; book text encodes `{漢字|よみ}`.
- Escape all untrusted/AI text before HTML insertion (furigana renderer output is trusted).

## Build order (sub-agent workstreams — spawn AFTER the Kanji W1 proof extraction is verified)
1. **Extraction** (biggest): per-book TOC → rebuild lessons.json; then per-week extractor agents fill `data/book/*.json` for ALL lessons (kanji/vocab/grammar/reading/listening). Attach listening MP3s.
2. **Renderer v2** (`lesson.js` + `store.js`): read `data/book/*` schema, English meanings, tap-kanji→AI Vietnamese popup, bottom back button, ask-AI button.
3. **Router/dashboard**: dashboard position save/restore (R6).
4. **Profile** (`profile.js`): name + avatar (R3).
5. **Pet** (`pet.js`): chibi SVG streak pet (R4).
6. **Voice Live** (`live.js` + `voice.js`): realtime call (R7).
7. **Restyle pass**: fold new components into Typography-First; verify class coverage.
8. **Smoke test** in browser; then deploy note.

## Tap-kanji → AI Vietnamese popup (detail for Renderer v2)
- Wrap each kanji headword / vocab word in a tappable span carrying its base text + reading.
- On tap: open a small popup anchored near the word; call Gemini (`askText` or a small `askJSON`) with a prompt like: "Giải thích ngắn gọn bằng tiếng Việt nghĩa và cách dùng của từ 「<word>」(<reading>) trong tiếng Nhật N2. Kèm 1 ví dụ ngắn có furigana {漢字|かな}." Cache results in `store` by word so repeat taps are instant/offline.
- Popup must be mobile-friendly (≥44px close target), dismiss on backdrop/Escape, and match the design system.

// supabase/functions/gemini-proxy/index.ts
// Edge Function (Supabase Deno) — generic Gemini text/audio proxy.
// POST /functions/v1/gemini-proxy
// Body: { system?: string, history?: Array<{role:'user'|'model', text:string}>,
//         user?: string, schema?: object, audio?: { base64: string, mimeType: string } }
// Response: { text: string }
//
// The raw GEMINI_API_KEY never reaches the browser: this function is the
// only thing that calls generativelanguage.googleapis.com. Callers
// (js/gemini.js) keep doing their own JSON.parse when they passed a
// `schema` — this function only forwards the request and returns text.
//
// Auth: Supabase verifies the Authorization JWT automatically. Anonymous → 401.
// Secrets (set via `supabase secrets set`):
//   GEMINI_API_KEY       — Google AI Studio key
//   SUPABASE_URL         — auto-injected
//   SUPABASE_ANON_KEY    — auto-injected (used only to forward the user's JWT)
//
// Deploy:
//   supabase functions deploy gemini-proxy --project-ref <ref>

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.0';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response> | Response): void;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const GEMINI_API_KEY_SHARED = Deno.env.get('GEMINI_API_KEY') ?? '';
const GEMINI_API_KEY_TUTOR = Deno.env.get('GEMINI_API_KEY_TUTOR') || GEMINI_API_KEY_SHARED;
const GEMINI_API_KEY_VOICE = Deno.env.get('GEMINI_API_KEY_VOICE') || GEMINI_API_KEY_SHARED;
const DEFAULT_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.5-flash-lite';

/** Each page (tutor Q&A, voice conversation) gets its own key where set, so
 * heavy usage on one page can't rate-limit the other — falls back to the
 * shared GEMINI_API_KEY when a page-specific one isn't configured. */
function keyForFeature(feature: unknown): string {
  return feature === 'voice' ? GEMINI_API_KEY_VOICE : GEMINI_API_KEY_TUTOR;
}

// The client (Settings modal) may request a faster/slower model, but only
// from this allowlist — never forward an arbitrary client-supplied string
// into the upstream URL.
const ALLOWED_MODELS = new Set(['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash']);

const MAX_TEXT_CHARS = 4000;
const MAX_HISTORY_TURNS = 40;
const MAX_AUDIO_BASE64_CHARS = 8_000_000; // ~6MB raw audio
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30; // generous for a chat UI, tight enough to block loops

// Tiny in-memory sliding-window limiter. Reset per isolate cold-start —
// at worst a user gets one extra window's worth of requests after a restart.
const requestLogByUser = new Map<string, number[]>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = (requestLogByUser.get(userId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    requestLogByUser.set(userId, timestamps);
    return true;
  }
  timestamps.push(now);
  requestLogByUser.set(userId, timestamps);
  return false;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function clampText(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.slice(0, maxChars) : '';
}

/** Coerce + clamp the chat history the client sent. */
function clampHistory(value: unknown): Array<{ role: string; text: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_HISTORY_TURNS)
    .filter((turn): turn is { role?: unknown; text?: unknown } => turn && typeof turn === 'object')
    .map((turn) => ({
      role: turn.role === 'model' ? 'model' : 'user',
      text: clampText(turn.text, MAX_TEXT_CHARS),
    }))
    .filter((turn) => turn.text !== '');
}

type ContentPart = Record<string, unknown>;
type Content = { role: string; parts: ContentPart[] };

function historyToContents(history: Array<{ role: string; text: string }>): Content[] {
  return history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  if (!GEMINI_API_KEY_SHARED || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonResponse({ error: 'Server misconfigured: missing secrets' }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing bearer token' }, 401);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error: userErr } = await sb.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: 'Invalid session' }, 401);

  if (isRateLimited(user.id)) {
    return jsonResponse({ error: 'Rate limit exceeded, please slow down' }, 429);
  }

  let raw: {
    system?: unknown;
    history?: unknown;
    user?: unknown;
    schema?: unknown;
    audio?: unknown;
    model?: unknown;
    feature?: unknown;
  } = {};
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }

  const system = clampText(raw.system, MAX_TEXT_CHARS);
  const history = clampHistory(raw.history);
  const userText = clampText(raw.user, MAX_TEXT_CHARS);
  const schema = raw.schema && typeof raw.schema === 'object' ? raw.schema : null;
  const model = typeof raw.model === 'string' && ALLOWED_MODELS.has(raw.model) ? raw.model : DEFAULT_MODEL;

  const contents: Content[] = historyToContents(history);
  const userParts: ContentPart[] = [];
  if (userText) userParts.push({ text: userText });

  if (raw.audio && typeof raw.audio === 'object') {
    const audio = raw.audio as { base64?: unknown; mimeType?: unknown };
    const base64 = typeof audio.base64 === 'string' ? audio.base64.slice(0, MAX_AUDIO_BASE64_CHARS) : '';
    const mimeType = typeof audio.mimeType === 'string' ? audio.mimeType.slice(0, 60) : 'audio/webm';
    if (!base64) return jsonResponse({ error: 'audio.base64 is required when audio is provided' }, 400);
    userParts.push({ inline_data: { mime_type: mimeType, data: base64 } });
  }

  if (userParts.length === 0) {
    return jsonResponse({ error: 'Provide at least `user` text or `audio`' }, 400);
  }
  contents.push({ role: 'user', parts: userParts });

  const generationConfig: Record<string, unknown> = { temperature: 0.7 };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schema;
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${keyForFeature(raw.feature)}`;

  try {
    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        generationConfig,
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => '');
      console.error('Gemini non-OK:', geminiRes.status, errText.slice(0, 200));
      return jsonResponse({ error: 'Gemini request failed' }, 502);
    }

    const geminiJson = await geminiRes.json();
    const text = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) return jsonResponse({ error: 'Gemini trả về nội dung trống.' }, 502);

    return jsonResponse({ text });
  } catch (err) {
    console.error('Gemini call failed:', err);
    return jsonResponse({ error: 'Gemini request failed' }, 502);
  }
});

// supabase/functions/evaluate-ai/index.ts
// Edge Function (Supabase Deno) — AI level evaluation.
// POST /functions/v1/evaluate-ai
// Body: { metrics: { totalCorrect: number, totalAttempted: number,
//                     byCategory: Record<string, { correct: number, attempted: number }>,
//                     recentLessonIds: string[] } }
// Response: { level: "N5"|"N4"|"N3"|"N2"|"N1", reasoning: string }
// Persists ai_level + ai_level_updated_at on user_profiles.
//
// Auth: Supabase verifies the Authorization JWT automatically. Anonymous → 401.
// Secrets (set via `supabase secrets set`):
//   GEMINI_API_KEYS      — comma-separated pool of Google AI Studio keys
//                          (see _shared/gemini-key-pool.ts; falls back to
//                          the single GEMINI_API_KEY secret if unset)
//   SUPABASE_URL         — auto-injected
//   SUPABASE_ANON_KEY    — auto-injected (used only to forward the user's JWT)
//
// Deploy:
//   supabase functions deploy evaluate-ai --project-ref <ref>

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.0';
import { hasGeminiKeys, withGeminiKeyFailover } from '../_shared/gemini-key-pool.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response> | Response): void;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.5-flash';

const ALLOWED_LEVELS = new Set(['N5', 'N4', 'N3', 'N2', 'N1']);
const COOLDOWN_MS = 60_000; // per-user rate-limit window

// Tiny in-memory cooldown map. Replaced per isolate cold-start but that's
// fine — at worst a user can hit the limit once per isolate lifetime.
const lastCallByUser = new Map<string, number>();

const SYSTEM = [
  'Bạn là chuyên gia đánh giá trình độ JLPT.',
  'Dựa trên accuracy + số câu đã làm + độ phủ category, hãy chọn level N5|N4|N3|N2|N1 phù hợp nhất.',
  'Trả về JSON thuần: {"level":"N5|N4|N3|N2|N1","reasoning":"<giải thích ≤120 ký tự>"}',
  'Không kèm markdown, không giải thích ngoài JSON.',
].join(' ');

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

/** Coerce a value to a non-negative integer within an optional bound. */
function clampInt(value: unknown, min: number, max: number, fallback = 0): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Coerce a string map of {correct, attempted} objects. Caps both
 *  the number of keys and the per-key value range. */
function clampCategoryMap(value: unknown): Record<string, { correct: number; attempted: number }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 20);
  const out: Record<string, { correct: number; attempted: number }> = {};
  for (const [key, entry] of entries) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(key)) continue;
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { correct?: unknown; attempted?: unknown };
    out[key] = {
      correct: clampInt(e.correct, 0, 100000),
      attempted: clampInt(e.attempted, 0, 100000),
    };
  }
  return out;
}

/** Cap lesson-id strings to alphanumeric to keep prompt-injection payloads
 *  out of the Gemini prompt. */
function clampLessonIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.slice(0, 64))
    .filter((v) => /^[a-zA-Z0-9_-]{1,64}$/.test(v))
    .slice(0, 20);
}

function safeParseLevel(text: string): { level: string; reasoning: string } | null {
  try {
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const level = typeof parsed.level === 'string' && ALLOWED_LEVELS.has(parsed.level)
      ? parsed.level
      : null;
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 200) : '';
    return level ? { level, reasoning } : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  if (!hasGeminiKeys() || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonResponse({ error: 'Server misconfigured: missing secrets' }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing bearer token' }, 401);
  }

  // Forward user's JWT to a scoped client so RLS kicks in.
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error: userErr } = await sb.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: 'Invalid session' }, 401);

  // Per-user cooldown. Cheap protection against repeated Gemini calls.
  const last = lastCallByUser.get(user.id) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) {
    const retryIn = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000);
    return jsonResponse({ error: 'Cooldown active', retryInSeconds: retryIn }, 429);
  }
  lastCallByUser.set(user.id, Date.now());

  let raw: { metrics?: unknown } = {};
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }

  const metrics = (raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : {}) as {
    totalCorrect?: unknown;
    totalAttempted?: unknown;
    byCategory?: unknown;
    recentLessonIds?: unknown;
  };

  const totalCorrect = clampInt(metrics.totalCorrect, 0, 100000);
  const totalAttempted = clampInt(metrics.totalAttempted, 0, 100000);
  const byCategory = clampCategoryMap(metrics.byCategory);
  const recent = clampLessonIds(metrics.recentLessonIds);
  const accuracy = totalAttempted > 0 ? totalCorrect / totalAttempted : 0;

  const prompt = [
    SYSTEM,
    '',
    `Accuracy: ${(accuracy * 100).toFixed(1)}%`,
    `Total: ${totalCorrect}/${totalAttempted}`,
    `By category: ${JSON.stringify(byCategory)}`,
    `Recent lesson IDs: ${recent.join(', ') || '(none)'}`,
  ].join('\n');

  const attempt = await withGeminiKeyFailover<{ level: string; reasoning: string }>(async (key) => {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${key}`;
    try {
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2,
          },
        }),
      });
      if (!geminiRes.ok) {
        const errText = await geminiRes.text().catch(() => '');
        return { ok: false, status: geminiRes.status, errorText: errText.slice(0, 200) };
      }
      const geminiJson = await geminiRes.json();
      const text = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const parsed = safeParseLevel(text);
      if (!parsed) return { ok: false, status: 502, errorText: 'unparseable response' };
      return { ok: true, value: parsed };
    } catch (err) {
      return { ok: false, status: 502, errorText: String(err) };
    }
  });

  // On failure, refuse to persist and tell the client to retry. We never
  // silently write the wrong level.
  if (!attempt.ok) {
    console.error('Gemini call failed after trying all keys:', attempt.status, attempt.errorText);
    return jsonResponse({ error: 'AI returned an unparseable response' }, 502);
  }
  const result = attempt.value;

  const { error: updateErr } = await sb
    .from('user_profiles')
    .update({
      ai_level: result.level,
      ai_level_updated_at: new Date().toISOString(),
    })
    .eq('user_id', user.id);

  if (updateErr) {
    console.error('Profile update failed:', updateErr);
    return jsonResponse({ error: 'Profile update failed', detail: updateErr.message }, 500);
  }

  return jsonResponse({ level: result.level, reasoning: result.reasoning });
});
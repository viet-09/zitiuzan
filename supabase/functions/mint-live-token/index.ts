// supabase/functions/mint-live-token/index.ts
// Edge Function (Supabase Deno) — mints a short-lived Gemini Live API
// ephemeral token so js/live.js can open its voice WebSocket directly
// against Gemini without ever holding the real GEMINI_API_KEY.
//
// POST /functions/v1/mint-live-token
// Body: { model?: string }
// Response: { accessToken: string, expiresAt: string }
//
// Reference: https://ai.google.dev/gemini-api/docs/ephemeral-tokens
// The token is single-use (uses:1), must start a session within 1 minute
// (newSessionExpireTime), and that session may run for up to 30 minutes
// (expireTime). js/live.js connects with `?access_token=` against the
// *v1alpha* "Constrained" WebSocket variant — ephemeral tokens are only
// supported on v1alpha, unlike the rest of this app's Gemini calls.
//
// Auth: Supabase verifies the Authorization JWT automatically. Anonymous → 401.
// Secrets (set via `supabase secrets set`):
//   GEMINI_API_KEY       — Google AI Studio key
//   SUPABASE_URL         — auto-injected
//   SUPABASE_ANON_KEY    — auto-injected (used only to forward the user's JWT)
//
// Deploy:
//   supabase functions deploy mint-live-token --project-ref <ref>

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.0';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response> | Response): void;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
// Voice conversation gets its own key where set, so heavy tutor/exam usage
// elsewhere can't rate-limit live voice sessions — falls back to the shared
// GEMINI_API_KEY when a voice-specific one isn't configured.
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY_VOICE') || Deno.env.get('GEMINI_API_KEY') || '';
const DEFAULT_LIVE_MODEL = Deno.env.get('GEMINI_LIVE_MODEL') ?? 'gemini-3.1-flash-live-preview';

const ALLOWED_LIVE_MODELS = new Set([
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-latest',
]);

// Minting a session token happens once per call, not per message — a much
// tighter window than the chat proxy's rate limit is appropriate.
const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
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

  let raw: { model?: unknown } = {};
  try {
    raw = await req.json();
  } catch {
    // Body is optional — model falls back to DEFAULT_LIVE_MODEL below.
  }
  const model = typeof raw.model === 'string' && ALLOWED_LIVE_MODELS.has(raw.model) ? raw.model : DEFAULT_LIVE_MODEL;

  const now = Date.now();
  const expireTime = new Date(now + 30 * 60_000).toISOString();
  const newSessionExpireTime = new Date(now + 60_000).toISOString();

  try {
    const tokenRes = await fetch('https://generativelanguage.googleapis.com/v1alpha/auth_tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        uses: 1,
        expireTime,
        newSessionExpireTime,
        liveConnectConstraints: {
          model: `models/${model}`,
          config: { responseModalities: ['AUDIO'] },
        },
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      console.error('auth_tokens.create non-OK:', tokenRes.status, errText.slice(0, 300));
      return jsonResponse({ error: 'Không thể tạo access token cho Gemini Live' }, 502);
    }

    const tokenJson = await tokenRes.json();
    const accessToken = typeof tokenJson?.name === 'string' ? tokenJson.name : '';
    if (!accessToken) return jsonResponse({ error: 'Gemini trả về token rỗng' }, 502);

    return jsonResponse({ accessToken, expiresAt: expireTime });
  } catch (err) {
    console.error('mint-live-token failed:', err);
    return jsonResponse({ error: 'Không thể tạo access token cho Gemini Live' }, 502);
  }
});

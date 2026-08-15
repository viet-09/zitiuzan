// supabase/functions/lesson-audio-url/index.ts
// Mints short-lived signed URLs for listening-lesson CD audio (owned,
// copyrighted CD-rip source under N2_somatome/ — see .gitignore — so it
// never ships to production as static files; data/book/listening.json's
// audioTracks/introTracks `src` fields reference storage keys like
// "cd1/02.mp3" instead of a direct path, and js/lesson-audio.js resolves
// them through this function before setting an <audio> element's src).
//
// Unlike exam-fetch, every signed-in learner may request any key — the
// whole book's audio is available to everyone, there's no per-user answer
// key to protect here. The key allowlist regex is just a defensive input
// boundary (reject anything outside the known cd1/cd2 track shape) rather
// than an authorization check.
//
// POST /functions/v1/lesson-audio-url
// Body: { keys: string[] }  -> { urls: { [key]: string | null } }
// Auth: Supabase verifies the Authorization JWT automatically. Anonymous → 401.
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (auto-injected).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.0';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response> | Response): void;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

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

// Matches every key uploaded by scripts/upload-lesson-audio.mjs: cd1|cd2 / two-digit track number.
const KEY_PATTERN = /^cd[12]\/\d{2}\.mp3$/;
const MAX_KEYS = 20;
const SIGNED_URL_TTL_SECONDS = 60 * 60;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'Server misconfigured: missing secrets' }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing bearer token' }, 401);
  }

  const authedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userErr } = await authedClient.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: 'Invalid session' }, 401);

  let raw: { keys?: unknown } = {};
  try {
    raw = await req.json();
  } catch {
    // empty body -> no keys, handled below
  }

  const requested = Array.isArray(raw.keys) ? raw.keys.filter((k): k is string => typeof k === 'string') : [];
  const safeKeys = [...new Set(requested.filter((k) => KEY_PATTERN.test(k)))].slice(0, MAX_KEYS);

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const urls: Record<string, string | null> = {};
  for (const key of safeKeys) {
    const { data } = await serviceClient.storage.from('lesson-audio').createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
    urls[key] = data?.signedUrl ?? null;
  }

  return jsonResponse({ urls });
});

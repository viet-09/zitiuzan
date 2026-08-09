// supabase/functions/exam-fetch/index.ts
// Serves mock-exam content to the client with answers stripped — the
// exam_content table has no client-facing RLS policy at all (see
// supabase/schema.sql §11), specifically so the answer key can never reach
// the browser before/during the test. This function is the only reader,
// using the service-role key, and always removes answerIndex/referenceNote
// before responding.
//
// POST /functions/v1/exam-fetch
// Body: {} or {list:true}                    -> { exams: [{level, sitting}] }
// Body: { level: "N2", sitting: "2019-12" }  -> { level, sitting, sections: [...] } (no answers)
//
// Auth: Supabase verifies the Authorization JWT automatically. Anonymous → 401.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (both auto-injected).

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

/** Strip every question's answerIndex/referenceNote before it can reach the client. */
function sanitizeContent(content: Record<string, unknown>) {
  const sections = Array.isArray(content.sections) ? content.sections : [];
  const safeSections = sections.map((section: Record<string, unknown>) => ({
    ...section,
    parts: (Array.isArray(section.parts) ? section.parts : []).map((part: Record<string, unknown>) => ({
      ...part,
      questions: (Array.isArray(part.questions) ? part.questions : []).map((q: Record<string, unknown>) => ({
        number: q.number,
        passageId: q.passageId,
        prompt: q.prompt,
        options: q.options,
      })),
    })),
  }));
  return { level: content.level, sitting: content.sitting, sections: safeSections };
}

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

  let raw: { level?: unknown; sitting?: unknown; list?: unknown } = {};
  try {
    raw = await req.json();
  } catch {
    // empty body is valid — treated as a list request below
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const level = typeof raw.level === 'string' ? raw.level : '';
  const sitting = typeof raw.sitting === 'string' ? raw.sitting : '';

  if (!level || !sitting) {
    const { data, error } = await serviceClient.from('exam_content').select('jlpt_level,sitting');
    if (error) return jsonResponse({ error: 'Failed to list exams' }, 500);
    return jsonResponse({ exams: (data ?? []).map((row) => ({ level: row.jlpt_level, sitting: row.sitting })) });
  }

  const { data, error } = await serviceClient
    .from('exam_content')
    .select('content')
    .eq('jlpt_level', level)
    .eq('sitting', sitting)
    .maybeSingle();

  if (error) return jsonResponse({ error: 'Failed to load exam' }, 500);
  if (!data) return jsonResponse({ error: 'Exam not found' }, 404);

  const sanitized = sanitizeContent(data.content as Record<string, unknown>);
  const audioUrls = await resolveAudioUrls(serviceClient, level, sitting);

  return jsonResponse({ ...sanitized, audioUrls });
});

/** Listening audio is owned/copyrighted source — never public. Files over
 * Supabase's 50MB/object Storage ceiling are uploaded as ordered parts
 * (`{sitting}-part1.mp3`, `-part2.mp3`, ...) instead of one big object —
 * see scripts/upload-exam-audio.mjs. This lists whichever shape exists for
 * a sitting and returns short-lived (2h) signed URLs in playback order.
 * Missing audio degrades gracefully — the client just won't render a player. */
async function resolveAudioUrls(
  serviceClient: ReturnType<typeof createClient>,
  level: string,
  sitting: string,
): Promise<string[]> {
  const folder = level.toLowerCase();
  const { data: objects } = await serviceClient.storage.from('exam-audio').list(folder, { limit: 1000 });
  const escapedSitting = sitting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedSitting}(?:-part(\\d+))?\\.mp3$`);

  const matches = (objects ?? [])
    .map((o) => ({ name: o.name, part: Number(pattern.exec(o.name)?.[1] ?? 0) }))
    .filter((o) => pattern.test(o.name))
    .sort((a, b) => a.part - b.part);

  const urls: string[] = [];
  for (const m of matches) {
    const { data: signed } = await serviceClient.storage
      .from('exam-audio')
      .createSignedUrl(`${folder}/${m.name}`, 2 * 60 * 60);
    if (signed?.signedUrl) urls.push(signed.signedUrl);
  }
  return urls;
}

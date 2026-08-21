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

  // Listening audio is not served from here any more: it lives on a public
  // GitHub Release and the client derives its URLs (see js/audio-source.js),
  // which saves a Storage list plus one signing round trip per exam load.
  return jsonResponse(sanitizeContent(data.content as Record<string, unknown>));
});


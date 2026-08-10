// supabase/functions/exam-review/index.ts
// Grades a submitted mock-exam attempt INSTANTLY against exam_content's
// stored answer key and persists the attempt — no Gemini call on the
// critical submit path, so the score always comes back immediately. The
// optional AI explanation/weakness-diagnosis/retest is a separate opt-in
// step — see exam-review-explain — triggered only if the user asks to see
// details, never generated eagerly here.
//
// A client can never supply its own score — grading happens here, server
// side, against exam_content (no client select/insert policy — see
// supabase/schema.sql §11-12; service-role bypasses RLS).
//
// POST /functions/v1/exam-review
// Body: { level: "N2", sitting: "2019-12",
//          answers: [{ section, part, number, selectedIndex }] }
// Response: { session_id, timestamp, jlpt_level, source_file, score, detailed_review }
//   detailed_review rows have empty explanation/remediation_rule until
//   exam-review-explain fills them in.
//
// Auth: Supabase verifies the Authorization JWT automatically. Anonymous → 401.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected).

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

interface Question {
  section: string;
  part: string;
  number: number;
  options: string[];
  answerIndex: number;
}

function flattenQuestions(content: Record<string, unknown>): Question[] {
  const out: Question[] = [];
  const sections = Array.isArray(content.sections) ? content.sections : [];
  for (const section of sections as Array<Record<string, unknown>>) {
    const sectionId = String(section.id ?? '');
    const parts = Array.isArray(section.parts) ? section.parts : [];
    for (const part of parts as Array<Record<string, unknown>>) {
      const partLabel = String(part.part ?? '');
      const questions = Array.isArray(part.questions) ? part.questions : [];
      for (const q of questions as Array<Record<string, unknown>>) {
        out.push({
          section: sectionId,
          part: partLabel,
          number: Number(q.number),
          options: Array.isArray(q.options) ? q.options.map(String) : [],
          answerIndex: Number(q.answerIndex),
        });
      }
    }
  }
  return out;
}

function questionId(q: { section: string; part: string; number: number }): string {
  return `${q.section}:${q.part}:${q.number}`;
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

  let raw: { level?: unknown; sitting?: unknown; answers?: unknown } = {};
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }

  const level = typeof raw.level === 'string' ? raw.level.slice(0, 8) : '';
  const sitting = typeof raw.sitting === 'string' ? raw.sitting.slice(0, 16) : '';
  const submitted = Array.isArray(raw.answers) ? raw.answers : [];
  if (!level || !sitting) return jsonResponse({ error: 'level and sitting are required' }, 400);
  if (submitted.length === 0 || submitted.length > 200) {
    return jsonResponse({ error: 'answers must be a non-empty array (max 200)' }, 400);
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: examRow, error: examErr } = await serviceClient
    .from('exam_content')
    .select('content')
    .eq('jlpt_level', level)
    .eq('sitting', sitting)
    .maybeSingle();
  if (examErr) return jsonResponse({ error: 'Failed to load exam' }, 500);
  if (!examRow) return jsonResponse({ error: 'Exam not found' }, 404);

  const questions = flattenQuestions(examRow.content as Record<string, unknown>);
  const byId = new Map(questions.map((q) => [questionId(q), q]));

  // Grade server-side. Unknown/duplicate question ids in the submission are
  // ignored; missing questions count as unanswered (wrong).
  const answered = new Map<string, number>();
  for (const entry of submitted as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== 'object') continue;
    const section = String(entry.section ?? '');
    const part = String(entry.part ?? '');
    const number = Number(entry.number);
    const selectedIndex = Number.isInteger(entry.selectedIndex) ? Number(entry.selectedIndex) : -1;
    const id = questionId({ section, part, number });
    if (byId.has(id)) answered.set(id, selectedIndex);
  }

  const detailedReview: Array<Record<string, unknown>> = [];
  const sectionTotals = new Map<string, { correct: number; total: number }>();

  for (const q of questions) {
    // A question can carry answerIndex === -1 (or out of range) when its
    // answer key was never successfully extracted — a data gap, not a real
    // "no answer" state. It must never be graded: counting it would let an
    // unanswered submission (selectedIndex also -1) score as "correct" by
    // pure coincidence, and there's no fair way to judge it either way since
    // the true answer is unknown. Excluded from numerator and denominator.
    if (q.answerIndex < 0 || q.answerIndex >= q.options.length) continue;

    const id = questionId(q);
    const selectedIndex = answered.has(id) ? answered.get(id)! : -1;
    const isCorrect = selectedIndex === q.answerIndex;
    const bucket = sectionTotals.get(q.section) ?? { correct: 0, total: 0 };
    bucket.total += 1;
    if (isCorrect) bucket.correct += 1;
    sectionTotals.set(q.section, bucket);

    const userAnswerText = selectedIndex >= 0 && selectedIndex < q.options.length ? q.options[selectedIndex] : '(không trả lời)';
    const correctAnswerText = q.options[q.answerIndex] ?? '';

    detailedReview.push({
      question_id: id,
      user_answer: userAnswerText,
      correct_answer: correctAnswerText,
      is_correct: isCorrect,
      explanation: '',
      remediation_rule: '',
    });
  }

  const gradedTotal = detailedReview.length;
  const totalCorrect = detailedReview.filter((r) => r.is_correct).length;
  const scorePercentage = gradedTotal > 0 ? Math.round((totalCorrect / gradedTotal) * 1000) / 10 : 0;

  const attempt = {
    user_id: user.id,
    jlpt_level: level,
    source_file: sitting,
    score: {
      total: totalCorrect,
      max: gradedTotal,
      percentage: `${scorePercentage}%`,
      bySection: Object.fromEntries(
        Array.from(sectionTotals.entries()).map(([id, v]) => [id, { correct: v.correct, total: v.total }]),
      ),
    },
    weakness_tags: [],
    detailed_review: detailedReview,
    retest_generated: false,
    retest_questions: null,
  };

  const { data: inserted, error: insertErr } = await serviceClient
    .from('exam_attempts')
    .insert(attempt)
    .select('id, created_at')
    .single();
  if (insertErr) {
    console.error('exam_attempts insert failed:', insertErr);
    return jsonResponse({ error: 'Failed to save attempt' }, 500);
  }

  // Award score on the user's own JWT so the existing bump_score RPC's
  // auth.uid() check applies normally — same mechanism as lesson completion.
  const bonus = 30 + Math.round(scorePercentage * 0.5);
  const { error: bumpErr } = await authedClient.rpc('bump_score', { p_user_id: user.id, p_delta: bonus });
  if (bumpErr) console.error('bump_score after exam failed:', bumpErr);

  return jsonResponse({
    session_id: inserted.id,
    timestamp: inserted.created_at,
    jlpt_level: level,
    source_file: sitting,
    score: attempt.score,
    weakness_tags: [],
    detailed_review: detailedReview,
    retest_generated: false,
    retest_questions: null,
  });
});

// supabase/functions/exam-review-explain/index.ts
// Optional, opt-in deep-dive for an already-graded exam attempt: AI-written
// per-question explanations, a weakness diagnosis, and a targeted retest
// quiz. Only called when the user actually clicks "Xem chi tiết" on the
// score screen — exam-review's submit path never calls Gemini itself, so
// the score always comes back instantly regardless of this step.
//
// POST /functions/v1/exam-review-explain
// Body: { attempt_id: "<uuid>" }
// Response: same shape as exam-review's, now with explanations/weakness_tags/
//   retest_questions filled in.
//
// Auth: Supabase verifies the Authorization JWT automatically. Anonymous → 401.
// Idempotent: if the attempt was already explained (or has nothing wrong to
// explain), returns the existing row without calling Gemini again.
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (auto-injected),
//          GEMINI_API_KEYS — comma-separated pool of keys (see
//          _shared/gemini-key-pool.ts; falls back to the single
//          GEMINI_API_KEY secret if unset).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.0';
import { hasGeminiKeys, withGeminiKeyFailover } from '../_shared/gemini-key-pool.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response> | Response): void;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.5-flash';

const COOLDOWN_MS = 15_000;
const lastCallByUser = new Map<string, number>();

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
  prompt: string;
  options: string[];
  answerIndex: number;
  referenceNote: string;
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
          prompt: String(q.prompt ?? ''),
          options: Array.isArray(q.options) ? q.options.map(String) : [],
          answerIndex: Number(q.answerIndex),
          referenceNote: String(q.referenceNote ?? ''),
        });
      }
    }
  }
  return out;
}

function questionId(q: { section: string; part: string; number: number }): string {
  return `${q.section}:${q.part}:${q.number}`;
}

async function callGemini(systemInstruction: string, prompt: string, schema: Record<string, unknown>) {
  const attempt = await withGeminiKeyFailover<unknown>(async (key) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: schema },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, status: res.status, errorText: detail.slice(0, 300) };
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) return { ok: false, status: 502, errorText: 'Gemini returned no content' };
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (err) {
      return { ok: false, status: 502, errorText: `JSON parse failed: ${err}` };
    }
  });
  if (!attempt.ok) throw new Error(`Gemini HTTP ${attempt.status}: ${attempt.errorText}`);
  return attempt.value;
}

const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          questionId: { type: 'STRING' },
          explanation: { type: 'STRING' },
          remediationRule: { type: 'STRING' },
        },
        required: ['questionId', 'explanation', 'remediationRule'],
      },
    },
    weaknessTags: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['items', 'weaknessTags'],
};

const RETEST_SCHEMA = {
  type: 'OBJECT',
  properties: {
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          prompt: { type: 'STRING' },
          options: { type: 'ARRAY', items: { type: 'STRING' } },
          answerIndex: { type: 'INTEGER' },
          explanation: { type: 'STRING' },
        },
        required: ['prompt', 'options', 'answerIndex', 'explanation'],
      },
    },
  },
  required: ['questions'],
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !hasGeminiKeys()) {
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

  let raw: { attempt_id?: unknown } = {};
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }
  const attemptId = typeof raw.attempt_id === 'string' ? raw.attempt_id : '';
  if (!attemptId) return jsonResponse({ error: 'attempt_id is required' }, 400);

  // RLS ("exam attempts read self") scopes this to the caller's own attempt —
  // a stranger's attempt_id simply comes back empty, never someone else's data.
  const { data: attempt, error: attemptErr } = await authedClient
    .from('exam_attempts')
    .select('id, jlpt_level, source_file, score, weakness_tags, detailed_review, retest_generated, retest_questions, created_at')
    .eq('id', attemptId)
    .maybeSingle();
  if (attemptErr) return jsonResponse({ error: 'Failed to load attempt' }, 500);
  if (!attempt) return jsonResponse({ error: 'Attempt not found' }, 404);

  const detailedReview = Array.isArray(attempt.detailed_review) ? attempt.detailed_review : [];
  const wrongRows = detailedReview.filter((r: Record<string, unknown>) => !r.is_correct);

  // Already explained (or nothing to explain) — return as-is, no Gemini call.
  const alreadyExplained = wrongRows.length === 0 || wrongRows.every((r: Record<string, unknown>) => r.explanation);
  if (alreadyExplained) {
    return jsonResponse({
      session_id: attempt.id,
      timestamp: attempt.created_at,
      jlpt_level: attempt.jlpt_level,
      source_file: attempt.source_file,
      score: attempt.score,
      weakness_tags: attempt.weakness_tags ?? [],
      detailed_review: detailedReview,
      retest_generated: attempt.retest_generated,
      retest_questions: attempt.retest_questions,
    });
  }

  const last = lastCallByUser.get(user.id) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) {
    return jsonResponse({ error: 'Cooldown active, please wait a moment' }, 429);
  }
  lastCallByUser.set(user.id, Date.now());

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: examRow, error: examErr } = await serviceClient
    .from('exam_content')
    .select('content')
    .eq('jlpt_level', attempt.jlpt_level)
    .eq('sitting', attempt.source_file)
    .maybeSingle();
  if (examErr || !examRow) return jsonResponse({ error: 'Failed to load exam content' }, 500);

  const byId = new Map(flattenQuestions(examRow.content as Record<string, unknown>).map((q) => [questionId(q), q]));
  const wrongForAi = wrongRows
    .map((r: Record<string, unknown>) => {
      const q = byId.get(String(r.question_id));
      if (!q) return null;
      return { ...q, id: String(r.question_id), userAnswerText: String(r.user_answer ?? ''), correctAnswerText: String(r.correct_answer ?? '') };
    })
    .filter((w: unknown): w is NonNullable<typeof w> => w !== null);

  let weaknessTags: string[] = [];
  let retestQuestions: unknown[] = [];

  try {
    const reviewPrompt = [
      'Danh sách câu sai (JSON), mỗi câu có prompt/options/userAnswerText/correctAnswerText/referenceNote (referenceNote là ghi chú tham khảo gốc, có thể tiếng Trung — chỉ dùng để tra cứu, không copy nguyên văn):',
      JSON.stringify(wrongForAi.map((w) => ({
        questionId: w.id,
        prompt: w.prompt,
        options: w.options,
        userAnswerText: w.userAnswerText,
        correctAnswerText: w.correctAnswerText,
        referenceNote: w.referenceNote.slice(0, 800),
      }))),
    ].join('\n');
    const reviewResult = await callGemini(
      'Bạn là gia sư JLPT. Với mỗi câu sai, giải thích bằng tiếng Việt: vì sao lựa chọn của người học sai (lỗi/hiểu nhầm thường gặp) và quy tắc ngữ pháp/từ vựng đúng cho đáp án chính xác, có ví dụ minh họa ngắn. Dùng referenceNote làm tài liệu tra cứu, diễn giải lại bằng tiếng Việt — không sao chép nguyên văn tiếng Trung. remediationRule là một câu ngắn nêu quy tắc cần nhớ. Cuối cùng, tổng hợp weaknessTags: danh sách ngắn (tiếng Việt) các điểm yếu kỹ thuật cốt lõi rút ra từ toàn bộ câu sai (ví dụ: "Nhầm lẫn thể bị động-sai khiến", "Nhầm trợ từ に và で"). Trả về JSON đúng schema.',
      reviewPrompt,
      REVIEW_SCHEMA,
    );
    const byQid = new Map((reviewResult.items ?? []).map((it: Record<string, unknown>) => [it.questionId, it]));
    for (const row of detailedReview) {
      if (row.is_correct) continue;
      const aiItem = byQid.get(row.question_id) as Record<string, unknown> | undefined;
      if (aiItem) {
        row.explanation = aiItem.explanation ?? '';
        row.remediation_rule = aiItem.remediationRule ?? '';
      }
    }
    weaknessTags = Array.isArray(reviewResult.weaknessTags) ? reviewResult.weaknessTags.slice(0, 10) : [];
  } catch (err) {
    console.error('AI review generation failed:', err);
    return jsonResponse({ error: 'Không thể tạo nhận xét AI lúc này, vui lòng thử lại.' }, 502);
  }

  try {
    const retestCount = Math.min(5, Math.max(3, wrongForAi.length));
    const retestPrompt = [
      `Điểm yếu cần luyện: ${weaknessTags.join(', ') || '(xem câu sai dưới đây)'}`,
      'Câu sai gốc để tham khảo phong cách/độ khó (không lặp lại nguyên câu):',
      JSON.stringify(wrongForAi.slice(0, 8).map((w) => ({ prompt: w.prompt, options: w.options }))),
    ].join('\n');
    const retestResult = await callGemini(
      `Bạn là người soạn đề JLPT ${attempt.jlpt_level}. Soạn ${retestCount} câu hỏi trắc nghiệm MỚI (tiếng Nhật, 4 lựa chọn, đúng 1 đáp án) nhắm đúng vào các điểm yếu đã cho — không sao chép câu gốc. Mỗi câu có explanation ngắn bằng tiếng Việt giải thích đáp án đúng. Trả về JSON đúng schema.`,
      retestPrompt,
      RETEST_SCHEMA,
    );
    retestQuestions = Array.isArray(retestResult.questions) ? retestResult.questions : [];
  } catch (err) {
    console.error('Retest generation failed:', err);
    // Explanations already succeeded — degrade gracefully, just no retest this time.
  }

  const { error: updateErr } = await serviceClient
    .from('exam_attempts')
    .update({
      weakness_tags: weaknessTags,
      detailed_review: detailedReview,
      retest_generated: retestQuestions.length > 0,
      retest_questions: retestQuestions.length > 0 ? retestQuestions : null,
    })
    .eq('id', attemptId);
  if (updateErr) console.error('exam_attempts update failed:', updateErr);

  return jsonResponse({
    session_id: attempt.id,
    timestamp: attempt.created_at,
    jlpt_level: attempt.jlpt_level,
    source_file: attempt.source_file,
    score: attempt.score,
    weakness_tags: weaknessTags,
    detailed_review: detailedReview,
    retest_generated: retestQuestions.length > 0,
    retest_questions: retestQuestions.length > 0 ? retestQuestions : null,
  });
});

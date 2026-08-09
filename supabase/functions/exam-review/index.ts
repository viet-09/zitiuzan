// supabase/functions/exam-review/index.ts
// Grades a submitted mock-exam attempt, generates an AI-written detailed
// review + weakness diagnosis + a targeted 3-5 question retest quiz, awards
// score, and persists the attempt. Scoring is computed here server-side
// against exam_content's answer key — a client can never supply its own
// score. Written with the service-role key (exam_attempts/exam_content have
// no client insert/select-by-others policy — see supabase/schema.sql §11-12).
//
// POST /functions/v1/exam-review
// Body: { level: "N2", sitting: "2019-12",
//          answers: [{ section, part, number, selectedIndex }] }
// Response: matches the caller's history-log shape:
//   { session_id, timestamp, jlpt_level, source_file, score,
//     weakness_tags, detailed_review, retest_generated, retest_questions }
//
// Auth: Supabase verifies the Authorization JWT automatically. Anonymous → 401.
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (auto-injected),
//          GEMINI_API_KEY (set via `supabase secrets set`).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.0';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response> | Response): void;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_API_KEY}`;
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
    throw new Error(`Gemini HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error('Gemini returned no content');
  return JSON.parse(text);
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

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !GEMINI_API_KEY) {
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

  const last = lastCallByUser.get(user.id) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) {
    return jsonResponse({ error: 'Cooldown active, please wait a moment' }, 429);
  }
  lastCallByUser.set(user.id, Date.now());

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
  const wrongForAi: Array<Question & { id: string; userAnswerText: string; correctAnswerText: string }> = [];
  const sectionTotals = new Map<string, { correct: number; total: number }>();

  for (const q of questions) {
    const id = questionId(q);
    const selectedIndex = answered.has(id) ? answered.get(id)! : -1;
    const isCorrect = selectedIndex === q.answerIndex;
    const bucket = sectionTotals.get(q.section) ?? { correct: 0, total: 0 };
    bucket.total += 1;
    if (isCorrect) bucket.correct += 1;
    sectionTotals.set(q.section, bucket);

    const userAnswerText = selectedIndex >= 0 && selectedIndex < q.options.length ? q.options[selectedIndex] : '(không trả lời)';
    const correctAnswerText = q.options[q.answerIndex] ?? '';

    if (!isCorrect) {
      wrongForAi.push({ ...q, id, userAnswerText, correctAnswerText });
    }
    detailedReview.push({
      question_id: id,
      user_answer: userAnswerText,
      correct_answer: correctAnswerText,
      is_correct: isCorrect,
      explanation: '',
      remediation_rule: '',
    });
  }

  const totalCorrect = questions.length - wrongForAi.length;
  const scorePercentage = questions.length > 0 ? Math.round((totalCorrect / questions.length) * 1000) / 10 : 0;

  let weaknessTags: string[] = [];
  let retestQuestions: unknown[] = [];

  if (wrongForAi.length > 0) {
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
        const aiItem = byQid.get(row.question_id as string) as Record<string, unknown> | undefined;
        if (aiItem) {
          row.explanation = aiItem.explanation ?? '';
          row.remediation_rule = aiItem.remediationRule ?? '';
        }
      }
      weaknessTags = Array.isArray(reviewResult.weaknessTags) ? reviewResult.weaknessTags.slice(0, 10) : [];
    } catch (err) {
      console.error('AI review generation failed:', err);
      // Grading itself already succeeded — degrade gracefully, no explanations this time.
    }

    try {
      const retestCount = Math.min(5, Math.max(3, wrongForAi.length));
      const retestPrompt = [
        `Điểm yếu cần luyện: ${weaknessTags.join(', ') || '(xem câu sai dưới đây)'}`,
        'Câu sai gốc để tham khảo phong cách/độ khó (không lặp lại nguyên câu):',
        JSON.stringify(wrongForAi.slice(0, 8).map((w) => ({ prompt: w.prompt, options: w.options }))),
      ].join('\n');
      const retestResult = await callGemini(
        `Bạn là người soạn đề JLPT ${level}. Soạn ${retestCount} câu hỏi trắc nghiệm MỚI (tiếng Nhật, 4 lựa chọn, đúng 1 đáp án) nhắm đúng vào các điểm yếu đã cho — không sao chép câu gốc. Mỗi câu có explanation ngắn bằng tiếng Việt giải thích đáp án đúng. Trả về JSON đúng schema.`,
        retestPrompt,
        RETEST_SCHEMA,
      );
      retestQuestions = Array.isArray(retestResult.questions) ? retestResult.questions : [];
    } catch (err) {
      console.error('Retest generation failed:', err);
    }
  }

  const attempt = {
    user_id: user.id,
    jlpt_level: level,
    source_file: sitting,
    score: {
      total: totalCorrect,
      max: questions.length,
      percentage: `${scorePercentage}%`,
      bySection: Object.fromEntries(
        Array.from(sectionTotals.entries()).map(([id, v]) => [id, { correct: v.correct, total: v.total }]),
      ),
    },
    weakness_tags: weaknessTags,
    detailed_review: detailedReview,
    retest_generated: retestQuestions.length > 0,
    retest_questions: retestQuestions.length > 0 ? retestQuestions : null,
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
    weakness_tags: weaknessTags,
    detailed_review: detailedReview,
    retest_generated: attempt.retest_generated,
    retest_questions: retestQuestions,
  });
});

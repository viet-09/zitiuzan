// supabase/functions/lesson-review-quiz/index.ts
// The "Ôn lại" set for one lesson: extra JLPT-N2-style practice written from
// that lesson's own material, on top of the questions printed in the book.
//
// POST /functions/v1/lesson-review-quiz
// Body: { lesson_id: "g1d1", content: {...}, existing_prompts: ["…"], refresh?: true }
// Response: { lessonId, questions: [{prompt, options, answerIndex, note}], cached }
//
// The result is stored in public.lesson_review_quiz, which is shared by every
// learner rather than cached per user. That is the whole point: the questions
// belong to the lesson, and the Gemini free tier is a couple of dozen calls a
// day — per-user caching would multiply one lesson into one call per learner.
// Clients cannot write that table; this function does, with the service role.
//
// Auth: Supabase verifies the Authorization JWT automatically. Anonymous → 401.
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//          (auto-injected), GEMINI_API_KEYS — see _shared/gemini-key-pool.ts.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.0';
import { hasGeminiKeys, withGeminiKeyFailover } from '../_shared/gemini-key-pool.ts';
import { MIN_QUESTIONS, sanitiseQuestions, targetQuestionCount } from '../_shared/lesson-review-rules.js';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response> | Response): void;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.5-flash';

const COOLDOWN_MS = 20_000;
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

function buildPrompt(content: string, existing: string[], want: number): string {
  return [
    'Bạn là người ra đề JLPT N2. Dựa HOÀN TOÀN vào nội dung bài học dưới đây,',
    `hãy viết ${want} câu luyện tập trắc nghiệm mới theo đúng văn phong và định dạng đề thi JLPT N2 chính thức.`,
    '',
    'Quy tắc bắt buộc:',
    '- Mỗi câu có 3 hoặc 4 lựa chọn, đúng một đáp án đúng.',
    '- Câu hỏi và lựa chọn viết bằng tiếng Nhật, đúng trình độ N2.',
    '- Chú thích furigana cho kanji theo cú pháp {漢字|かんじ}.',
    '- TUYỆT ĐỐI không lặp lại, không diễn đạt lại các câu đã có ở phần "Câu đã có".',
    '- Các phương án sai phải hợp lý (cùng loại từ, cùng cấu trúc), không đánh đố vô lý.',
    '- "note" là giải thích ngắn bằng tiếng Việt vì sao đáp án đúng (dưới 200 ký tự).',
    '',
    'Trả về JSON thuần theo schema, không kèm markdown.',
    '',
    '### Nội dung bài học',
    content.slice(0, 12000),
    '',
    '### Câu đã có (không được trùng)',
    existing.slice(0, 60).map((line, index) => `${index + 1}. ${line}`).join('\n') || '(chưa có)',
  ].join('\n');
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          answerIndex: { type: 'integer' },
          note: { type: 'string' },
        },
        required: ['prompt', 'options', 'answerIndex'],
      },
    },
  },
  required: ['questions'],
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'Server misconfigured: missing secrets' }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return jsonResponse({ error: 'Missing bearer token' }, 401);

  const scoped = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userErr } = await scoped.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: 'Invalid session' }, 401);

  let raw: { lesson_id?: unknown; content?: unknown; existing_prompts?: unknown; refresh?: unknown } = {};
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }

  const lessonId = typeof raw.lesson_id === 'string' ? raw.lesson_id.trim() : '';
  if (!/^[a-z0-9_-]{1,64}$/i.test(lessonId)) return jsonResponse({ error: 'Bad lesson id' }, 400);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Shared cache first: the overwhelming majority of requests end here, which
  // is what keeps this affordable on the free tier. `refresh` is the learner
  // asking for a different set, so it skips the read — but it still pays the
  // cooldown below, because it spends real quota on everyone's behalf.
  const refresh = raw.refresh === true;
  const { data: cached } = await service
    .from('lesson_review_quiz')
    .select('questions')
    .eq('lesson_id', lessonId)
    .maybeSingle();
  const previous = Array.isArray(cached?.questions) ? cached.questions : [];
  if (!refresh && previous.length) {
    return jsonResponse({ lessonId, questions: previous, cached: true });
  }

  if (!hasGeminiKeys()) return jsonResponse({ error: 'Server misconfigured: missing Gemini key' }, 500);

  // Only generation is rate limited; a cache hit above never gets this far.
  const last = lastCallByUser.get(user.id) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) {
    return jsonResponse({ error: 'Cooldown active', retryInSeconds: Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000) }, 429);
  }
  lastCallByUser.set(user.id, Date.now());

  const content = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content ?? '');
  if (content.trim().length < 40) return jsonResponse({ error: 'Lesson content is empty' }, 400);
  const fromBook = Array.isArray(raw.existing_prompts)
    ? raw.existing_prompts.filter((p): p is string => typeof p === 'string').map((p) => p.slice(0, 400))
    : [];
  // A refresh has to differ from the set being replaced as well, or "làm mới"
  // hands back the same questions in a new order.
  const previousPrompts = previous
    .map((question: unknown) => (question && typeof question === 'object' ? String((question as { prompt?: unknown }).prompt ?? '') : ''))
    .filter(Boolean);
  const existing = [...fromBook, ...previousPrompts];

  const want = targetQuestionCount(fromBook.length);
  const prompt = buildPrompt(content, existing, want);

  const attempt = await withGeminiKeyFailover<ReturnType<typeof sanitiseQuestions>>(async (key) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${key}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.7,
          },
        }),
      });
      if (!res.ok) {
        return { ok: false, status: res.status, errorText: (await res.text().catch(() => '')).slice(0, 200) };
      }
      const body = await res.json();
      const text = body?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      const questions = sanitiseQuestions(parsed?.questions, existing);
      // Fewer than the floor means the model mostly repeated the book; storing
      // that would freeze a bad set in the shared cache for everyone.
      if (questions.length < MIN_QUESTIONS) {
        return { ok: false, status: 502, errorText: `only ${questions.length} usable questions` };
      }
      return { ok: true, value: questions };
    } catch (err) {
      return { ok: false, status: 502, errorText: String(err).slice(0, 200) };
    }
  });

  if (!attempt.ok) {
    console.error('lesson-review-quiz generation failed:', attempt.status, attempt.errorText);
    return jsonResponse({ error: 'Chưa tạo được phần ôn lại, thử lại sau.' }, 502);
  }

  const { error: writeErr } = await service
    .from('lesson_review_quiz')
    .upsert({ lesson_id: lessonId, questions: attempt.value, model: GEMINI_MODEL });
  // A failed write only costs the next reader one more generation.
  if (writeErr) console.error('lesson-review-quiz cache write failed:', writeErr.message);

  return jsonResponse({ lessonId, questions: attempt.value, cached: false });
});

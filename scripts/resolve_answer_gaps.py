"""Resolves remaining answer-key gaps (answerIndex missing or out-of-range)
after scripts/fix-vocab-reading-boundary.mjs has already applied the
deterministic boundary/dedup fix. For each still-gapped question:

  1. Re-checks the sitting's answer-key image(s), asking Gemini to look
     specifically for that question's marked answer.
  2. If the image doesn't clearly show it (illegible, cropped, genuinely not
     covered — e.g. the exam side never captured this question's real text
     either), falls back to solving the question directly from its own
     Japanese prompt/options — skipped for audio-only listening stubs, which
     have no real prompt to solve from (image-only in that case).

Tags every resolved question with answerSource: "extracted" | "ai-solved" so
later review can tell source-verified answers apart from AI-derived ones.

Usage (v1, old archive):
  GEMINI_API_KEY=... python scripts/resolve_answer_gaps.py \
    --exam-dir "N2/N2-2019-07" --level N2 --sitting 2019-07

Usage (v2, Dungmori):
  GEMINI_API_KEY=... python scripts/resolve_answer_gaps.py \
    --exam-dir "..." --answer-pdf "..." --level N2 --sitting 2023-07
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from extract_exam import DEFAULT_MODEL, EXAM_DATA_DIR, INT, ROOT, STR, api_request, atomic_write_json, find_pdf, render_pages

BOOL = {"type": "BOOLEAN"}

RESOLVE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "foundInImage": BOOL,
        "answerIndex": INT,
        "reasoning": STR,
    },
    "required": ["foundInImage", "answerIndex", "reasoning"],
}

def resolve_task(section_id: str, part_label: str, question: dict[str, Any]) -> str:
    options_str = "\n".join(f"{i}: {opt}" for i, opt in enumerate(question["options"]))
    header = (
        f"Attached is the answer-key page image(s) for a JLPT N2 exam sitting. "
        f"Question: section {section_id}, {part_label}, number {question['number']}.\n"
    )
    # Listening questions that print nothing on the real exam paper carry the
    # real dialogue/monologue in referenceNote (from the transcript
    # enrichment pass), not prompt/options — prompt is often just a stub
    # label like "7番" and options are placeholder labels like "1番"/"2番".
    # Whichever text is actually usable, give the model everything we have.
    reference = question.get("referenceNote", "").strip()
    prompt_text = question.get("prompt", "").strip()
    text_context = ""
    if reference:
        text_context = f"Full transcript/context:\n{reference}\n"
    elif prompt_text:
        text_context = f"Japanese question text: {prompt_text}\n"

    if text_context:
        return (
            header
            + text_context
            + f"Options (0-based index):\n{options_str}\n\n"
            "Step 1: Carefully search the image(s) for this EXACT question number's marked answer "
            "(grids usually show 1-4, convert to 0-based). Double-check the number carefully — don't "
            "confuse it with a nearby item.\n"
            "Step 2: Only if you cannot clearly find this specific item in the image, ignore the image "
            "and instead solve the question yourself from the Japanese text/transcript and options above, "
            "using your own understanding of Japanese.\n"
            "Set foundInImage=true only if step 1 succeeded; false if you had to solve it yourself. "
            "Briefly justify your choice either way. Return JSON only."
        )
    return (
        header
        + f"Options (0-based index):\n{options_str}\n\n"
        "There is no usable Japanese question text available for this item (audio-only, no transcript "
        "on file) — you can ONLY find the answer in the attached answer-key image. Carefully search for "
        "this exact question number's marked answer (convert 1-4 to 0-based). If you genuinely cannot "
        "find it, set foundInImage=false and answerIndex=-1. Return JSON only."
    )


def gapped_questions(exam: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    out: list[tuple[str, str, dict[str, Any]]] = []
    for section in exam.get("sections", []):
        for part in section.get("parts", []):
            for q in part.get("questions", []):
                options = q.get("options", [])
                idx = q.get("answerIndex", -1)
                if not isinstance(idx, int) or idx < 0 or idx >= len(options):
                    out.append((section["id"], part["part"], q))
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exam-dir", required=True, type=Path)
    parser.add_argument("--answer-pdf", type=Path, help="v2 (Dungmori) only — combined answer-key PDF")
    parser.add_argument("--level", default="N2")
    parser.add_argument("--sitting", required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--dpi", type=int, default=150)
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("GEMINI_API_KEY is required")

    exam_dir = args.exam_dir if args.exam_dir.is_absolute() else ROOT / args.exam_dir
    out_path = EXAM_DATA_DIR / f"{args.level.lower()}-{args.sitting}.json"
    if not out_path.is_file():
        raise SystemExit(f"No existing extraction to resolve: {out_path}")
    exam = json.loads(out_path.read_text(encoding="utf-8"))

    gaps = gapped_questions(exam)
    if not gaps:
        print(f"DONE sitting={args.sitting} no gaps found")
        return 0

    if args.answer_pdf:
        answer_pdf = args.answer_pdf if args.answer_pdf.is_absolute() else ROOT / args.answer_pdf
        from extract_exam_v2 import find_answer_page_index, render_one_page
        page_index = find_answer_page_index(answer_pdf, args.sitting)
        answer_images = render_one_page(answer_pdf, page_index, args.dpi)
    else:
        answer_pdf = find_pdf(exam_dir, "答", "\0")
        answer_images = render_pages(answer_pdf, args.dpi)

    resolved = 0
    ai_solved = 0
    still_gapped = 0
    for section_id, part_label, q in gaps:
        task = resolve_task(section_id, part_label, q)
        try:
            result = api_request(api_key, args.model, task, RESOLVE_SCHEMA, answer_images, None, retries=4)
        except RuntimeError as err:
            print(f"WARN resolve failed for {section_id}:{part_label}:{q['number']}: {err}")
            still_gapped += 1
            continue

        idx = result.get("answerIndex", -1)
        if not isinstance(idx, int) or idx < 0 or idx >= len(q["options"]):
            print(f"WARN still unresolved {section_id}:{part_label}:{q['number']}: {result}")
            still_gapped += 1
            continue

        q["answerIndex"] = idx
        q["answerSource"] = "extracted" if result.get("foundInImage") else "ai-solved"
        resolved += 1
        if not result.get("foundInImage"):
            ai_solved += 1
        print(f"resolved {section_id}:{part_label}:{q['number']} -> {idx} ({q['answerSource']})")

    atomic_write_json(out_path, exam)
    print(f"DONE sitting={args.sitting} resolved={resolved} ai_solved={ai_solved} still_gapped={still_gapped}")
    return 1 if still_gapped else 0


if __name__ == "__main__":
    raise SystemExit(main())

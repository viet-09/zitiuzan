"""Extract a Dungmori-source JLPT exam sitting (2010-2025 coverage) into the
same structured exam JSON as extract_exam.py, but from three documents
instead of two:

  1. Main exam PDF          -> questions (prompt/options), no answers.
  2. "(script)" PDF          -> full listening transcripts (聴解スクリプト).
     Enriches every listening question's referenceNote with the real
     dialogue/monologue that was said — this is the key upgrade over the
     old N2/ archive, where audio-only sub-types (問題3/4, JLPT prints
     nothing for these on the real test paper either) had no context at
     all beyond a generic 1-4 stub.
  3. ONE page of the combined "ĐÁP ÁN JLPT N2" answer-key PDF (all 31
     sittings in one file, one page each) — looked up dynamically by
     matching the page's own printed header text via PyMuPDF, not a
     hardcoded page-index table, so it stays correct if Dungmori appends
     future sittings to the same file.

Reuses schemas/helpers from extract_exam.py (same output shape, same
checkpointing behavior) — see that file's docstring for the shared design.

Usage:
  GEMINI_API_KEY=... python scripts/extract_exam_v2.py \
    --exam-dir "C:/.../N2_ĐỀ CÁC NĂM/1. N2 7-2010" \
    --answer-pdf "C:/.../N2_ĐỀ CÁC NĂM/ĐÁP ÁN JLPT N2 (update 10.4.2026).pdf" \
    --level N2 --sitting 2010-07
"""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

import fitz

from extract_exam import (
    ANSWER_SCHEMA,
    DEFAULT_MODEL,
    EXAM_DATA_DIR,
    PARTS_SCHEMA,
    ROOT,
    SECTION_IDS,
    SECTIONS,
    STR,
    INT,
    atomic_write_json,
    exam_task_for,
    extract_with_verification,
    merge_answers,
    part_number,
    render_pages,
)

LISTENING_TRANSCRIPT_ITEM_SCHEMA = {
    "type": "OBJECT",
    "properties": {"part": STR, "number": INT, "transcript": STR},
    "required": ["part", "number", "transcript"],
}
LISTENING_TRANSCRIPT_SCHEMA = {
    "type": "OBJECT",
    "properties": {"items": {"type": "ARRAY", "items": LISTENING_TRANSCRIPT_ITEM_SCHEMA}},
    "required": ["items"],
}

SCRIPT_TASK = (
    "These scans are the 聴解スクリプト (listening script) booklet for a JLPT N2 exam, pages in "
    "ARBITRARY order — ignore page order entirely. For every listening question (番号) across every "
    "問題 group, extract the COMPLETE printed transcript — every speaker line, narration, and the "
    "question itself — verbatim into `transcript`. Format every `part` value exactly as \"問題N\" with "
    "NO space before the number (e.g. 問題1, 問題4) — this exact string is used as a merge key. "
    "Question numbers restart at 1 within each 問題 group. Copy Japanese text verbatim — never "
    "translate, paraphrase, or summarize. Return JSON only."
)

# Same intent as extract_exam.py's answer_task_for, but this source's answer
# key is one clean number grid per sitting with no printed explanations —
# no need to mention Chinese reference notes here.
def answer_task_for_v2(section_id: str, section_label: str) -> str:
    return (
        f"This scan is the answer-key grid for a JLPT N2 exam. Extract ONLY answer-key items for the "
        f"{section_label} ({section_id}) section — ignore every question belonging to any other section "
        f"({SECTION_IDS}). For every question number shown for this section, extract one item with the "
        "correct zero-based answerIndex (grid shows 1-4, subtract 1). Tag each item with its 問題 group "
        "(part) exactly as printed — format every `part` value exactly as \"問題N\" with no space before "
        "the number. This matters because listening question numbers restart at 1 per 問題 group, so "
        "(part, number) together must be unique. Leave referenceNote empty (this grid has no printed "
        "explanations). Return JSON only."
    )


def find_dungmori_pdfs(exam_dir: Path) -> tuple[Path, Path]:
    """Returns (main_exam_pdf, script_pdf)."""
    pdfs = [p for p in exam_dir.iterdir() if p.suffix.lower() == ".pdf"]
    script = [p for p in pdfs if "script" in p.name.lower()]
    main = [p for p in pdfs if "script" not in p.name.lower()]
    if len(script) != 1 or len(main) != 1:
        raise SystemExit(
            f"Expected exactly 1 main + 1 script PDF in {exam_dir}, found main={len(main)} script={len(script)}"
        )
    return main[0], script[0]


def find_answer_page_index(answer_pdf: Path, sitting: str) -> int:
    """Locate the 0-based page whose header reads e.g. "JLPT N2  7/2010" for
    sitting "2010-07". Dynamic lookup (not a hardcoded table) so this keeps
    working if Dungmori appends future sittings to the same combined file."""
    year, month = sitting.split("-")
    pattern = re.compile(rf"N2\s*{int(month)}\s*/\s*{year}\b")
    with fitz.open(answer_pdf) as doc:
        for i in range(doc.page_count):
            text = doc[i].get_text()
            if pattern.search(text):
                return i
    raise SystemExit(f"No answer page found for sitting {sitting} in {answer_pdf.name}")


def render_one_page(pdf_path: Path, page_index: int, dpi: int) -> list[str]:
    with fitz.open(pdf_path) as doc:
        pixmap = doc[page_index].get_pixmap(dpi=dpi, alpha=False)
        import base64
        return [base64.b64encode(pixmap.tobytes("jpeg", jpg_quality=90)).decode("ascii")]


def merge_listening_transcripts(exam: dict[str, Any], transcripts: dict[str, Any]) -> int:
    """Overwrite listening questions' referenceNote with the real transcript.
    Returns how many questions were enriched."""
    by_key: dict[tuple[int, int], str] = {}
    for item in transcripts.get("items", []):
        key = (part_number(item.get("part", "")), item.get("number", -1))
        by_key[key] = item.get("transcript", "")

    enriched = 0
    for section in exam.get("sections", []):
        if section.get("id") != "listening":
            continue
        for part in section.get("parts", []):
            key_part = part_number(part.get("part", ""))
            for question in part.get("questions", []):
                transcript = by_key.get((key_part, question.get("number", -1)))
                if transcript:
                    question["referenceNote"] = transcript
                    enriched += 1
    return enriched


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exam-dir", required=True, type=Path, help="Dungmori sitting folder (main+script PDFs)")
    parser.add_argument("--answer-pdf", required=True, type=Path, help="Combined 'ĐÁP ÁN JLPT N2' PDF")
    parser.add_argument("--level", default="N2")
    parser.add_argument("--sitting", required=True, help="e.g. 2010-07")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--one-pass", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("GEMINI_API_KEY is required")

    exam_dir = args.exam_dir if args.exam_dir.is_absolute() else ROOT / args.exam_dir
    answer_pdf = args.answer_pdf if args.answer_pdf.is_absolute() else ROOT / args.answer_pdf
    if not exam_dir.is_dir():
        raise SystemExit(f"Not a directory: {exam_dir}")
    if not answer_pdf.is_file():
        raise SystemExit(f"Not a file: {answer_pdf}")

    main_pdf, script_pdf = find_dungmori_pdfs(exam_dir)
    answer_page_index = find_answer_page_index(answer_pdf, args.sitting)
    print(f"Main={main_pdf.name} Script={script_pdf.name} AnswerPage={answer_page_index + 1}", flush=True)

    exam_images = render_pages(main_pdf, args.dpi)
    script_images = render_pages(script_pdf, args.dpi)
    answer_image = render_one_page(answer_pdf, answer_page_index, args.dpi)

    EXAM_DATA_DIR.mkdir(parents=True, exist_ok=True)
    draft_path = EXAM_DATA_DIR / f"{args.level.lower()}-{args.sitting}.draft.json"
    draft: dict[str, Any] = json.loads(draft_path.read_text(encoding="utf-8")) if draft_path.exists() else {}

    exam_sections: list[dict[str, Any]] = []
    answer_items: list[dict[str, Any]] = []

    for section_id, section_label in SECTIONS:
        exam_key = f"exam:{section_id}"
        if not args.force and exam_key in draft:
            print(f"[cached] exam section {section_id}", flush=True)
        else:
            print(f"Extracting exam section {section_id} ({args.model})…", flush=True)
            draft[exam_key] = extract_with_verification(
                api_key, args.model, exam_task_for(section_id, section_label), PARTS_SCHEMA, exam_images, args.one_pass,
            )
            atomic_write_json(draft_path, draft)
        exam_sections.append({"id": section_id, "nameJa": section_label, "parts": draft[exam_key].get("parts", [])})

        answer_key = f"answer:{section_id}"
        if not args.force and answer_key in draft:
            print(f"[cached] answer section {section_id}", flush=True)
        else:
            print(f"Extracting answer section {section_id} ({args.model})…", flush=True)
            draft[answer_key] = extract_with_verification(
                api_key, args.model, answer_task_for_v2(section_id, section_label), ANSWER_SCHEMA, answer_image, args.one_pass,
            )
            atomic_write_json(draft_path, draft)
        for item in draft[answer_key].get("items", []):
            answer_items.append({**item, "section": section_id})

    transcript_key = "listening-transcripts"
    if not args.force and transcript_key in draft:
        print("[cached] listening transcripts", flush=True)
    else:
        print(f"Extracting listening transcripts ({args.model})…", flush=True)
        draft[transcript_key] = extract_with_verification(
            api_key, args.model, SCRIPT_TASK, LISTENING_TRANSCRIPT_SCHEMA, script_images, args.one_pass,
        )
        atomic_write_json(draft_path, draft)

    exam = {"sections": exam_sections}
    merged, warnings = merge_answers(exam, {"items": answer_items})
    enriched = merge_listening_transcripts(merged, draft[transcript_key])

    problems = [w for w in warnings if not w.startswith("synthesized audio-only stub")]
    for warning in warnings:
        print(f"{'NOTE' if warning not in problems else 'WARN'} {warning}", flush=True)

    output = {
        "level": args.level,
        "sitting": args.sitting,
        "sourceDir": exam_dir.name,
        "sections": merged["sections"],
    }
    out_path = EXAM_DATA_DIR / f"{args.level.lower()}-{args.sitting}.json"
    atomic_write_json(out_path, output)

    total_questions = sum(len(part["questions"]) for section in merged["sections"] for part in section["parts"])
    print(f"DONE sitting={args.sitting} questions={total_questions} transcripts_enriched={enriched} problems={len(problems)} output={out_path}")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())

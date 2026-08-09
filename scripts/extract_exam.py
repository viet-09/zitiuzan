"""Extract a scanned JLPT past-exam sitting (owned source under N2/) into a
structured exam JSON usable by the app's mock-exam feature.

Two independent extractions, merged by (section, part, number):
  1. The "真题" (exam) booklet pages -> questions (prompt/options), no answers.
  2. The "答案" (answer) booklet pages -> answer key + raw reference notes
     (printed Chinese explanations used only to ground the AI review at
     grading time — never shown verbatim to the user).
Each extraction runs a second image-grounded verification pass, same pattern
as scripts/extract_book.py.

Usage:
  GEMINI_API_KEY=... python scripts/extract_exam.py --exam-dir "N2/N2-2019-12" --level N2 --sitting 2019-12
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import fitz


ROOT = Path(__file__).resolve().parents[1]
EXAM_DATA_DIR = ROOT / "data" / "exams"
DEFAULT_MODEL = "gemini-3.5-flash"

STR = {"type": "STRING"}
INT = {"type": "INTEGER"}

QUESTION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "number": INT,
        "passageId": STR,
        "prompt": STR,
        "options": {"type": "ARRAY", "items": STR},
    },
    "required": ["number", "passageId", "prompt", "options"],
}

PART_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "part": STR,
        "instructionJa": STR,
        "passages": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {"id": STR, "text": STR},
                "required": ["id", "text"],
            },
        },
        "questions": {"type": "ARRAY", "items": QUESTION_SCHEMA},
    },
    "required": ["part", "instructionJa", "passages", "questions"],
}

PARTS_SCHEMA = {
    "type": "OBJECT",
    "properties": {"parts": {"type": "ARRAY", "items": PART_SCHEMA}},
    "required": ["parts"],
}

# `section` is deliberately NOT a field Gemini fills in: earlier runs had it
# invent inconsistent section labels per call ("2019-12-n2-vocab-grammar" vs
# "文字・語彙・文法" vs "vocab_grammar"), which silently broke the merge with
# the exam extraction. Since each call already targets exactly one known
# section, the caller stamps `section` onto every item itself.
ANSWER_ITEM_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "part": STR,
        "number": INT,
        "answerIndex": INT,
        "referenceNote": STR,
    },
    "required": ["part", "number", "answerIndex", "referenceNote"],
}

ANSWER_SCHEMA = {
    "type": "OBJECT",
    "properties": {"items": {"type": "ARRAY", "items": ANSWER_ITEM_SCHEMA}},
    "required": ["items"],
}

SECTION_IDS = "vocab_grammar (文字・語彙・文法), reading (読解), listening (聴解)"

# A single call covering all sections reliably truncates the output (hits the
# model's max-output-tokens ceiling mid-object -> invalid JSON every retry,
# since it's a deterministic size limit, not a transient error). Splitting
# into one call per section keeps each response comfortably within budget.
SECTIONS: list[tuple[str, str]] = [
    ("vocab_grammar", "文字・語彙・文法"),
    ("reading", "読解"),
    ("listening", "聴解"),
]


def exam_task_for(section_id: str, section_label: str) -> str:
    return (
        "These scans are one JLPT exam booklet's pages, in ARBITRARY order (the physical PDF "
        "page order does not match the printed page numbers — ignore page order entirely). "
        f"Extract ONLY the {section_label} ({section_id}) section — ignore every question that "
        f"belongs to any other section ({SECTION_IDS}). Group its questions by 問題 group (part), "
        "in printed order. Format every `part` value exactly as \"問題N\" with NO space before the "
        "number (e.g. 問題1, 問題13) — this exact string is used as a merge key later. "
        + (
            "This section may share one or more passages per 問題 group — put the passage text "
            "once in `passages` with a short id, and set each question's `passageId` to match."
            if section_id == "reading"
            else "Leave `passages` empty and every question's `passageId` empty for this section."
        )
        + (
            " Transcribe the printed prompt/options exactly as shown even though there is no audio "
            "in these scans — question numbers restart at 1 within each 問題 group."
            if section_id == "listening"
            else ""
        )
        + " Copy Japanese text, punctuation, and numbers verbatim — never translate, paraphrase, or "
        "invent text. Never guess or invent an option that isn't legible. Return JSON only."
    )


def answer_task_for(section_id: str, section_label: str) -> str:
    return (
        "These scans are the answer-key booklet for the same JLPT exam, pages in ARBITRARY order. "
        f"Extract ONLY answer-key items for the {section_label} ({section_id}) section — ignore "
        f"every question belonging to any other section ({SECTION_IDS}). For every question number "
        "shown for this section, extract one item with the correct zero-based answerIndex (grid "
        "shows 1-4, subtract 1). Tag each item with its 問題 group (part) — format every `part` "
        "value exactly as \"問題N\" with NO space before the number (e.g. 問題1, 問題13), matching "
        "the group's position in the answer grid; this matters because listening question numbers "
        "restart at 1 per 問題 group, so (part, number) together must be unique. Separately, some "
        "pages contain detailed printed "
        "explanations (often in Chinese) for individual questions — when a question in this section "
        "has a nearby printed explanation, copy it verbatim (any language) into that item's "
        "referenceNote; leave referenceNote empty when none is printed for that question. Never "
        "invent or summarize an explanation that isn't printed. Return JSON only."
    )

VERIFY_PREFIX = (
    "Image-grounded verification pass. Compare every field of the draft JSON below against all "
    "attached scans and correct every OCR/transcription/schema error — missing questions, wrong "
    "option text, wrong answerIndex, truncated passages. Do not preserve a draft value when the "
    "scans show otherwise. Return the complete corrected object, same schema.\nDRAFT:\n"
)


def render_pages(pdf_path: Path, dpi: int) -> list[str]:
    images: list[str] = []
    with fitz.open(pdf_path) as document:
        for page in document:
            pixmap = page.get_pixmap(dpi=dpi, alpha=False)
            data = pixmap.tobytes("jpeg", jpg_quality=88)
            images.append(base64.b64encode(data).decode("ascii"))
    return images


def api_request(
    api_key: str,
    model: str,
    task: str,
    schema: dict[str, Any],
    images: list[str],
    draft: dict[str, Any] | None,
    retries: int = 6,
) -> dict[str, Any]:
    text = task if draft is None else VERIFY_PREFIX + json.dumps(draft, ensure_ascii=False) + "\n" + task
    parts: list[dict[str, Any]] = [{"text": text}]
    parts.extend({"inlineData": {"mimeType": "image/jpeg", "data": image}} for image in images)
    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": schema,
            "maxOutputTokens": 65536,
        },
    }
    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        + urllib.parse.quote(model, safe="")
        + ":generateContent?key="
        + urllib.parse.quote(api_key, safe="")
    )
    body = json.dumps(payload).encode("utf-8")

    for attempt in range(retries):
        raw_text = ""
        try:
            request = urllib.request.Request(
                endpoint, data=body, method="POST", headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(request, timeout=300) as response:
                result = json.load(response)
            parts_out = result["candidates"][0]["content"]["parts"]
            raw_text = "".join(part.get("text", "") for part in parts_out)
            raw_text = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw_text.strip())
            parsed = json.loads(raw_text)
            if not isinstance(parsed, dict):
                raise ValueError("Gemini response is not an object")
            return parsed
        except urllib.error.HTTPError as error:
            retryable = error.code in {408, 409, 429, 500, 502, 503, 504}
            if not retryable or attempt + 1 >= retries:
                detail = error.read().decode("utf-8", "replace")[:500]
                raise RuntimeError(f"Gemini HTTP {error.code}: {detail}") from error
        except json.JSONDecodeError as error:
            # A parse failure here almost always means the response was cut
            # off mid-object (max-output-tokens ceiling) — that reproduces
            # identically on retry, so surface enough of the tail to diagnose
            # rather than silently burning all retries on a deterministic failure.
            # raw_text is always set by this point (the decode happens right after it).
            print(f"  (parse failure at attempt {attempt + 1}, response length={len(raw_text)}, tail: …{raw_text[-300:]})", flush=True)
            if attempt + 1 >= retries:
                raise RuntimeError(f"Gemini response failed: {error}") from error
        except (urllib.error.URLError, TimeoutError, KeyError, ValueError) as error:
            if attempt + 1 >= retries:
                raise RuntimeError(f"Gemini response failed: {error}") from error
        time.sleep(min(60, 2 ** attempt + 1))
    raise RuntimeError("Gemini request exhausted retries")


def extract_with_verification(
    api_key: str, model: str, task: str, schema: dict[str, Any], images: list[str], one_pass: bool
) -> dict[str, Any]:
    draft = api_request(api_key, model, task, schema, images, None)
    if one_pass:
        return draft
    return api_request(api_key, model, task, schema, images, draft)


def part_number(label: str) -> int:
    """Normalize a printed "問題N" / "問題 N" label to just its integer, so
    whitespace differences between the two independent Gemini calls that
    produced the exam questions and the answer key can never break the merge."""
    match = re.search(r"(\d+)", str(label))
    return int(match.group(1)) if match else -1


def merge_answers(exam: dict[str, Any], answers: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Fill answerIndex/referenceNote onto exam questions. Returns (exam, warnings).
    Every answer item already carries the caller-assigned `section` (see main()),
    never a Gemini-invented one — only `part`/`number` need normalizing here.

    Some listening sub-types (JLPT 問題3/4 and part of 問題5) print NOTHING on
    the question paper at all — the real exam is "listen, then mark 1-4 on a
    separate answer sheet". Those answer-key entries have no OCR'd question to
    attach to; rather than dropping them, synthesize a question stub with
    generic 1-4 options (audioOnly: true) so the app can still present a
    gradable slot for them, matching how the real answer sheet works.
    """
    by_key: dict[tuple[str, int, int], dict[str, Any]] = {}
    for item in answers.get("items", []):
        key = (item.get("section", ""), part_number(item.get("part", "")), item.get("number", -1))
        by_key[key] = item

    warnings: list[str] = []
    seen: set[tuple[str, int, int]] = set()
    parts_by_section: dict[str, dict[int, dict[str, Any]]] = {}
    for section in exam.get("sections", []):
        section_id = section.get("id", "")
        parts_by_section[section_id] = {part_number(p.get("part", "")): p for p in section.get("parts", [])}
        for part in section.get("parts", []):
            key_part = part_number(part.get("part", ""))
            for question in part.get("questions", []):
                key = (section_id, key_part, question.get("number", -1))
                seen.add(key)
                answer = by_key.get(key)
                if answer is None:
                    warnings.append(f"no answer key for {section_id}:{part.get('part')}:{question.get('number')}")
                    question["answerIndex"] = -1
                    question["referenceNote"] = ""
                else:
                    question["answerIndex"] = answer.get("answerIndex", -1)
                    question["referenceNote"] = answer.get("referenceNote", "")

    for key, answer in by_key.items():
        if key in seen:
            continue
        section_id, key_part, number = key
        parts_map = parts_by_section.setdefault(section_id, {})
        part = parts_map.get(key_part)
        if part is None:
            part = {"part": f"問題{key_part}", "instructionJa": "", "passages": [], "questions": []}
            parts_map[key_part] = part
            section = next((s for s in exam["sections"] if s.get("id") == section_id), None)
            if section is None:
                warnings.append(f"answer key entry references unknown section: {key}")
                continue
            section["parts"].append(part)
        part["questions"].append({
            "number": number,
            "passageId": "",
            "prompt": "",
            "options": ["1", "2", "3", "4"],
            "answerIndex": answer.get("answerIndex", -1),
            "referenceNote": answer.get("referenceNote", ""),
            "audioOnly": True,
        })
        warnings.append(f"synthesized audio-only stub for {key}")

    for section in exam.get("sections", []):
        section["parts"].sort(key=lambda p: part_number(p.get("part", "")))
        for part in section["parts"]:
            part["questions"].sort(key=lambda q: q.get("number", 0))

    return exam, warnings


def find_pdf(exam_dir: Path, must_contain: str, must_not_contain: str) -> Path:
    candidates = [
        p for p in exam_dir.iterdir()
        if p.suffix.lower() == ".pdf" and must_contain in p.name and must_not_contain not in p.name
    ]
    if not candidates:
        raise SystemExit(f"No PDF matching '{must_contain}' (excluding '{must_not_contain}') in {exam_dir}")
    return candidates[0]


def atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exam-dir", required=True, type=Path, help="Folder under N2/ for one sitting")
    parser.add_argument("--level", default="N2")
    parser.add_argument("--sitting", required=True, help="Output id, e.g. 2019-12")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--one-pass", action="store_true", help="Skip the verification pass")
    parser.add_argument("--force", action="store_true", help="Re-extract sections already in the draft checkpoint")
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("GEMINI_API_KEY is required")

    exam_dir = args.exam_dir if args.exam_dir.is_absolute() else ROOT / args.exam_dir
    if not exam_dir.is_dir():
        raise SystemExit(f"Not a directory: {exam_dir}")

    exam_pdf = find_pdf(exam_dir, "", "答")
    answer_pdf = find_pdf(exam_dir, "答", "\0")

    print(f"Rendering exam pages from {exam_pdf.name}…", flush=True)
    exam_images = render_pages(exam_pdf, args.dpi)
    print(f"Rendering answer pages from {answer_pdf.name}…", flush=True)
    answer_images = render_pages(answer_pdf, args.dpi)

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
        # Always assign id/nameJa ourselves — never trust an echoed value, and
        # this also transparently migrates a draft cached under the old
        # SECTION_SCHEMA shape (which had its own, inconsistent id/nameJa).
        exam_sections.append({
            "id": section_id,
            "nameJa": section_label,
            "parts": draft[exam_key].get("parts", []),
        })

        answer_key = f"answer:{section_id}"
        if not args.force and answer_key in draft:
            print(f"[cached] answer section {section_id}", flush=True)
        else:
            print(f"Extracting answer section {section_id} ({args.model})…", flush=True)
            draft[answer_key] = extract_with_verification(
                api_key, args.model, answer_task_for(section_id, section_label), ANSWER_SCHEMA, answer_images, args.one_pass,
            )
            atomic_write_json(draft_path, draft)
        # Stamp the caller-known section onto every item — overwrites any
        # bogus value a draft cached under the old schema might carry.
        for item in draft[answer_key].get("items", []):
            answer_items.append({**item, "section": section_id})

    exam = {"sections": exam_sections}
    merged, warnings = merge_answers(exam, {"items": answer_items})
    # "synthesized audio-only stub" is expected (JLPT 問題3/4 print nothing) —
    # only other messages indicate a real extraction/merge problem.
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

    total_questions = sum(
        len(part["questions"]) for section in merged["sections"] for part in section["parts"]
    )
    print(f"DONE sitting={args.sitting} questions={total_questions} problems={len(problems)} output={out_path}")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())

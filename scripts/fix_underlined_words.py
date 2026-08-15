"""Recovers underline/word-order markers lost during the original exam
extraction (extract_exam.py / extract_exam_v2.py only ever asked Gemini to
transcribe verbatim text — underline formatting is not text, so it was
silently dropped by design, not omission).

Two independent, narrow fixes, each re-reading the ALREADY-RENDERED exam
page images (no new source needed beyond what extraction already used):

  1. 問題1 (漢字読み) — every sitting: the sentence tests the reading of ONE
     underlined word. Re-asks Gemini to locate each existing sentence in the
     scans and wrap the underlined word in 《...》 markers, changing nothing
     else. A sentence is only updated if the marker-stripped result matches
     the original prompt EXACTLY and exactly one marker pair is present —
     this is a defensive check against the model altering the sentence
     itself instead of just marking it.

  2. 問題8 (文の組み立て, word-order) — only the two sittings the audit found
     had lost their ★ blank-position marker entirely (2013-07, 2024-07):
     re-asks Gemini to reconstruct the four-blank-group layout with ★ in the
     correct blank, based on the same page images.

Usage:
  GEMINI_API_KEY=... python scripts/fix_underlined_words.py [--sitting 2019-12 ...] [--dry-run]
  (no --sitting filters -> processes all 31 sittings for fix 1; fix 2 always
  runs only for its two known-affected sittings)
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
N2_DIR = ROOT / "N2"
DUNGMORI_DIR = ROOT / "tmp" / "dungmori-source" / "N2_ĐỀ CÁC NĂM"
# gemini-3.5-flash's free-tier daily quota (20 req/day/project/model — yes,
# per DAY, not per minute, despite the misleading "retry in Ns" hint in 429
# responses) was fully exhausted by earlier work today. gemini-3.5-flash-lite
# is a separate model with its own quota bucket and was still available.
DEFAULT_MODEL = "gemini-3.5-flash-lite"

STR = {"type": "STRING"}
INT = {"type": "INTEGER"}
BOOL = {"type": "BOOLEAN"}

UNDERLINE_ITEM_SCHEMA = {
    "type": "OBJECT",
    "properties": {"number": INT, "found": BOOL, "prompt": STR},
    "required": ["number", "found", "prompt"],
}
UNDERLINE_SCHEMA = {
    "type": "OBJECT",
    "properties": {"items": {"type": "ARRAY", "items": UNDERLINE_ITEM_SCHEMA}},
    "required": ["items"],
}

WORD_ORDER_ITEM_SCHEMA = {
    "type": "OBJECT",
    "properties": {"number": INT, "found": BOOL, "prompt": STR},
    "required": ["number", "found", "prompt"],
}
WORD_ORDER_SCHEMA = {
    "type": "OBJECT",
    "properties": {"items": {"type": "ARRAY", "items": WORD_ORDER_ITEM_SCHEMA}},
    "required": ["items"],
}

# (level-sitting, part label) — the only two sittings the audit found had
# lost the ★ blank-position marker entirely in 問題8 (word-order).
WORD_ORDER_TARGETS = {"2013-07", "2024-07"}


def render_pages(pdf_path: Path, dpi: int = 150) -> list[str]:
    images: list[str] = []
    with fitz.open(pdf_path) as document:
        for page in document:
            pixmap = page.get_pixmap(dpi=dpi, alpha=False)
            data = pixmap.tobytes("jpeg", jpg_quality=88)
            images.append(base64.b64encode(data).decode("ascii"))
    return images


# Free-tier Gemini quota (20 req/min, generate_content_free_tier_requests)
# turned out to be shared across EVERYTHING using this key today (app
# testing, other batch scripts) — 4s spacing alone still 429'd. Paced much
# more conservatively here since there's no way to see the shared bucket's
# actual remaining headroom from this process alone.
MIN_SECONDS_BETWEEN_CALLS = 5.0
_last_call_at = 0.0


def _throttle() -> None:
    global _last_call_at
    wait = _last_call_at + MIN_SECONDS_BETWEEN_CALLS - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _last_call_at = time.monotonic()


def api_request(api_key: str, model: str, task: str, schema: dict[str, Any], images: list[str], retries: int = 6) -> dict[str, Any]:
    _throttle()
    parts: list[dict[str, Any]] = [{"text": task}]
    parts.extend({"inlineData": {"mimeType": "image/jpeg", "data": image}} for image in images)
    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": schema,
            "maxOutputTokens": 16384,
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
            request = urllib.request.Request(endpoint, data=body, method="POST", headers={"Content-Type": "application/json"})
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
            if attempt + 1 >= retries:
                raise RuntimeError(f"Gemini response failed: {error}") from error
        except (urllib.error.URLError, TimeoutError, KeyError, ValueError) as error:
            if attempt + 1 >= retries:
                raise RuntimeError(f"Gemini response failed: {error}") from error
        time.sleep(min(60, 2**attempt + 1))
    raise RuntimeError("Gemini request exhausted retries")


def find_main_pdf(source_dir: Path) -> Path:
    """The plain exam-questions PDF, excluding the answer-key / listening-script
    / audio siblings that live in the same sitting folder (N2/ uses "答" to mark
    the answer PDF; the Dungmori source uses "script" for the listening
    transcript and has a single shared answer-key PDF one level up, never inside
    a sitting folder)."""
    candidates = [
        p for p in source_dir.iterdir()
        if p.suffix.lower() == ".pdf" and "答" not in p.name and "script" not in p.name.lower()
    ]
    if not candidates:
        raise SystemExit(f"No main exam PDF found in {source_dir}")
    if len(candidates) > 1:
        raise SystemExit(f"Ambiguous main exam PDF in {source_dir}: {[p.name for p in candidates]}")
    return candidates[0]


def resolve_source_dir(source_dir_name: str) -> Path:
    old_candidate = N2_DIR / source_dir_name
    if old_candidate.is_dir():
        return old_candidate
    new_candidate = DUNGMORI_DIR / source_dir_name
    if new_candidate.is_dir():
        return new_candidate
    raise SystemExit(f"Could not locate source folder '{source_dir_name}' under N2/ or {DUNGMORI_DIR}")


def part_number(label: str) -> int:
    match = re.search(r"(\d+)", str(label))
    return int(match.group(1)) if match else -1


def find_part(exam: dict[str, Any], part_num: int) -> dict[str, Any] | None:
    for section in exam.get("sections", []):
        if section.get("id") != "vocab_grammar":
            continue
        for part in section.get("parts", []):
            if part_number(part.get("part", "")) == part_num:
                return part
    return None


def fix_underline(exam: dict[str, Any], images: list[str], api_key: str, model: str, dry_run: bool) -> tuple[int, list[str]]:
    part = find_part(exam, 1)
    if part is None or not part.get("questions"):
        return 0, ["no 問題1 part found"]

    numbered = "\n".join(f"{q['number']}. {q['prompt']}" for q in part["questions"])
    task = (
        "These are page scans of a JLPT N2 exam booklet, in arbitrary page order. "
        "問題1 (漢字読み) tests the reading of ONE underlined word inside each sentence below. "
        "For each numbered sentence, find it in the scans and identify exactly which word or short "
        "phrase is underlined in the printed image. Return the exact same sentence text, character "
        "for character, with ONLY that underlined word/phrase wrapped in 《 and 》 — add nothing else, "
        "remove nothing, change no other character (not even punctuation). If you can locate the "
        "sentence but there genuinely is no visible underline on it, set found=false and return the "
        "sentence completely unchanged with no markers. Sentences:\n" + numbered
    )
    result = api_request(api_key, model, task, UNDERLINE_SCHEMA, images)

    by_number = {q["number"]: q for q in part["questions"]}
    applied = 0
    notes: list[str] = []
    for item in result.get("items", []):
        number = item.get("number")
        question = by_number.get(number)
        if question is None:
            notes.append(f"問題1 #{number}: unknown question number in response, skipped")
            continue
        if not item.get("found"):
            notes.append(f"問題1 #{number}: no underline found by model, left unchanged")
            continue
        new_prompt = item.get("prompt", "")
        stripped = new_prompt.replace("《", "").replace("》", "")
        marker_count = new_prompt.count("《")
        if marker_count != 1 or new_prompt.count("》") != 1:
            notes.append(f"問題1 #{number}: expected exactly 1 marker pair, got {marker_count} — rejected")
            continue
        if stripped != question["prompt"]:
            notes.append(f"問題1 #{number}: marker-stripped text does not match original verbatim — rejected")
            continue
        if not dry_run:
            question["prompt"] = new_prompt
        applied += 1
    return applied, notes


def fix_word_order(exam: dict[str, Any], images: list[str], api_key: str, model: str, dry_run: bool) -> tuple[int, list[str]]:
    part = find_part(exam, 8)
    if part is None or not part.get("questions"):
        return 0, ["no 問題8 part found"]

    numbered = "\n".join(f"{q['number']}. {q['prompt']}" for q in part["questions"])
    task = (
        "These are page scans of a JLPT N2 exam booklet, in arbitrary page order. "
        "問題8 (文の組み立て) is a word-order question: each sentence has FOUR blanks in a row, and "
        "the printed image marks a ★ inside exactly ONE of those four blanks — the blank the student "
        "must identify. The sentences below currently show all four blanks merged into one long run "
        "with no ★ visible; this was lost during transcription. For each numbered sentence, find it in "
        "the scans, and reproduce the same sentence but split that merged blank run back into FOUR "
        "separate blank groups separated by single spaces (matching how the surrounding printed text "
        "reads), inserting a single ★ character inside whichever one of the four blank groups the "
        "image shows it in. Do not change any word outside the blank run. If you can locate the "
        "sentence but cannot determine the ★ position, set found=false and return it unchanged. "
        "Sentences:\n" + numbered
    )
    result = api_request(api_key, model, task, WORD_ORDER_SCHEMA, images)

    by_number = {q["number"]: q for q in part["questions"]}
    applied = 0
    notes: list[str] = []
    for item in result.get("items", []):
        number = item.get("number")
        question = by_number.get(number)
        if question is None:
            notes.append(f"問題8 #{number}: unknown question number in response, skipped")
            continue
        if not item.get("found"):
            notes.append(f"問題8 #{number}: star position not found by model, left unchanged")
            continue
        new_prompt = item.get("prompt", "")
        if "★" not in new_prompt:
            notes.append(f"問題8 #{number}: response has no ★, rejected")
            continue
        if not dry_run:
            question["prompt"] = new_prompt
        applied += 1
    return applied, notes


def atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sitting", action="append", help="Limit to one sitting (e.g. 2019-12); repeatable. Default: all.")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--dry-run", action="store_true", help="Report what would change without writing")
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("GEMINI_API_KEY is required")

    files = sorted(EXAM_DATA_DIR.glob("n2-*.json"))
    files = [f for f in files if not f.name.endswith(".draft.json") and not f.name.endswith(".tmp")]
    if args.sitting:
        wanted = set(args.sitting)
        files = [f for f in files if f.stem.replace("n2-", "") in wanted]

    total_underline = 0
    total_word_order = 0
    for path in files:
        sitting = path.stem.replace("n2-", "")
        exam = json.loads(path.read_text(encoding="utf-8"))
        source_dir = resolve_source_dir(exam["sourceDir"])
        main_pdf = find_main_pdf(source_dir)
        print(f"\n=== {sitting} ({main_pdf.relative_to(ROOT)}) ===", flush=True)
        images = render_pages(main_pdf)

        applied, notes = fix_underline(exam, images, api_key, args.model, args.dry_run)
        total_underline += applied
        print(f"問題1: {applied}/5 markers applied", flush=True)
        for note in notes:
            print(f"  - {note}", flush=True)

        if sitting in WORD_ORDER_TARGETS:
            applied8, notes8 = fix_word_order(exam, images, api_key, args.model, args.dry_run)
            total_word_order += applied8
            print(f"問題8: {applied8} ★ markers applied", flush=True)
            for note in notes8:
                print(f"  - {note}", flush=True)

        if not args.dry_run:
            atomic_write_json(path, exam)

    print(f"\nDONE. 問題1 markers applied: {total_underline}. 問題8 markers applied: {total_word_order}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

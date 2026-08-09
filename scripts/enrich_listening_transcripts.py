"""Upgrades an already-extracted old-archive sitting's audio-only listening
questions (問題3/4, and part of 問題5 — JLPT prints nothing for these on the
real test paper) from generic 1-4 stubs to real transcripts, sourced from
Dungmori's "(script)" PDF for the same sitting (see extract_exam_v2.py).

The old N2/ archive (2011-2019) predates the Dungmori-source batch and only
had a plain answer-key grid, no script booklet, so extract_exam.py synthesized
generic placeholder options for those audio-only sub-types. Dungmori's archive
turns out to cover 2011-2019 too, so this backfills real referenceNote content
(used only to ground the AI review at grading time, never shown verbatim to
the user — same as the rest of the app) into the EXISTING final JSON, without
re-running the full three-section extraction.

Usage:
  GEMINI_API_KEY=... python scripts/enrich_listening_transcripts.py \
    --script-pdf "C:/.../N2_ĐỀ CÁC NĂM/2. N2 12-2011/2. N2 12-2011(script).pdf" \
    --level N2 --sitting 2011-12
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from extract_exam import DEFAULT_MODEL, EXAM_DATA_DIR, ROOT, atomic_write_json, extract_with_verification, render_pages
from extract_exam_v2 import LISTENING_TRANSCRIPT_SCHEMA, SCRIPT_TASK, merge_listening_transcripts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--script-pdf", required=True, type=Path, help="Dungmori '(script)' PDF for this sitting")
    parser.add_argument("--level", default="N2")
    parser.add_argument("--sitting", required=True, help="e.g. 2011-12")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--one-pass", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("GEMINI_API_KEY is required")

    script_pdf = args.script_pdf if args.script_pdf.is_absolute() else ROOT / args.script_pdf
    if not script_pdf.is_file():
        raise SystemExit(f"Not a file: {script_pdf}")

    out_path = EXAM_DATA_DIR / f"{args.level.lower()}-{args.sitting}.json"
    if not out_path.is_file():
        raise SystemExit(f"No existing extraction to enrich: {out_path}")
    exam = json.loads(out_path.read_text(encoding="utf-8"))

    draft_path = EXAM_DATA_DIR / f"{args.level.lower()}-{args.sitting}.draft.json"
    draft = json.loads(draft_path.read_text(encoding="utf-8")) if draft_path.exists() else {}

    transcript_key = "listening-transcripts"
    if not args.force and transcript_key in draft:
        print(f"[cached] listening transcripts", flush=True)
    else:
        print(f"Rendering {script_pdf.name}…", flush=True)
        script_images = render_pages(script_pdf, args.dpi)
        print(f"Extracting listening transcripts ({args.model})…", flush=True)
        draft[transcript_key] = extract_with_verification(
            api_key, args.model, SCRIPT_TASK, LISTENING_TRANSCRIPT_SCHEMA, script_images, args.one_pass,
        )
        atomic_write_json(draft_path, draft)

    enriched = merge_listening_transcripts(exam, draft[transcript_key])
    atomic_write_json(out_path, exam)
    print(f"DONE sitting={args.sitting} transcripts_enriched={enriched} output={out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

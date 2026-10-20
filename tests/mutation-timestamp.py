#!/usr/bin/env python3
"""Mutation check for the timestamp fix.

Every mutation breaks one behaviour of the hour-aware stamp on purpose.
The named test must go RED. A test that stays green after the behaviour it
protects is broken is worthless, so this script is the proof that the new
tests really guard the fix.

Run it with: python3 tests/mutation-timestamp.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def replace(path, hunks):
    """Apply one mutation and prove it really changed the file."""
    target = ROOT / path
    original = target.read_text()
    text = original
    for old, new in hunks:
        count = text.count(old)
        if count != 1:
            raise SystemExit(
                f"mutation target not unique in {path}: found {count} matches for\n{old!r}"
            )
        text = text.replace(old, new)
    target.write_text(text)
    return text != original


def run_test(file, name):
    result = subprocess.run(
        [
            "node",
            "--test",
            "--test-name-pattern",
            name,
            f"tests/{file}",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return result.returncode != 0, result.stdout + result.stderr


MUTATIONS = [
    {
        "name": "M1 the stamp grows no hours part",
        "file": "settings.js",
        "hunks": [
            (
                """    if (minutes < 60) {
      return `${minutes}:${String(rest).padStart(2, "0")}`;
    }
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;""",
                """    return `${minutes}:${String(rest).padStart(2, "0")}`;""",
            )
        ],
        "expect": [
            (
                "timestamp-over-one-hour.test.js",
                "a stamp from an hour on grows an hours part",
            ),
            (
                "timestamp-over-one-hour.test.js",
                "the ninetieth minute no longer reads like the ninetieth second",
            ),
            (
                "timestamp-over-one-hour.test.js",
                "the panel shows a chapter of a long video in hours",
            ),
        ],
    },
    {
        "name": "M2 the length of a long video is read from the old markers only",
        "file": "background.js",
        "hunks": [
            (
                """  const stamps =
    String(transcriptText || "").match(/\\[\\d+:\\d{2}(?::\\d{2})?\\]/g) || [];""",
                """  const stamps =
    String(transcriptText || "").match(/\\[(\\d+):(\\d{2})\\]/g) || [];""",
            )
        ],
        "expect": [
            (
                "timestamp-over-one-hour.test.js",
                "the length of a long video is read from its transcript",
            ),
            (
                "timestamp-over-one-hour.test.js",
                "the prompt the model receives describes the video in hours",
            ),
        ],
    },
    {
        "name": "M3 the panel shows the stored string instead of the seconds",
        "file": "sidepanel.js",
        "hunks": [
            (
                """function displayTimestamp(item) {
  const seconds = Number(item?.timestampSeconds);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return YTD_SETTINGS.formatTimestamp(seconds);
  }
  return typeof item?.timestamp === "string" ? item.timestamp : "";
}""",
                """function displayTimestamp(item) {
  return typeof item?.timestamp === "string" ? item.timestamp : "";
}""",
            )
        ],
        "expect": [
            (
                "timestamp-over-one-hour.test.js",
                "the panel shows a chapter of a long video in hours",
            ),
            (
                "timestamp-over-one-hour.test.js",
                "the panel shows a note of a long video in hours",
            ),
        ],
    },
]


def main():
    failures = []
    for mutation in MUTATIONS:
        path = ROOT / mutation["file"]
        original = path.read_text()
        try:
            changed = replace(mutation["file"], mutation["hunks"])
            if not changed:
                raise SystemExit(f"mutation did not change the file: {mutation['name']}")
            for test_file, test_name in mutation["expect"]:
                failed, output = run_test(test_file, test_name)
                status = "RED" if failed else "GREEN"
                print(f"{status:5} {mutation['name']} -> {test_name}")
                if not failed:
                    failures.append((mutation["name"], test_name, output))
        finally:
            path.write_text(original)
        print(f"      restored {mutation['file']}")

    if failures:
        print("\nMUTATIONS THAT SURVIVED (the test did not catch them):")
        for name, test_name, output in failures:
            print(f"  - {name} -> {test_name}")
        return 1

    print("\nEvery mutation was caught by its test.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

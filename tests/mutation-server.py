#!/usr/bin/env python3
"""Mutation check for the server's promises about the user's own data.

Every mutation breaks one production behaviour on purpose. The named test
must go RED. A test that stays green after the behaviour it protects is
broken is worthless, so this script is the proof that the new tests really
guard the fixes.

The server had no mutation script of its own: every script in this folder
broke the extension, and the backend - where the user's notes live and
where the promises are made - was guarded by nothing but the tests passing.
These mutations close that gap.
"""

import signal
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_TEST = "server/tests/server.test.js"


def _stop_on_signal(signum, frame):
    """Restores the file before the process dies.

    A gate that is killed half way through must not leave the tree with a
    mutation in it: the next person to read the file would read the broken
    version and believe it. Raising SystemExit lets the finally block in
    main() put the file back.
    """
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, _stop_on_signal)
signal.signal(signal.SIGINT, _stop_on_signal)


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


def run_test(name):
    """Runs one named server test and says whether it went red.

    @param {str} name the name of the test.
    @returns {tuple[bool, str]} whether it failed, and what it said.
    """
    result = subprocess.run(
        [
            "node",
            "--test",
            "--test-name-pattern",
            name,
            SERVER_TEST,
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return result.returncode != 0, result.stdout + result.stderr


MUTATIONS = [
    {
        "name": "M1 the export refuses the biggest account the service allows",
        "file": "server/src/db.js",
        "hunks": [
            (
                """const MAX_EXPORT_BYTES = 32 * 1024 * 1024;""",
                """const MAX_EXPORT_BYTES = 8 * 1024 * 1024;""",
            )
        ],
        "expect": [
            "an account at the cap can be exported in one file",
        ],
    },
    {
        "name": "M2 the size of the export is measured from the text alone",
        "file": "server/src/db.js",
        "hunks": [
            (
                """      bytes += noteBytes(row) + NOTE_ROW_OVERHEAD_BYTES;""",
                """      bytes += noteBytes(row);""",
            )
        ],
        "expect": [
            "the size of the export is measured from the whole blob, not from the text",
        ],
    },
    {
        "name": "M3 the export holds half the account",
        "file": "server/src/db.js",
        "hunks": [
            (
                """const MAX_EXPORT_ROWS = MAX_ACCOUNT_ROWS;""",
                """const MAX_EXPORT_ROWS = 10_000;""",
            )
        ],
        "expect": [
            "the export gives back every row the account holds",
        ],
    },
    {
        "name": "M4 a deleted note is handed back",
        "file": "server/src/db.js",
        "hunks": [
            (
                """    // A note that was deleted stays deleted, and its text is never handed
    // back. The row is a tombstone, not a row: serving it would put the
    // user's own words back in front of them after they deleted them.
    if (!row || row.userId !== userId || row.deletedAt) return null;""",
                """    if (!row || row.userId !== userId) return null;""",
            )
        ],
        "expect": [
            "a deleted note is never handed back",
        ],
    },
    {
        "name": "M5 the list does not say how many notes the account holds",
        "file": "server/src/routes/notes.js",
        "hunks": [
            (
                """  const total = await ctx.store.countNotes(ctx.user.id);
  return json({
    notes: rows,
    total,
    truncated: rows.length < total,
    serverTime: serverTime(),
  });""",
                """  return json({ notes: rows, serverTime: serverTime() });""",
            )
        ],
        "expect": [
            "the list says how many notes the account holds",
        ],
    },
    {
        "name": "M6 deleting all notes does not reach the account",
        "file": "server/src/index.js",
        "hunks": [
            (
                """  { method: "DELETE", pattern: "/api/notes", handler: notes.deleteAllNotes },\n""",
                """""",
            )
        ],
        "expect": [
            "deleting all notes reaches the account",
        ],
    },
    {
        "name": "M8 a part of the export is measured as if it were the whole",
        "file": "server/src/db.js",
        "hunks": [
            (
                """    if (part === "notes") return bytes;""",
                """    if (false) return bytes;""",
            )
        ],
        "expect": [
            "the export can be asked for one part at a time",
        ],
    },
    {
        "name": "M7 the account limit does not carry the number the limit is",
        "file": "server/src/index.js",
        "hunks": [
            (
                """      if (error instanceof StorageLimitError && Number.isFinite(error.limit)) {
        body.limit = error.limit;
      }""",
                """      if (false) {
        body.limit = 0;
      }""",
            )
        ],
        "expect": [
            "the account limit carries the number the limit is",
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
            for test_name in mutation["expect"]:
                failed, output = run_test(test_name)
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

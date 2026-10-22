#!/usr/bin/env python3
"""Mutation check for the sync at scale.

The delta is what makes an account of twenty thousand notes usable: the
device asks for what changed instead of pulling the whole account every
time the panel opens. Every rule that makes the delta safe has a mutation
that breaks it on purpose, and a test that has to go RED.

A delta is dangerous in one specific way: it says less than the whole
account. A rule that reads "the row is not in the answer" as "the row is
gone" deletes the user's notes; a rule that trusts an answer the service
said was cut loses changes for good; a cursor that moves before the rows
are on the device hides everything that happened in between.

The mutations below break each of those rules one at a time. The script
passes only when every one of them is caught.
"""

import signal
import subprocess
import sys
from pathlib import Path

from mutation_harness import workspace

# The check works on a copy of the project. A mutation that an interrupted
# run leaves behind, and an edit made while the check runs, both stay out of
# the working tree.
ROOT = workspace()


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

DELTA_TEST = "sync-delta.test.js"


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
        "name": "M1 the device pulls the whole account every time",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """  const cursor = await readSyncCursor(session.githubId, scope);""",
                """  const cursor = "";""",
            )
        ],
        "expect": [
            (
                DELTA_TEST,
                "a device that knows how far it has seen the account asks for the delta",
            )
        ],
    },
    {
        "name": "M2 a delta that says it left rows out is trusted",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """    if (cut) {""",
                """    if (false) {""",
            )
        ],
        "expect": [
            (DELTA_TEST, "a delta that says it left rows out is not trusted"),
        ],
    },
    {
        "name": "M3 a delta that may have been cut is trusted",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """    if (longest >= SYNC_PAGE_ROWS) return null;""",
                """    if (false) return null;""",
            )
        ],
        "expect": [
            (DELTA_TEST, "a delta as long as a whole page is not trusted either"),
        ],
    },
    {
        "name": "M4 a row the delta does not mention is read as a deletion",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """    } else if (partial) {""",
                """    } else if (false) {""",
            )
        ],
        "expect": [
            (DELTA_TEST, "a row the delta does not mention stays on the device"),
        ],
    },
    {
        "name": "M5 the deletions the service reports are ignored",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """    if (deletedElsewhere.has(key)) {
      dropped.push(local);
      continue;
    }""",
                """    if (false) {
      dropped.push(local);
      continue;
    }""",
            )
        ],
        "expect": [
            (
                DELTA_TEST,
                "a row the service says was deleted elsewhere leaves the device",
            ),
        ],
    },
    {
        "name": "M6 the rows the merge drops stay on the device",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """      const gone = dropped.get(key);
      if (!gone) return true;""",
                """      const gone = dropped.get(key);
      if (true) return true;""",
            )
        ],
        "expect": [
            (
                DELTA_TEST,
                "a row the service says was deleted elsewhere leaves the device",
            ),
            (
                DELTA_TEST,
                "a note deleted on the dashboard leaves the device when the whole list is pulled",
            ),
        ],
    },
    {
        "name": "M7 an edit the service has not seen is not sent",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """        push: localNeedsPush ? localNeedsPush(local) === true : false,""",
                """        push: false,""",
            )
        ],
        "expect": [
            (
                DELTA_TEST,
                "an edit made on this device is sent even when the delta does not mention it",
            ),
        ],
    },
    {
        "name": "M8 an edit is not marked as waiting to be sent",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """      found.dirty = true;""",
                """      found.dirty = false;""",
            )
        ],
        "expect": [
            (
                DELTA_TEST,
                "an edit made on this device is marked as waiting to be sent",
            ),
        ],
    },
    {
        "name": "M9 the cursor moves past the rows the device never saw",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """      if (data && data.truncated !== true && typeof data.serverTime === "string") {""",
                """      if (data && typeof data.serverTime === "string") {""",
            )
        ],
        "expect": [
            (
                DELTA_TEST,
                "a list the service says it cut does not move the cursor",
            ),
        ],
    },
    {
        "name": "M10 a batch answer that drops rows is taken as a success",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """        batched = chunk.every((row) => reported.has(batchKeyOfItem(row)));""",
                """        batched = true;""",
            )
        ],
        "expect": [
            (DELTA_TEST, "a row the service did not take is sent again on its own"),
        ],
    },
    {
        "name": "M11 a service without the batch route gets nothing",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """        batched = false;
      }
    }
    if (batched) continue;""",
                """        batched = true;
      }
    }
    if (batched) continue;""",
            )
        ],
        "expect": [
            (
                DELTA_TEST,
                "a service without the batch route gets the rows one by one",
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

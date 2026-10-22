#!/usr/bin/env python3
"""Mutation check for the two guards that keep the user's account theirs.

Every mutation breaks one production behaviour on purpose. The named test
must go RED. A test that stays green after the behaviour it protects is
broken is worthless, so this script is the proof that the new tests really
guard the fixes.

Both mutations below were found by an audit that asked a fair question:
would the suite notice if this code was deleted? The answer was no, so the
code was unguarded. Now the answer is no again, for a different reason:
the code is guarded, and this script is what proves it.
"""

import signal
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


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

SAFETY_TEST = "account-safety.test.js"


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
        "name": "M1 a sign-in with a foreign nonce is accepted",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """  if (!expected || !received || expected !== received) return false;""",
                """  if (!expected || !received) return false;""",
            )
        ],
        "expect": [
            (
                SAFETY_TEST,
                "a sign-in that carries a nonce this device never issued is refused",
            )
        ],
    },
    {
        "name": "M2 two notes saved at the same time overwrite each other",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """function withNamespaceLock(namespace, action) {
  const previous = namespaceLocks.get(namespace) || Promise.resolve();
  const next = previous.then(action, action);""",
                """function withNamespaceLock(namespace, action) {
  const next = action();""",
            )
        ],
        "expect": [
            (SAFETY_TEST, "two notes saved at the same time do not lose one"),
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

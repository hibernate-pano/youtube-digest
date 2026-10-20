#!/usr/bin/env python3
"""Mutation check for the transcript failure cache.

Every mutation breaks one behaviour of the fix on purpose. The named test
must go RED. A test that stays green after the behaviour it protects is
broken is worthless, so this script is the proof that the new tests really
guard the fix.
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
        "name": "M1 the remembered failure is never read",
        "file": "background.js",
        "hunks": [
            (
                """  if (options?.force !== true) {
    const remembered = await readFailedTranscript(videoId);""",
                """  if (options?.force !== true) {
    const remembered = null;""",
            )
        ],
        "expect": [
            (
                "transcript-failure-cache.test.js",
                "a video without captions costs one credit, however often the panel looks at it",
            ),
            (
                "transcript-failure-cache.test.js",
                "the remembered failure still says what went wrong",
            ),
        ],
    },
    {
        "name": "M2 the failure is never written down",
        "file": "background.js",
        "hunks": [
            (
                """  const request = fetchTranscriptFromSupadata(videoId).then(async (result) => {
    if (!result?.success) await writeFailedTranscript(videoId, result);
    return result;
  });""",
                """  const request = fetchTranscriptFromSupadata(videoId).then(async (result) => {
    return result;
  });""",
            )
        ],
        "expect": [
            (
                "transcript-failure-cache.test.js",
                "a video without captions costs one credit, however often the panel looks at it",
            ),
            (
                "transcript-failure-cache.test.js",
                "a video whose transcript comes back empty is remembered as well",
            ),
        ],
    },
    {
        "name": "M3 the failure is remembered under the key the panel owns",
        "file": "background.js",
        "hunks": [
            (
                """function transcriptFailureCacheKey(videoId) {
  return `${TRANSCRIPT_FAILURE_CACHE_PREFIX}${videoId}`;
}""",
                """function transcriptFailureCacheKey(videoId) {
  return `digest_${videoId}`;
}""",
            )
        ],
        "expect": [
            (
                "transcript-failure-cache.test.js",
                "the remembered failure does not touch the cache the panel owns",
            ),
        ],
    },
    {
        "name": "M4 a rate limit is remembered like a missing subtitle",
        "file": "background.js",
        "hunks": [
            (
                """const TRANSCRIPT_CACHEABLE_FAILURES = new Set([
  "NO_TRANSCRIPT",
  "EMPTY_TRANSCRIPT",
]);""",
                """const TRANSCRIPT_CACHEABLE_FAILURES = new Set([
  "NO_TRANSCRIPT",
  "EMPTY_TRANSCRIPT",
  "RATE_LIMITED",
]);""",
            )
        ],
        "expect": [
            (
                "transcript-failure-cache.test.js",
                "a rate limit is not remembered, so the user can try again at once",
            ),
        ],
    },
    {
        "name": "M5 two callers pay for the same video twice",
        "file": "background.js",
        "hunks": [
            (
                """  const running = transcriptRequestsInFlight.get(videoId);
  if (running) {""",
                """  const running = null;
  if (running) {""",
            )
        ],
        "expect": [
            (
                "transcript-failure-cache.test.js",
                "the panel and the note flow at the same time cost one credit",
            ),
        ],
    },
    {
        "name": "M6 the worker ignores the user's request to try again",
        "file": "background.js",
        "hunks": [
            (
                """  if (options?.force !== true) {
    const remembered = await readFailedTranscript(videoId);""",
                """  if (true) {
    const remembered = await readFailedTranscript(videoId);""",
            )
        ],
        "expect": [
            (
                "transcript-failure-cache.test.js",
                "the user can ask for a caption-less video again",
            ),
            (
                "transcript-failure-cache.test.js",
                "the panel's retry reaches the worker as a fresh lookup",
            ),
        ],
    },
    {
        "name": "M7 the failure is remembered forever",
        "file": "background.js",
        "hunks": [
            (
                """    const timestamp = Number(failure.timestamp) || 0;
    if (Date.now() - timestamp > TRANSCRIPT_FAILURE_CACHE_TTL_MS) {
      await chrome.storage.local.remove(key);
      return null;
    }""",
                """    const timestamp = Number(failure.timestamp) || 0;""",
            )
        ],
        "expect": [
            (
                "transcript-failure-cache.test.js",
                "a remembered failure is forgotten after a day",
            ),
        ],
    },
    {
        "name": "M8 the remembered failures are never cleaned up",
        "file": "background.js",
        "hunks": [
            (
                """    await pruneFailedTranscripts();""",
                """    // the old entries are left where they are""",
            )
        ],
        "expect": [
            (
                "transcript-failure-cache.test.js",
                "the remembered failures do not stay in storage forever",
            ),
        ],
    },
    {
        "name": "M9 the remembered failure blocks the free path",
        "file": "background.js",
        "hunks": [
            (
                """async function handleFetchTranscriptLocalFirst(videoId, tabId, options = {}) {
  // Why the local read failed, when it did. The panel needs this to tell
  // "this video has no subtitles" apart from "the page was not ready yet":
  // the first is a fact about the video, the second is a moment that
  // passes, and they need different words and different actions.
  let localReason = null;

  if (tabId) {""",
                """async function handleFetchTranscriptLocalFirst(videoId, tabId, options = {}) {
  if (!options?.force) {
    const remembered = await readFailedTranscript(videoId);
    if (remembered) return remembered;
  }
  // Why the local read failed, when it did. The panel needs this to tell
  // "this video has no subtitles" apart from "the page was not ready yet":
  // the first is a fact about the video, the second is a moment that
  // passes, and they need different words and different actions.
  let localReason = null;

  if (tabId) {""",
            )
        ],
        "expect": [
            (
                "transcript-failure-cache.test.js",
                "a video whose captions show up later is read for free",
            ),
        ],
    },
    {
        "name": "M10 the panel's retry does not ask for a fresh lookup",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  await startDigest(currentVideoId, currentVideoUrl, { force: true });""",
                """  await startDigest(currentVideoId, currentVideoUrl);""",
            )
        ],
        "expect": [
            (
                "panel-feedback.test.js",
                "the retry button asks the worker to look the video up again",
            ),
        ],
    },
    {
        "name": "M11 the panel's try again button does not ask for a fresh lookup",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  await startDigest(currentVideoId, currentVideoUrl, { force: true });""",
                """  await startDigest(currentVideoId, currentVideoUrl);""",
            )
        ],
        "expect": [
            (
                "panel-feedback.test.js",
                "an empty transcript can be tried again as well",
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

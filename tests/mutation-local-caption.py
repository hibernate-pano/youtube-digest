#!/usr/bin/env python3
"""Mutation check for reading the subtitles out of the page.

Every mutation breaks one behaviour of the local caption path on purpose. The
named test must go RED. A test that stays green after the behaviour it
protects is broken is worthless, so this script is the proof that the new
tests really guard the fix.

The path this checks was found the hard way: the URL in the track list is a
template, and YouTube answers a template request with an empty body. The URL
the page's own player used is the one that carries the captions.
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
        "name": "M1 the page's caption request is never found",
        "file": "background.js",
        "hunks": [
            (
                """              usedUrl = url.toString();
              break;""",
                """              usedUrl = null;
              break;""",
            ),
            (
                """              return url.toString();""",
                """              return null;""",
            ),
        ],
        "expect": [
            (
                "local-transcript.test.js",
                "the caption URL the page already used is the one that is fetched",
            ),
        ],
    },
    {
        "name": "M2 the URL is not pointed at the track the product reads",
        "file": "background.js",
        "hunks": [
            (
                """    if (track.languageCode) parsed.searchParams.set("lang", track.languageCode);
""",
                "",
            )
        ],
        "expect": [
            (
                "local-transcript.test.js",
                "the page's URL is pointed at the track the product reads",
            ),
        ],
    },
    {
        "name": "M3 a translated variant is asked for by name",
        "file": "background.js",
        "hunks": [
            (
                """    parsed.searchParams.delete("variant");
""",
                "",
            )
        ],
        "expect": [
            (
                "local-transcript.test.js",
                "a translated variant is not asked for by name",
            ),
        ],
    },
    {
        "name": "M4 the page is never asked to load the track",
        "file": "background.js",
        "hunks": [
            (
                """  let usedUrl = captionTracks.usedUrl || null;
  if (!usedUrl) {""",
                """  let usedUrl = captionTracks.usedUrl || null;
  if (false) {""",
            )
        ],
        "expect": [
            (
                "local-transcript.test.js",
                "the page is asked to load the track when it has not used one yet",
            ),
        ],
    },
    {
        "name": "M5 a caption request for another video is used",
        "file": "background.js",
        "hunks": [
            (
                """              if (videoId && url.searchParams.get("v") !== videoId) continue;
              if (!url.searchParams.get("pot")) continue;
              usedUrl = url.toString();""",
                """              if (!url.searchParams.get("pot")) continue;
              usedUrl = url.toString();""",
            )
        ],
        "expect": [
            (
                "local-transcript.test.js",
                "a caption request for another video is not used",
            ),
        ],
    },
    {
        "name": "M6 a caption request without a token is used",
        "file": "background.js",
        "hunks": [
            (
                """              if (videoId && url.searchParams.get("v") !== videoId) continue;
              if (!url.searchParams.get("pot")) continue;
              usedUrl = url.toString();""",
                """              if (videoId && url.searchParams.get("v") !== videoId) continue;
              usedUrl = url.toString();""",
            )
        ],
        "expect": [
            (
                "local-transcript.test.js",
                "a caption request without a token is not used",
            ),
        ],
    },
    {
        "name": "M7 the template URL is never tried",
        "file": "background.js",
        "hunks": [
            (
                """  candidates.push(track.baseUrl);
""",
                "",
            )
        ],
        "expect": [
            (
                "local-transcript.test.js",
                "when the page's URL answers with nothing, the template URL is tried",
            ),
        ],
    },
    {
        "name": "M8 the local path is never tried",
        "file": "background.js",
        "hunks": [
            (
                """  if (tabId) {
    const local = await tryLocalTranscript(tabId, videoId);""",
                """  if (false) {
    const local = await tryLocalTranscript(tabId, videoId);""",
            )
        ],
        "expect": [
            (
                "local-transcript.test.js",
                "the subtitles are read out of the page without a Supadata credit",
            ),
        ],
    },
    {
        "name": "M9 the video the page is showing is not checked",
        "file": "background.js",
        "hunks": [
            (
                """  if (expectedVideoId && pageVideoId !== expectedVideoId) {""",
                """  if (false && expectedVideoId && pageVideoId !== expectedVideoId) {""",
            )
        ],
        "expect": [
            (
                "local-transcript.test.js",
                "the captions of a different video are not used",
            ),
        ],
    },
    {
        "name": "M10 the English track is not preferred",
        "file": "background.js",
        "hunks": [
            (
                """  const exact = tracks.find((track) => track.languageCode === "en");
  if (exact) return exact;
  const english = tracks.find((track) =>
    String(track.languageCode || "").startsWith("en"),
  );
  if (english) return english;""",
                """  const exact = null;
  if (exact) return exact;
  const english = null;
  if (english) return english;""",
            )
        ],
        "expect": [
            (
                "local-transcript.test.js",
                "the English track is preferred over the others",
            ),
        ],
    },
    {
        "name": "M11 the transcript read out of the page is thrown away",
        "file": "background.js",
        "hunks": [
            (
                """    if (local?.success) {
      debugLog("[YouTube Digest BG] Transcript read locally:", videoId);""",
                """    if (false) {
      debugLog("[YouTube Digest BG] Transcript read locally:", videoId);""",
            )
        ],
        "expect": [
            (
                "local-transcript.test.js",
                "the subtitles are read out of the page without a Supadata credit",
            ),
        ],
    },
    {
        "name": "M12 a page that does not say which video it is showing is trusted",
        "file": "background.js",
        "hunks": [
            (
                """  if (!pageVideoId) {
    debugLog(
      "[YouTube Digest BG] The page did not say which video it is showing",
    );""",
                """  if (false) {
    debugLog(
      "[YouTube Digest BG] The page did not say which video it is showing",
    );""",
            )
        ],
        "expect": [
            (
                "local-transcript.test.js",
                "a page that does not say which video it is showing is not trusted",
            ),
        ],
    },
    {
        "name": "M13 the panel stops when only the fallback key is missing",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  if (!configStatus?.hasSupadataKey && !configStatus?.hasAiKey) {
    showConfigError(configStatus);""",
                """  if (!configStatus?.hasSupadataKey) {
    showConfigError(configStatus);""",
            )
        ],
        "expect": [
            (
                "local-transcript.test.js",
                "the panel does not stop at a missing Supadata key",
            ),
        ],
    },
    {
        "name": "M14 the panel says nothing about the missing fallback key",
        "file": "sidepanel.js",
        "hunks": [
            (
                """    announceStatus(panelCopy("noFallbackKey"), { notice: true });""",
                """    // the notice is gone""",
            )
        ],
        "expect": [
            (
                "panel-feedback.test.js",
                "the panel works without a Supadata key and says so once",
            ),
        ],
    },
    {
        "name": "M15 the boot notice claims the video has no subtitles",
        "file": "sidepanel.js",
        "hunks": [
            (
                """    announceStatus(panelCopy("noFallbackKey"), { notice: true });""",
                """    announceStatus(panelCopy("noCaptionsNoKey"), { notice: true });""",
            )
        ],
        "expect": [
            (
                "panel-feedback.test.js",
                "the panel works without a Supadata key and says so once",
            ),
        ],
    },
    {
        "name": "M16 the dead end says only one of the two things",
        "file": "sidepanel.js",
        "hunks": [
            (
                """        panelCopy("noCaptionsNoKey"),""",
                """        panelCopy("addAiKey"),""",
            )
        ],
        "expect": [
            (
                "panel-feedback.test.js",
                "a video with no captions and no fallback key says both things",
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

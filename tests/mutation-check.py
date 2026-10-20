#!/usr/bin/env python3
"""Mutation check for the paid-work fixes.

Every mutation breaks one production behaviour on purpose. The named test
must go RED. A test that stays green after the behaviour it protects is
broken is worthless, so this script is the proof that the new tests really
guard the fixes.
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
        "name": "M1 the transcript is bought again for every run",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  const transcriptRequest = startPaidRequest(transcriptLedger, videoId, () =>
    chrome.runtime.sendMessage({
      action: "fetchTranscript",
      videoId: videoId,
      // The worker reads the captions out of the page itself when it can,
      // and only spends a credit when it cannot.
      tabId: youtubeTabId,
      // The worker remembers a video that has no captions, so that a second
      // look does not cost another credit. When the user asked for the video
      // to be looked at again, that memory has to be ignored.
      force: options?.force === true,
    }),
  );
  const transcriptResult = await transcriptRequest.promise;""",
                """  const transcriptResult = await chrome.runtime.sendMessage({
    action: "fetchTranscript",
    videoId: videoId,
    tabId: youtubeTabId,
    force: options?.force === true,
  });""",
            )
        ],
        "expect": [
            (
                "panel-ux.test.js",
                "opening the panel on a YouTube video buys one transcript, not two",
            ),
            (
                "panel-ux.test.js",
                "a second transcript lookup for the same video joins the one on the wire",
            ),
        ],
    },
    {
        "name": "M2 the video ticket changes on every digest run",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  // The ticket this run belongs to. It only changes when the video changes,
  // so a response that is still valid is never thrown away.
  const ticket = videoTicket;""",
                """  // The ticket this run belongs to. It only changes when the video changes,
  // so a response that is still valid is never thrown away.
  videoTicket += 1;
  const ticket = videoTicket;""",
            )
        ],
        "expect": [
            (
                "panel-ux.test.js",
                "a paid analysis survives the refresh a navigation starts",
            ),
            (
                "panel-ux.test.js",
                "a re-run for the same video does not invalidate the work in flight",
            ),
        ],
    },
    {
        "name": "M3 the analysis is paid for again on every request",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  const running = analysisLedger.get(videoId);
  if (running) {""",
                """  const running = null;
  if (running) {""",
            ),
            (
                """  const analysisRequest = startPaidRequest(analysisLedger, videoId, () =>""",
                """  const analysisRequest = startPaidRequest(new Map(), videoId, () =>""",
            ),
        ],
        "expect": [
            (
                "panel-ux.test.js",
                "a second analysis for the same video joins the one on the wire",
            ),
        ],
    },
    {
        "name": "M4 the previous video keeps its chapters and quotes",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  renderCachedViewNote();
  clearOverviewLists();
}""",
                """  renderCachedViewNote();
}""",
            )
        ],
        "expect": [
            (
                "panel-ux.test.js",
                "the previous video's chapters and quotes do not survive a video change",
            ),
        ],
    },
    {
        "name": "M5 the panel acts on the video the user already left",
        "file": "sidepanel.js",
        "hunks": [
            (
                """    if (frontVideoId !== videoId) {
      // The video changed under us. The navigation handler refreshes the
      // panel for the new video, so this run has nothing left to do.
      return;
    }""",
                """    if (false) {
      return;
    }""",
            )
        ],
        "expect": [
            (
                "panel-ux.test.js",
                "the panel does not fall back to the video the user already left",
            ),
        ],
    },
    {
        "name": "M6 the quote is not handed over",
        "file": "sidepanel.js",
        "hunks": [
            (
                """      channelName: currentChannelName,
      quote: quote.quote,
    });""",
                """      channelName: currentChannelName,
    });""",
            )
        ],
        "expect": [
            (
                "a11y-panel.test.js",
                "the Note button on a key quote hands the quote over",
            ),
        ],
    },
    {
        "name": "M7 the background throws the quote away",
        "file": "background.js",
        "hunks": [
            (
                """    const exactText = [selectedText, quoteText]""",
                """    const exactText = [selectedText]""",
            )
        ],
        "expect": [
            (
                "translation.test.js",
                "a key quote is stored as it is, without a lookup or an AI cleanup",
            ),
            (
                "translation.test.js",
                "the saveNote message carries the quote through to the note",
            ),
        ],
    },
    {
        "name": "M8 the stale translation is thrown away",
        "file": "sidepanel.js",
        "hunks": [
            (
                """    if (isStale) {
      // The translation was paid for, so it is kept for the video it belongs
      // to. The cache key holds the video id, so it can never be shown for
      // another one. Switching back to this language is then free.
      aligned.forEach((item, batchIndex) => {
        if (!item.text) return;
        transcriptParagraphCache.set(
          transcriptTranslationCacheKey(sourceBatch[batchIndex], videoId),
          item.text,
        );
      });
      void updateCache();
      return;
    }""",
                """    if (isStale) {
      return;
    }""",
            )
        ],
        "expect": [
            (
                "panel-ux.test.js",
                "a translation that arrives after the language changed is kept for its video",
            ),
        ],
    },
    {
        "name": "M9 the cost of the analysis is not stated",
        "file": "sidepanel.js",
        "hunks": [
            (
                """    generatingOverview: "Generating overview... uses your AI balance",""",
                """    generatingOverview: "Generating overview...",""",
            )
        ],
        "expect": [
            (
                "panel-ux.test.js",
                "the Overview tab says what the analysis costs when it starts",
            ),
        ],
    },
    {
        "name": "M10 the panel shows the worker's sentence again",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  if (copyKey) {
    const provider = String(result?.provider || activeProviderName || "").trim();""",
                """  const message = String(result?.message || "").trim();
  if (message) return message;

  if (copyKey) {
    const provider = String(result?.provider || activeProviderName || "").trim();""",
            )
        ],
        "expect": [
            (
                "panel-feedback.test.js",
                "a failed analysis is never shown in the worker's language",
            ),
        ],
    },
    {
        "name": "M11 the worker writes the sentence the user reads",
        "file": "background.js",
        "hunks": [
            (
                """      return {
        success: false,
        error: "NO_AI_KEY",
        provider: getActiveProvider(settings).name,
      };
    }
    const cleanSentence = String(sentence || "").trim().slice(0, 4000);""",
                """      return {
        success: false,
        error: "NO_AI_KEY",
        provider: getActiveProvider(settings).name,
        message: "AI key not configured. Open Settings.",
      };
    }
    const cleanSentence = String(sentence || "").trim().slice(0, 4000);""",
            )
        ],
        "expect": [
            (
                "background-vocabulary.test.js",
                "vocabulary extraction refuses to run without an AI key",
            ),
        ],
    },
    {
        "name": "M12 the provider is not named",
        "file": "background.js",
        "hunks": [
            (
                """      return {
        success: false,
        error: "NO_AI_KEY",
        provider: getActiveProvider(settings).name,
      };
    }
    const cleanSentence = String(sentence || "").trim().slice(0, 4000);""",
                """      return {
        success: false,
        error: "NO_AI_KEY",
        provider: "",
      };
    }
    const cleanSentence = String(sentence || "").trim().slice(0, 4000);""",
            )
        ],
        "expect": [
            (
                "background-vocabulary.test.js",
                "vocabulary extraction refuses to run without an AI key",
            ),
        ],
    },
    {
        "name": "M13 the panel forgets which provider the user picked",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  activeProviderName = String(configStatus?.provider || "").trim();""",
                """  activeProviderName = "";""",
            )
        ],
        "expect": [
            (
                "panel-feedback.test.js",
                "the panel names the provider even when the failure does not",
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

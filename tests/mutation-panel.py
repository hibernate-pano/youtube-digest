#!/usr/bin/env python3
"""Mutation check for the panel wave.

Every mutation breaks one behaviour of the panel on purpose. The named test
must go RED. A test that stays green after the behaviour it protects is
broken is worthless, so this script is the proof that the new tests really
guard the fixes.

The mutations here cover the five-tab panel, the summary gate, the
vocabulary tab, the notes tab and the library - the surfaces a user meets
in one sitting.
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
        "name": "M1 the summary tab buys the AI call without asking",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  if (tabName === "overview") {
    if (!currentAnalysis && !isAnalysisInFlight()) {
      // The summary costs the user money, so it is not bought by opening the
      // tab. The gate states the price and waits for the click.
      renderSummaryGate();""",
                """  if (tabName === "overview") {
    if (!currentAnalysis && !isAnalysisInFlight()) {
      void triggerAnalysis();""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "opening the summary tab does not spend anything",
            ),
        ],
    },
    {
        "name": "M2 the summary gate never goes away",
        "file": "sidepanel.js",
        "hunks": [
            (
                """function renderAnalysisResults(analysis) {
  // The summary is here, so the invitation to pay for it is not.
  hideSummaryGate();""",
                """function renderAnalysisResults(analysis) {""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "a generated summary replaces the gate with the summary itself",
            ),
        ],
    },
    {
        "name": "M3 the summary text is never rendered",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  if (summaryText) {
    summaryText.innerHTML = summary
      ? renderLocalizedContent(summary, "overview", "summary")
      : "";
  }""",
                """  if (summaryText) {
    summaryText.innerHTML = "";
  }""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "a generated summary replaces the gate with the summary itself",
            ),
        ],
    },
    {
        "name": "M4 the summary block shows even when there is no summary",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  if (summaryBlock) summaryBlock.hidden = !summary;""",
                """  if (summaryBlock) summaryBlock.hidden = false;""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "a summary that is missing does not leave an empty shell",
            ),
        ],
    },
    {
        "name": "M5 the vocabulary shows the raw database status",
        "file": "sidepanel.js",
        "hunks": [
            (
                """    const statusKey = WORD_STATUS_LABELS[item.status] || "wordStatusLearning";""",
                """    const statusKey = item.status;""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "the vocabulary list shows the word, its meaning and a readable status",
            ),
        ],
    },
    {
        "name": "M6 the review grades do not match the dashboard",
        "file": "sidepanel.html",
        "hunks": [
            (
                """data-grade="5\"""",
                """data-grade="4\"""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "the review card offers the four grades the dashboard uses",
            ),
        ],
    },
    {
        "name": "M7 the review sends the local id instead of the cloud id",
        "file": "sidepanel.js",
        "hunks": [
            (
                """      vocabId: review.vocabulary.id,""",
                """      vocabId: review.vocabulary.localId,""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "grading a review sends the grade with the cloud id",
            ),
        ],
    },
    {
        "name": "M8 the signed out user is shown an error instead of a way in",
        "file": "sidepanel.js",
        "hunks": [
            (
                """      if (signedOut) signedOut.hidden = !signedOutState;""",
                """      if (signedOut) signedOut.hidden = true;""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "a signed out user is told to sign in, not shown an error",
            ),
        ],
    },
    {
        "name": "M9 opening a cached video buys the transcript again",
        "file": "sidepanel.js",
        "hunks": [
            # The panel digests the video again instead of reading the copy it
            # already has.
            (
                """  currentVideoId = entry.videoId;
  currentVideoUrl = `https://www.youtube.com/watch?v=${entry.videoId}`;
  currentAnalysis = entry.analysis || null;""",
                """  void startDigest(entry.videoId, `https://www.youtube.com/watch?v=${entry.videoId}`);
  currentVideoId = entry.videoId;
  currentVideoUrl = `https://www.youtube.com/watch?v=${entry.videoId}`;
  currentAnalysis = entry.analysis || null;""",
            ),
            # The cache would hide the extra run, so the copy is gone too.
            # Without it the pipeline reaches the paid call and the user
            # pays for a video they already paid for.
            (
                """async function loadFromCache(videoId) {
  if (!videoId) return null;""",
                """async function loadFromCache(videoId) {
  if (!videoId) return null;
  if (videoId) return null;""",
            ),
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "opening a cached video costs nothing",
            ),
        ],
    },
    {
        "name": "M10 the library is sorted oldest first",
        "file": "sidepanel.js",
        "hunks": [
            (
                """      .sort((a, b) => b.timestamp - a.timestamp);""",
                """      .sort((a, b) => a.timestamp - b.timestamp);""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "the library lists the cached videos, newest first",
            ),
        ],
    },
    {
        "name": "M11 the note store drops notes without saying so",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """    await recordDroppedNotes(dropped);""",
                """    // the drop is not recorded""",
            )
        ],
        "expect": [
            (
                "note-retention.test.js",
                "the note store tells the user when it drops an old note",
            ),
        ],
    },
    {
        "name": "M12 the panel keeps its own copy of the note limit",
        "file": "sidepanel.js",
        "hunks": [
            (
                """const LOCAL_NOTE_LIMIT =
  typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.MAX_LOCAL_NOTES
    ? YTD_SETTINGS.MAX_LOCAL_NOTES
    : 100;""",
                """const LOCAL_NOTE_LIMIT = 100;""",
            )
        ],
        "expect": [
            (
                "note-retention.test.js",
                "the panel knows the note store's cap",
            ),
        ],
    },
    {
        "name": "M13 the panel never says that notes were dropped",
        "file": "sidepanel.js",
        "hunks": [
            (
                """    const count = Number(record?.lastCount) || 0;

    if (!count) {
      notice.hidden = true;
      notice.textContent = "";
      return;
    }
    notice.hidden = false;
    notice.textContent = panelCopyFormat("notesDropped", {""",
                """    const count = 0;

    if (!count) {
      notice.hidden = true;
      notice.textContent = "";
      return;
    }
    notice.hidden = false;
    notice.textContent = panelCopyFormat("notesDropped", {""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "the panel says when the store dropped old notes",
            ),
        ],
    },
    {
        "name": "M14 the panel invents a loss that never happened",
        "file": "sidepanel.js",
        "hunks": [
            (
                """    const count = Number(record?.lastCount) || 0;

    if (!count) {
      notice.hidden = true;
      notice.textContent = "";
      return;
    }
    notice.hidden = false;
    notice.textContent = panelCopyFormat("notesDropped", {""",
                """    let count = Number(record?.lastCount) || 0;

    if (!count) {
      count = 1;
    }
    notice.hidden = false;
    notice.textContent = panelCopyFormat("notesDropped", {""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "the panel says nothing when nothing was dropped",
            ),
        ],
    },
    {
        "name": "M15 the note counter shows a limit of its own",
        "file": "sidepanel.js",
        "hunks": [
            (
                """      limit: String(LOCAL_NOTE_LIMIT),
    });
  }
  if (warningEl) {""",
                """      limit: "999",
    });
  }
  if (warningEl) {""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "the note counter shows the limit that really applies",
            ),
        ],
    },
    {
        "name": "M16 the quick note is saved without the moment it was written at",
        "file": "sidepanel.js",
        "hunks": [
            (
                """      timestamp: seconds === null ? 0 : seconds,
      videoTitle: currentVideoTitle,""",
                """      timestamp: 0,
      videoTitle: currentVideoTitle,""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "a note can be written in the panel and is saved with the current time",
            ),
        ],
    },
    {
        "name": "M17 a note cannot be starred",
        "file": "sidepanel.js",
        "hunks": [
            (
                """      action: "setNoteStarred",""",
                """      action: "getNotes",""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "a note can be starred",
            ),
        ],
    },
    {
        "name": "M18 the confirmed words are thrown away instead of saved",
        "file": "sidepanel.js",
        "hunks": [
            (
                """          action: "saveVocabulary",""",
                """          action: "getVocabulary",""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "saving the confirmed words stores every one of them",
            ),
        ],
    },
    {
        "name": "M19 the word confirmation does not say what it costs",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  cost.textContent = panelCopy("extractWordCost");""",
                """  cost.textContent = "";""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "the word confirmation shows the words and the price before saving",
            ),
        ],
    },
    {
        "name": "M20 the retention sentence keeps its placeholders",
        "file": "sidepanel.js",
        "hunks": [
            (
                """    const value = /\\{\\w+\\}/.test(panelCopy(key))
      ? panelCopyFormat(key, copyPlaceholders())
      : panelCopy(key);""",
                """    const value = panelCopy(key);""",
            )
        ],
        "expect": [
            (
                "panel-tabs.test.js",
                "the library says how long it keeps things",
            ),
        ],
    },
    {
        "name": "M21 the playback poll searches every tab again",
        "file": "sidepanel.js",
        "hunks": [
            (
                """    if (youtubeTabId) {
      try {
        // The content script answers with the time itself, so a direct
        // answer needs no unwrapping.
        const direct = await chrome.tabs.sendMessage(youtubeTabId, {
          action: "getCurrentTime",
        });
        const directTime = Number(direct?.currentTime);
        if (Number.isFinite(directTime)) {
          highlightActiveEntry(directTime);
          return;
        }
      } catch (directErr) {
        debugLog(
          "[YouTube Digest Panel] Direct getCurrentTime failed, falling back to relay:",
          directErr.message,
        );
      }
    }

""",
                "",
            )
        ],
        "expect": [
            (
                "panel-playback.test.js",
                "the playback poll asks the YouTube tab directly instead of searching every tab",
            ),
            (
                "panel-playback.test.js",
                "the playback poll falls back to the relay when the YouTube tab is gone",
            ),
        ],
    },
    {
        "name": "M22 the playback poll gives up when the tab is gone",
        "file": "sidepanel.js",
        "hunks": [
            (
                """      } catch (directErr) {
        debugLog(
          "[YouTube Digest Panel] Direct getCurrentTime failed, falling back to relay:",
          directErr.message,
        );
      }""",
                """      } catch (directErr) {
        debugLog(
          "[YouTube Digest Panel] Direct getCurrentTime failed, falling back to relay:",
          directErr.message,
        );
        return;
      }""",
            )
        ],
        "expect": [
            (
                "panel-playback.test.js",
                "the playback poll falls back to the relay when the YouTube tab is gone",
            ),
            (
                "panel-playback.test.js",
                "the playback poll keeps running when the tab and the relay both fail",
            ),
        ],
    },
    {
        "name": "M23 the playback poll reads the direct answer as a relay envelope",
        "file": "sidepanel.js",
        "hunks": [
            (
                """        const directTime = Number(direct?.currentTime);""",
                """        const directTime = Number(direct?.response?.currentTime);""",
            )
        ],
        "expect": [
            (
                "panel-playback.test.js",
                "the playback poll asks the YouTube tab directly instead of searching every tab",
            ),
        ],
    },
    {
        "name": "M24 the playback poll reads the relay answer as a direct answer",
        "file": "sidepanel.js",
        "hunks": [
            (
                """    const currentTime = result.response.currentTime || 0;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away""",
                """    const currentTime = result.currentTime || 0;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away""",
            )
        ],
        "expect": [
            (
                "panel-playback.test.js",
                "the playback poll falls back to the relay when the YouTube tab is gone",
            ),
            (
                "panel-playback.test.js",
                "the playback poll keeps running when the tab and the relay both fail",
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

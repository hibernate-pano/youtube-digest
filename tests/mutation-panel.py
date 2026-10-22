#!/usr/bin/env python3
"""Mutation check for the panel wave.

Every mutation breaks one behaviour of the panel on purpose. The named test
must go RED. A test that stays green after the behaviour it protects is
broken is worthless, so this script is the proof that the new tests really
guard the fixes.

The mutations here cover the five-tab panel, the summary gate, the
vocabulary tab, the notes tab and the library - the surfaces a user meets
in one sitting. The last eight cover the scale of the panel: the drawn
window, the search that waits for the typing, the caret that reads one row
at a time, the cache that is kept under a byte budget, the count that is
read from the index, and the sign-out that asks before it takes the last
copy of the user's notes away.
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
    return text


def restore(path, original, mutated):
    """Puts the file back, unless somebody else changed it in the meantime.

    The mutation is a broken version of a file other people are working on
    at the same time. If the file is still the broken version, it is put
    back the way it was. If it is not, somebody else has written to it
    while the mutation was running, and putting the old text back would
    throw their work away. The file is left as it is and the clash is
    said out loud.
    """
    target = ROOT / path
    current = target.read_text()
    if current == mutated:
        target.write_text(original)
        return True
    print(f"      WARNING {path} was written to while the mutation ran; left alone")
    return False


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
                """  const statusKey = WORD_STATUS_LABELS[item.status] || "wordStatusLearning";""",
                """  const statusKey = item.status;""",
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
    // Two drops, two different facts. A note that fell off when the user
    // saved is a note this device let go of. A note that fell off when the
    // account synced is a note the account still has, and the user has to
    // hear that, or they will go looking for a note that is not lost.
    const fromSync = record?.lastReason === "sync";
    notice.textContent = panelCopyFormat(
      fromSync ? "notesKeptInAccount" : "notesDropped",""",
                """    const count = 0;

    if (!count) {
      notice.hidden = true;
      notice.textContent = "";
      return;
    }
    notice.hidden = false;
    // Two drops, two different facts. A note that fell off when the user
    // saved is a note this device let go of. A note that fell off when the
    // account synced is a note the account still has, and the user has to
    // hear that, or they will go looking for a note that is not lost.
    const fromSync = record?.lastReason === "sync";
    notice.textContent = panelCopyFormat(
      fromSync ? "notesKeptInAccount" : "notesDropped",""",
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
    // Two drops, two different facts. A note that fell off when the user
    // saved is a note this device let go of. A note that fell off when the
    // account synced is a note the account still has, and the user has to
    // hear that, or they will go looking for a note that is not lost.
    const fromSync = record?.lastReason === "sync";
    notice.textContent = panelCopyFormat(
      fromSync ? "notesKeptInAccount" : "notesDropped",""",
                """    const count = Number(record?.lastCount) || 0;

    if (!count) {
      notice.hidden = false;
      notice.textContent = panelCopyFormat("notesDropped", {
        count: "1",
        limit: String(LOCAL_NOTE_LIMIT),
      });
      return;
    }
    notice.hidden = false;
    // Two drops, two different facts. A note that fell off when the user
    // saved is a note this device let go of. A note that fell off when the
    // account synced is a note the account still has, and the user has to
    // hear that, or they will go looking for a note that is not lost.
    const fromSync = record?.lastReason === "sync";
    notice.textContent = panelCopyFormat(
      fromSync ? "notesKeptInAccount" : "notesDropped",""",
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
        "name": "M14b the panel says a note was dropped when the account still has it",
        "file": "sidepanel.js",
        "hunks": [
            (
                """    const fromSync = record?.lastReason === "sync";
    notice.textContent = panelCopyFormat(
      fromSync ? "notesKeptInAccount" : "notesDropped",""",
                """    const fromSync = false;
    notice.textContent = panelCopyFormat(
      fromSync ? "notesKeptInAccount" : "notesDropped",""",
            )
        ],
        "expect": [
            (
                "sync-local-cap.test.js",
                "the panel says the notes are still in the account when the account is bigger than the device",
            ),
        ],
    },
    {
        "name": "M14c the panel says a word was dropped when the account still has it",
        "file": "sidepanel.js",
        "hunks": [
            (
                """    const fromSync = record?.lastReason === "sync";
    notice.textContent = panelCopyFormat(
      fromSync ? "wordsKeptInAccount" : "wordsDropped",""",
                """    const fromSync = false;
    notice.textContent = panelCopyFormat(
      fromSync ? "wordsKeptInAccount" : "wordsDropped",""",
            )
        ],
        "expect": [
            (
                "sync-local-cap.test.js",
                "the panel says the words are still in the account when the account is bigger than the device",
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
    {
        "name": "M25 the panel gives up on a paid translation after one try",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  for (let attempt = 0; attempt <= TRANSLATION_MAX_AUTO_RETRIES; attempt += 1) {""",
                """  for (let attempt = 0; attempt < 1; attempt += 1) {""",
            )
        ],
        "expect": [
            (
                "translation-retry.test.js",
                "a transcript batch that hit a rate limit is translated on the next try",
            ),
            (
                "translation-retry.test.js",
                "an interface segment that hit a rate limit is translated on the next try",
            ),
        ],
    },
    {
        "name": "M26 a missing key is treated as worth another try",
        "file": "sidepanel.js",
        "hunks": [
            (
                """  if (code && TRANSLATION_NON_RETRYABLE_ERROR_CODES.has(code)) return false;""",
                """  if (code && TRANSLATION_NON_RETRYABLE_ERROR_CODES.has(code)) return true;""",
            ),
            (
                """  if (TRANSLATION_KEY_PROBLEM_PATTERN.test(error)) return false;""",
                """  if (TRANSLATION_KEY_PROBLEM_PATTERN.test(error)) return true;""",
            ),
        ],
        "expect": [
            (
                "translation-retry.test.js",
                "a transcript batch with no API key is not asked again",
            ),
            (
                "translation-retry.test.js",
                "an interface segment with no API key is not asked again",
            ),
            (
                "translation-retry.test.js",
                "a failure that a new attempt cannot fix is not worth the user's balance",
            ),
        ],
    },
    {
        "name": "M27 an interface segment goes on the deny list before the retries are used up",
        "file": "sidepanel.js",
        "hunks": [
            (
                """      const batch = missing.slice(start, start + TRANSLATION_BATCH_SIZE);
      let result;""",
                """      const batch = missing.slice(start, start + TRANSLATION_BATCH_SIZE);
      batch.forEach((segment) => interfaceTranslationFailures.add(segment.cacheKey));
      let result;""",
            )
        ],
        "expect": [
            (
                "translation-retry.test.js",
                "an interface segment that keeps failing goes on the deny list only after the attempts are used up",
            ),
            (
                "translation-retry.test.js",
                "an interface segment that hit a rate limit is translated on the next try",
            ),
        ],
    },
    {
        "name": "M28 the gate cannot fail",
        "file": "sidepanel.js",
        "hunks": [
            # The gate asks the user when the work goes past the number they
            # agreed to. Without the question the panel spends the user's
            # balance on a summary that landed after the price was stated.
            (
                """  const missing = budget.spent + wanted - budget.confirmed;
  const agreed = await confirmTranslationCost(missing);
  if (!agreed) {
    translationBudgetLedger.set(key, budget);
    return false;
  }
  budget.confirmed = budget.spent + wanted;""",
                """  budget.confirmed = budget.spent + wanted;""",
            )
        ],
        "expect": [
            (
                "panel-feedback.test.js",
                "a summary that lands after the price was agreed to asks again",
            ),
        ],
    },
    {
        "name": "M29 the vocabulary path swallows the missing key",
        "file": "sidepanel.js",
        "hunks": [
            # The worker answers NO_AI_KEY when there is no key. Without
            # this branch the panel says the extraction failed, and the user
            # goes looking for a broken sentence instead of a missing key.
            (
                """        if (isMissingAiKey(result)) {
          showAiKeyNeededDialog(panelFailureMessage(result), button);
          tooltip.style.display = "none";
          return;
        }
""",
                "",
            )
        ],
        "expect": [
            (
                "panel-feedback.test.js",
                "a word extraction without a provider key says the key is missing",
            ),
        ],
    },
    {
        "name": "M30 the transcript is drawn in full again",
        "file": "sidepanel.js",
        "hunks": [
            # The transcript is drawn a window at a time, so the page a reader
            # waits for does not grow with the length of the talk. Drawing
            # every row is what a three hour talk used to cost.
            (
                """function windowedListRange(state) {
  const band = windowedListVisibleBand(state);
""",
                """function windowedListRange(state) {
  if (state.listId === "transcriptList") {
    return { start: 0, end: state.rows.length };
  }
  const band = windowedListVisibleBand(state);
""",
            )
        ],
        "expect": [
            (
                "panel-scale.test.js",
                "a transcript of three thousand rows does not build a page of three thousand rows",
            ),
        ],
    },
    {
        "name": "M31 the search runs on every key press",
        "file": "sidepanel.js",
        "hunks": [
            # The search waits for the typing to settle. Searching on every
            # key press means searching a transcript of three thousand rows
            # again for the letter the reader has just typed over.
            (
                """function scheduleTranscriptSearch() {
  cancelTranscriptSearch();
  transcriptSearchTimer = setTimeout(() => {
    transcriptSearchTimer = null;
    refreshTranscriptSearch();
  }, TRANSCRIPT_SEARCH_DELAY_MS);
}
""",
                """function scheduleTranscriptSearch() {
  cancelTranscriptSearch();
  refreshTranscriptSearch();
}
""",
            )
        ],
        "expect": [
            (
                "panel-scale.test.js",
                "the transcript is searched once the typing has settled",
            ),
        ],
    },
    {
        "name": "M32 the same word is searched again",
        "file": "sidepanel.js",
        "hunks": [
            # The answer to the last search is kept. The transcript is drawn
            # again whenever the language changes, and the words have not
            # changed with the drawing.
            (
                """    transcriptSearchQuery = query;
    transcriptSearchScanned = true;
""",
                """    transcriptSearchQuery = query;
    transcriptSearchScanned = false;
""",
            )
        ],
        "expect": [
            (
                "panel-scale.test.js",
                "the same word is not looked for twice",
            ),
        ],
    },
    {
        "name": "M33 the row list is built again on every key press",
        "file": "sidepanel.js",
        "hunks": [
            # The caret walks one row at a time, and the list of rows is
            # built once per drawing. Building it again for every key press
            # is the walk over three thousand rows that the caret used to
            # do.
            (
                """function collectTranscriptRows() {
  if (
    transcriptRowsCache &&
    transcriptRowsCacheVersion === transcriptWindow.version
  ) {
    return transcriptRowsCache;
  }

  const rows = createTranscriptRowList();
""",
                """function collectTranscriptRows() {
  const rows = createTranscriptRowList();
""",
            )
        ],
        "expect": [
            (
                "panel-scale.test.js",
                "the caret reads the rows it walks and not the whole transcript",
            ),
        ],
    },
    {
        "name": "M34 the word notebook is drawn in full again",
        "file": "sidepanel.js",
        "hunks": [
            # The notebook is drawn a window at a time. Five hundred cards
            # at once is the page the reader used to wait for.
            (
                """function windowedListRange(state) {
  const band = windowedListVisibleBand(state);
""",
                """function windowedListRange(state) {
  if (state.listId === "wordsList") {
    return { start: 0, end: state.rows.length };
  }
  const band = windowedListVisibleBand(state);
""",
            )
        ],
        "expect": [
            (
                "panel-scale.test.js",
                "five hundred word cards do not build a page of five hundred cards",
            ),
        ],
    },
    {
        "name": "M35 the cache is dropped by its age and its count only",
        "file": "sidepanel.js",
        "hunks": [
            # The cache is kept under a byte budget. Twenty digests of a
            # three hour talk are twenty-two megabytes of store, and a store
            # that size is read into memory every time it is counted.
            (
                """    // The ones that are too big. The oldest goes first.
    let bytes = survivors().reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of survivors()) {
      if (bytes <= DIGEST_CACHE_MAX_BYTES) break;
      drop(entry);
      bytes -= entry.bytes;
    }
""",
                "",
            )
        ],
        "expect": [
            (
                "panel-scale.test.js",
                "the cache is dropped by its size and not only by its age",
            ),
        ],
    },
    {
        "name": "M36 the count reads every cached digest",
        "file": "sidepanel.js",
        "hunks": [
            # The count is read from the index the panel keeps. Reading the
            # whole store to count two numbers reads every cached
            # transcript as well.
            (
                """      const index = await readDigestCacheIndex();
      const count = index ? Object.keys(index).length : 0;
      libraryCount.textContent = `(${count})`;
""",
                """      const all = await chrome.storage.local.get(null);
      const count = Object.keys(all).filter((key) =>
        key.startsWith("digest_"),
      ).length;
      libraryCount.textContent = `(${count})`;
""",
            )
        ],
        "expect": [
            (
                "panel-scale.test.js",
                "the welcome count reads the index and not every cached digest",
            ),
        ],
    },
    {
        "name": "M37 the sign-out takes the account's items away without asking",
        "file": "sidepanel.js",
        "hunks": [
            # The sign-out asks about the notes, words and queued deletes
            # that only exist on this device. Without the question the last
            # copy of them goes with the account.
            (
                """async function signOutGithubAccount() {
  const unsynced = await unsyncedAccountItems();
  if (unsynced.notes + unsynced.words > 0) {
    const agreed = await confirmSignOutWithUnsyncedItems(unsynced);
    if (!agreed) return false;
  }
  await chrome.runtime.sendMessage({ action: "logoutGithub" });
""",
                """async function signOutGithubAccount() {
  await chrome.runtime.sendMessage({ action: "logoutGithub" });
""",
            )
        ],
        "expect": [
            (
                "panel-scale.test.js",
                "the sign-out asks about the items that only exist on this device",
            ),
        ],
    },
]


def main():
    failures = []
    for mutation in MUTATIONS:
        path = ROOT / mutation["file"]
        original = path.read_text()
        mutated = None
        try:
            mutated = replace(mutation["file"], mutation["hunks"])
            if mutated == original:
                raise SystemExit(f"mutation did not change the file: {mutation['name']}")
            for test_file, test_name in mutation["expect"]:
                failed, output = run_test(test_file, test_name)
                status = "RED" if failed else "GREEN"
                print(f"{status:5} {mutation['name']} -> {test_name}")
                if not failed:
                    failures.append((mutation["name"], test_name, output))
        finally:
            # The file was never written when the mutation itself failed, so
            # there is nothing to put back.
            if mutated is None or restore(mutation["file"], original, mutated):
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

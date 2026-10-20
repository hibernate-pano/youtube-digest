#!/usr/bin/env python3
"""Mutation check for the vocabulary lifecycle fixes.

Every mutation breaks one production behaviour on purpose. The named test
must go RED. A test that stays green after the behaviour it protects is
broken is worthless, so this script is the proof that the new tests really
guard the fixes.

The vocabulary notebook was never used by a real user before, so every
mutation here targets a way of losing a word that the panel would have
made reachable.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

VOCAB_TEST = "vocabulary-lifecycle.test.js"


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
        "name": "M1 the words are not imported when the user signs in",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """      await migrateLegacyLocalVocabulary(user.githubId);
      await fullSyncVocabulary();""",
                """      await fullSyncVocabulary();""",
            )
        ],
        "expect": [
            (
                VOCAB_TEST,
                "a word captured while signed out is still there after signing in",
            )
        ],
    },
    {
        "name": "M2 the words are not uploaded when the user signs in",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """      await migrateLegacyLocalVocabulary(user.githubId);
      await fullSyncVocabulary();""",
                """      await migrateLegacyLocalVocabulary(user.githubId);""",
            )
        ],
        "expect": [
            (
                VOCAB_TEST,
                "signing in uploads the words that were captured while signed out",
            )
        ],
    },
    {
        "name": "M3 the signed-out words are handed to the next account",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """  const importable = legacy.filter((item) => {
    if (!item || !item.id) return false;
    const owner = owners[String(item.id)];
    // An item this account already owns is importable again; an item that
    // belongs to another account is not.
    return !owner || owner === accountId;
  });""",
                """  const importable = legacy.filter((item) => {
    if (!item || !item.id) return false;
    return true;
  });""",
            )
        ],
        "expect": [
            (
                VOCAB_TEST,
                "a word that another account already took is not imported by the next one",
            )
        ],
    },
    {
        "name": "M4 the delete intent is dropped when the word leaves the device",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """        const pending = await readPendingVocabDeletes(session.githubId);
        if (!pending.some((entry) => entry.key === wordKey)) {
          pending.push({""",
                """        const pending = await readPendingVocabDeletes(session.githubId);
        if (false && !pending.some((entry) => entry.key === wordKey)) {
          pending.push({""",
            )
        ],
        "expect": [
            (
                VOCAB_TEST,
                "a deleted word does not come back when the cloud delete failed",
            )
        ],
    },
    {
        "name": "M5 the intent is dropped when the server cannot be reached",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """    if (unresolved.includes(entry)) {
      // The id could not be looked up - the network is down or the server
      // is unwell. The delete cannot be sent, but the intent stays, so the
      // next sync tries again. Dropping it here would bring the word back.
      remaining.push(entry);
      continue;
    }""",
                """    if (unresolved.includes(entry)) {
      tombstones.delete(entry.key);
      continue;
    }""",
            )
        ],
        "expect": [
            (
                VOCAB_TEST,
                "a word delete survives a sync in which the server cannot be reached",
            )
        ],
    },
    {
        "name": "M6 a word without a server id loses its delete",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """      if (!target.cloudId) {
        // This device never learned the server's id for the word, so the
        // delete cannot be addressed. The server may still have the word -
        // another device pushed it - so the intent stays: the next sync
        // looks the id up in the server's own list and deletes the word
        // there. Dropping the intent here would bring the word back.
        return { success: true };
      }""",
                """      if (!target.cloudId) {
        await removePendingVocabDelete(session.githubId, wordKey);
        return { success: true };
      }""",
            )
        ],
        "expect": [
            (
                VOCAB_TEST,
                "a word delete survives a sync in which the server cannot be reached",
            )
        ],
    },
    {
        "name": "M7 a word captured again is eaten by the delete on its way",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """      await removePendingVocabDelete(session.githubId, vocabKey(item));
      try {
        const pushed = await cloudFetch("/api/vocabulary", {""",
                """      try {
        const pushed = await cloudFetch("/api/vocabulary", {""",
            )
        ],
        "expect": [
            (
                VOCAB_TEST,
                "a word captured again is not deleted from the server when the upload is slow",
            )
        ],
    },
    {
        "name": "M8 the store drops a word without telling anyone",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """        dropped = items.length - MAX_WORDS;
        items.splice(MAX_WORDS);
        await recordDroppedVocabulary(dropped);""",
                """        dropped = items.length - MAX_WORDS;
        items.splice(MAX_WORDS);""",
            )
        ],
        "expect": [
            (
                VOCAB_TEST,
                "the vocabulary store tells the user when it drops an old word",
            )
        ],
    },
    {
        "name": "M9 the store keeps more words than it says it keeps",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """      if (items.length > MAX_WORDS) {
        dropped = items.length - MAX_WORDS;""",
                """      if (false && items.length > MAX_WORDS) {
        dropped = items.length - MAX_WORDS;""",
            )
        ],
        "expect": [
            (
                VOCAB_TEST,
                "the vocabulary store tells the user when it drops an old word",
            )
        ],
    },
    {
        "name": "M10 the sync hands the notes list to the vocabulary sync",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """    pickCloud: (data) => (data && Array.isArray(data.vocabulary) ? data.vocabulary : []),""",
                """    pickCloud: (data) => (data && Array.isArray(data.notes) ? data.notes : []),""",
            )
        ],
        "expect": [
            (
                VOCAB_TEST,
                "the vocabulary sync reads the word list, not the note list",
            )
        ],
    },
    {
        "name": "M11 the panel keeps its own copy of the word limit",
        "file": "sidepanel.js",
        "hunks": [
            (
                """const LOCAL_VOCAB_LIMIT =
  typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.MAX_LOCAL_VOCABULARY
    ? YTD_SETTINGS.MAX_LOCAL_VOCABULARY
    : 500;""",
                """const LOCAL_VOCAB_LIMIT = 500;""",
            )
        ],
        "expect": [
            (VOCAB_TEST, "the panel knows the vocabulary store's cap"),
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

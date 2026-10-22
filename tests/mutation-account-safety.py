#!/usr/bin/env python3
"""Mutation check for the guards that keep the user's account theirs.

Every mutation breaks one production behaviour on purpose. The named test
must go RED. A test that stays green after the behaviour it protects is
broken is worthless, so this script is the proof that the new tests really
guard the fixes.

The first two mutations were found by an audit that asked a fair question:
would the suite notice if this code was deleted? The answer was no, so the
code was unguarded. Now the answer is no again, for a different reason:
the code is guarded, and this script is what proves it.

The rest guard the data that leaves with an account. "Delete my account"
and "sign out" promise that the user's notes and words leave this device,
and "delete all notes" promises that the notes leave the account too. Each
of those promises has a mutation that breaks it, and a test that goes red
when it is broken.
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

SAFETY_TEST = "account-safety.test.js"
SETTINGS_TEST = "settings.test.js"
OPTIONS_TEST = "options-language.test.js"
DELETE_TEST = "cloud-delete-sync.test.js"


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
    {
        "name": "M3 the registry forgets the queues that hold the user's own sentences",
        "file": "settings.js",
        "hunks": [
            (
                """      pendingDeletesStorageKey(githubId),
      pendingVocabDeletesStorageKey(githubId),
      syncCursorStorageKey(githubId, "notes"),
      syncCursorStorageKey(githubId, "vocabulary"),
    ];""",
                """      pendingDeletesStorageKey(githubId),
    ];""",
            )
        ],
        "expect": [
            (
                SETTINGS_TEST,
                "clearing an account's data removes the queues that hold the user's own sentences",
            )
        ],
    },
    {
        "name": "M4 the ownership record keeps the account that left",
        "file": "settings.js",
        "hunks": [
            (
                """          if (owner === accountId) {
            removed += 1;
            continue;
          }""",
                """          if (false) {
            removed += 1;
            continue;
          }""",
            )
        ],
        "expect": [
            (
                SETTINGS_TEST,
                "the ownership record keeps the entries of the other accounts",
            )
        ],
    },
    {
        "name": "M5 signing out leaves the account's data on the device",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """  if (session) {
    await YTD_SETTINGS.clearAccountScopedStorage(
      session.githubId,
      chrome.storage.local,
    );
  }
  await chrome.storage.local.remove(YTD_SETTINGS.GITHUB_SESSION_KEY);""",
                """  await chrome.storage.local.remove(YTD_SETTINGS.GITHUB_SESSION_KEY);""",
            )
        ],
        "expect": [
            (
                DELETE_TEST,
                "signing out takes the account's notes, words and queued deletes with it",
            )
        ],
    },
    {
        "name": "M6 Delete my account leaves the account's queues on the device",
        "file": "options.js",
        "hunks": [
            (
                """        if (githubId) {
          await settingsApi.clearAccountScopedStorage(githubId, storage);
        }
        await storage.remove([""",
                """        await storage.remove([""",
            )
        ],
        "expect": [
            (
                OPTIONS_TEST,
                "Delete my account removes the queues of deletes that have not reached the server",
            )
        ],
    },
    {
        "name": "M7 Delete all notes never reaches the account",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """    const data = await cloudFetch("/api/notes", {
      method: "DELETE",
      token: session.token,
    });""",
                """    const data = { deleted: 0 };""",
            )
        ],
        "expect": [
            (
                DELETE_TEST,
                "deleting all notes asks the account to delete them",
            )
        ],
    },
    {
        "name": "M8 the settings page refuses to save without an AI key",
        "file": "options.js",
        "hunks": [
            (
                """        await storage.set({ [settingsApi.STORAGE_KEY]: settings });
      } catch (_error) {
        setStatus(saveStatus, "saveFailed");
        return;
      }""",
                """        if (!selectedProviderKey(settings)) {
          setStatus(saveStatus, "addAiKey");
          return;
        }
        await storage.set({ [settingsApi.STORAGE_KEY]: settings });
      } catch (_error) {
        setStatus(saveStatus, "saveFailed");
        return;
      }""",
            )
        ],
        "expect": [
            (
                OPTIONS_TEST,
                "the settings page saves what does not need an AI key",
            )
        ],
    },
    {
        "name": "M9 the next steps wait for a successful save",
        "file": "options.js",
        "hunks": [
            (
                """      showSetupGuide();
      await checkStorageIsolation();""",
                """      await checkStorageIsolation();""",
            )
        ],
        "expect": [
            (OPTIONS_TEST, "the next steps are shown even when nothing was saved")
        ],
    },
    {
        "name": "M10 the storage lock failure only reaches the console",
        "file": "background.js",
        "hunks": [
            (
                """  } catch (error) {
    storageIsolation.restricted = false;
    console.warn("[YouTube Digest] Could not restrict storage access:", error);
  }""",
                """  } catch (error) {
    console.warn("[YouTube Digest] Could not restrict storage access:", error);
  }""",
            )
        ],
        "expect": [
            (
                SAFETY_TEST,
                "the worker says the storage could not be locked away from the YouTube page",
            )
        ],
    },
    {
        "name": "M11 the first sign-in throws the import counts away",
        "file": "cloud-sync.js",
        "hunks": [
            (
                """    const importedNotes = lastImportCounts.notes;""",
                """    const importedNotes = 0;""",
            )
        ],
        "expect": [
            (
                DELETE_TEST,
                "the first sign-in reports how many notes and words moved into the account",
            )
        ],
    },
    {
        "name": "M12 a failed account delete still claims the notes are gone",
        "file": "options.js",
        "hunks": [
            (
                """        if (!result || result.success !== true) {
          setStatus(dataStatus, "notesDeleteFailed", {
            message:
              (result && result.error) ||
              "HTTP " + ((result && result.status) || "unknown"),
          });
          return;
        }""",
                """        if (!result || result.success !== true) {
          // The refusal is ignored and the local delete goes ahead.
        }""",
            )
        ],
        "expect": [
            (
                OPTIONS_TEST,
                "Delete all notes keeps the notes and says so when the account cannot delete them",
            )
        ],
    },
    {
        "name": "M13 the last copy of a note is deleted without asking",
        "file": "options.js",
        "hunks": [
            (
                """      const unsynced = await unsyncedAccountItems(githubId);
      if (unsynced.notes + unsynced.words > 0) {
        const confirmed = root.confirm(
          translate(currentLanguage, "logoutUnsyncedConfirm", unsynced),
        );
        if (!confirmed) return;
      }""",
                """      // The last copy of a note is deleted without asking.""",
            )
        ],
        "expect": [
            (
                OPTIONS_TEST,
                "Sign out asks before it deletes a note the account has never received",
            )
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

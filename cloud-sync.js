/**
 * Cloud sync layer (GitHub account): notes + vocabulary + reviews.
 * Loaded by background.js via importScripts AFTER settings.js. Relies on
 * the global YTD_SETTINGS for the server base URL and session key; never
 * touches AI code, so the AI-dependent vocabulary extractor stays in
 * background.js.
 */

/**
 * Records that notes were dropped by the local store's cap.
 *
 * The record is what the panel reads, so the user is told about the loss
 * instead of finding a note missing. Only a real drop is recorded: a store
 * that is under the cap leaves no trace.
 */
async function recordDroppedNotes(count) {
  if (!count) return;
  try {
    const session = await getGithubSession();
    const key = YTD_SETTINGS.notesDroppedKey(session && session.githubId);
    const stored = await chrome.storage.local.get(key);
    const previous = stored && stored[key];
    const total = Number(previous && previous.total) || 0;
    await setStorageWithRecovery({
      [key]: {
        total: total + count,
        lastCount: count,
        lastAt: Date.now(),
      },
    });
  } catch (error) {
    // The record is a courtesy. A failed write must never stop the save.
    console.warn("[YouTube Digest] Could not record the dropped notes:", error.message);
  }
}

/**
 * Records that words were dropped by the local store's cap.
 *
 * The record is what the panel reads, so the user is told about the loss
 * instead of finding a word missing. Only a real drop is recorded: a store
 * that is under the cap leaves no trace.
 */
async function recordDroppedVocabulary(count) {
  if (!count) return;
  try {
    const session = await getGithubSession();
    const key = YTD_SETTINGS.vocabularyDroppedKey(session && session.githubId);
    const stored = await chrome.storage.local.get(key);
    const previous = stored && stored[key];
    const total = Number(previous && previous.total) || 0;
    await setStorageWithRecovery({
      [key]: {
        total: total + count,
        lastCount: count,
        lastAt: Date.now(),
      },
    });
  } catch (error) {
    // The record is a courtesy. A failed write must never stop the save.
    console.warn(
      "[YouTube Digest] Could not record the dropped words:",
      error.message,
    );
  }
}

/**
 * Where the runtime records that cached videos were dropped to make room.
 *
 * The panel has its own notice for the cleanups it runs itself. This key is
 * for the cleanup the runtime runs when the device's storage is full: the
 * user has to hear about that one too, because a cached video they could
 * still open is a video that disappeared.
 */
const STORAGE_RECLAIMED_KEY = "ytd_storage_reclaimed";

/**
 * How long a cached digest is kept.
 *
 * The panel hides a cached video after this long, so an entry this old is
 * already gone as far as the user is concerned.
 */
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Rough size of a stored value.
 *
 * The exact accounting belongs to Chrome; this only has to be good enough to
 * decide how much room to free. An under-estimate costs one more round of
 * eviction, an over-estimate frees a little more than needed.
 */
function estimateStorageBytes(value) {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json.length : 0;
  } catch (error) {
    return 0;
  }
}

/**
 * Frees room in the device's storage by dropping cached digests.
 *
 * A cached digest is a copy of something the user can fetch again. A note or
 * a word is not. So when the storage is full, the cache goes first - and the
 * oldest entry goes before the newest one, because the older a cache is, the
 * less likely the user is to open it.
 *
 * @param {number} neededBytes roughly how much room the pending write needs
 * @returns {Promise<{count: number, expired: number}>} what was dropped
 */
async function evictCachedDigests(neededBytes) {
  let all;
  try {
    all = await chrome.storage.local.get(null);
  } catch (error) {
    return { count: 0, expired: 0 };
  }
  const now = Date.now();
  const entries = Object.keys(all)
    .filter((key) => key.startsWith("digest_"))
    .map((key) => ({
      key,
      timestamp: Number(all[key] && all[key].timestamp) || 0,
      bytes: estimateStorageBytes(all[key]),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (entries.length === 0) return { count: 0, expired: 0 };

  const doomed = [];
  let freed = 0;
  for (const entry of entries) {
    doomed.push(entry);
    freed += entry.bytes;
    // One entry always goes: the write that failed needs room, and an
    // estimate of zero bytes must not turn into "nothing to free".
    if (freed >= neededBytes) break;
  }
  try {
    await chrome.storage.local.remove(doomed.map((entry) => entry.key));
  } catch (error) {
    return { count: 0, expired: 0 };
  }
  const expired = doomed.filter(
    (entry) => now - entry.timestamp > CACHE_MAX_AGE_MS,
  ).length;
  return { count: doomed.length, expired };
}

/**
 * Records that cached videos were dropped to make room.
 *
 * A failed write must not stop the save it was reporting on, so this one
 * swallows its errors - the record is a courtesy, the save is not.
 */
async function recordStorageReclaimed(count) {
  if (!count) return;
  try {
    // A plain write: the record is a courtesy, and a storage that is still
    // full must not throw away another cached video just to note down that
    // it threw one away already.
    await chrome.storage.local.set({
      [STORAGE_RECLAIMED_KEY]: { count, at: Date.now() },
    });
  } catch (error) {
    // Storage full: the eviction itself is the important part.
  }
}

/**
 * Writes to the device's storage, and makes room when there is none.
 *
 * A full storage used to be a silent failure: the write threw, the caller
 * logged it, and the user was told nothing while their note was not there.
 * Two things change here. The cached digests go first, because they are the
 * only thing in the store that can be fetched again, and the write is tried
 * once more afterwards. If it still does not fit, the failure leaves with
 * the reason code the surfaces turn into a sentence.
 *
 * @param {Object} items the values to write
 * @returns {Promise<{evicted: number}>} how many cache entries were dropped
 */
async function setStorageWithRecovery(items) {
  try {
    await chrome.storage.local.set(items);
    return { evicted: 0 };
  } catch (error) {
    if (!YTD_SETTINGS.isQuotaExceededError(error)) throw error;
  }

  const needed = estimateStorageBytes(items);
  let evicted = 0;
  let expired = 0;
  // Three rounds: one for the estimate, and two more in case the estimate
  // was too small. Each round frees at least what the write needs.
  for (let round = 0; round < 3; round++) {
    const dropped = await evictCachedDigests(needed);
    if (dropped.count === 0) break;
    evicted += dropped.count;
    expired += dropped.expired;
    try {
      await chrome.storage.local.set(items);
      await recordStorageReclaimed(evicted);
      console.warn(
        `[YouTube Digest] The device storage was full: ${evicted} cached video(s) were dropped to make room` +
          (expired ? ` (${expired} of them were already expired).` : "."),
      );
      return { evicted };
    } catch (error) {
      if (!YTD_SETTINGS.isQuotaExceededError(error)) throw error;
    }
  }

  const quotaError = new Error(
    "The device storage is full: the note could not be saved.",
  );
  quotaError.code = YTD_SETTINGS.STORAGE_QUOTA_EXCEEDED;
  quotaError.evicted = evicted;
  throw quotaError;
}

async function saveNoteToStorage(note) {
  const namespace = await notesNamespace();
  await withNamespaceLock(namespace, async () => {
    const result = await chrome.storage.local.get(namespace);
    const notes = result[namespace] || [];
    notes.unshift(note); // Add to beginning (newest first)

    // Keep only the most recent notes to prevent storage bloat. The cap lives
    // in settings.js as MAX_LOCAL_NOTES, so the panel can show the same number
    // the store enforces instead of a second copy that drifts.
    const MAX_NOTES = YTD_SETTINGS.MAX_LOCAL_NOTES;
    let dropped = 0;
    if (notes.length > MAX_NOTES) {
      dropped = notes.length - MAX_NOTES;
      notes.splice(MAX_NOTES);
      // A note that vanishes without a word is a note the user lost. The drop
      // is recorded so the panel can say so out loud, and it is logged so it
      // is never a silent truncation.
      await recordDroppedNotes(dropped);
      console.warn(
        `[YouTube Digest] ${dropped} note(s) were dropped: the local store keeps the newest ${MAX_NOTES}.`,
      );
    }

    await setStorageWithRecovery({ [namespace]: notes });
  });

  // Cloud mirror: best-effort, never blocks the local save.
  const session = await getGithubSession();
  if (session) {
    try {
      const pushed = await pushNoteToCloud(session, note);
      const cloudId = pushed && pushed.note && pushed.note.id;
      if (cloudId) {
        // Remember the server id. Without it the next full sync treats the
        // note as never synced and pushes it again, and the favorite flag
        // would travel with it even though the user never touched it here.
        // Only this note is written back: another note may have been saved
        // while the upload was running, and writing the whole list from
        // before the upload would drop it.
        const changes = { cloudId };
        if (typeof note.starred === "boolean") {
          changes.starredSynced = note.starred;
        }
        await patchStoredItem(namespace, note.id, changes);
        // The note is on the server again. A delete of this note that was
        // still on its way is older than the note itself and must not be
        // applied to it - otherwise a note the user re-created would be
        // eaten by a stale intent.
        await removePendingDelete(session.githubId, note.id);
      }
    } catch (error) {
      reportSyncSessionExpired(error);
      console.warn("[YouTube Digest] Note cloud sync failed:", error.message);
    }
  }
}

/**
 * Gets notes from storage (account-namespaced), optionally filtered by video ID
 */
/**
 * Updates a note's text locally (account-namespaced) and on the cloud when
 * signed in. A local edit bumps updatedAt, so the next full sync treats the
 * local copy as newer and pushes it even if the direct PATCH failed.
 */
async function handleUpdateNote(noteId, text) {
  try {
    const cleanText = String(text || "").trim().slice(0, 20000);
    if (!cleanText) return { success: false, error: "EMPTY_NOTE" };
    const namespace = await notesNamespace();
    const note = await withNamespaceLock(namespace, async () => {
      const notes = await readLocalNotes(namespace);
      const found = notes.find((candidate) => candidate.id === noteId);
      if (!found) return null;
      found.text = cleanText;
      found.rawText = cleanText;
      found.updatedAt = Date.now();
      await writeLocalNotes(namespace, notes);
      return found;
    });
    if (!note) return { success: false, error: "Note not found" };
    const session = await getGithubSession();
    if (session) {
      try {
        const payload = localNoteToCloudPayload(note);
        if (note.cloudId) {
          await cloudFetch("/api/notes/" + encodeURIComponent(note.cloudId), {
            method: "PATCH",
            token: session.token,
            body: payload,
          });
        } else {
          const pushed = await pushNoteToCloud(session, note, payload);
          const cloudId = pushed && pushed.note && pushed.note.id;
          if (cloudId) {
            // Only this note is written back: another note may have been
            // saved while the upload was running.
            await patchStoredItem(namespace, noteId, { cloudId });
          }
        }
        // Only a payload that carried the flag can move the baseline: when
        // the flag was left out, the server kept its own value, and that is
        // what the next local change has to be measured against.
        if (payload.starred !== undefined && typeof note.starred === "boolean") {
          await patchStoredItem(namespace, noteId, {
            starredSynced: note.starred,
            starredDirty: false,
          });
        }
      } catch (error) {
        reportSyncSessionExpired(error);
        console.warn("[YouTube Digest] Note update cloud sync failed:", error.message);
      }
    }
    return { success: true, note };
  } catch (error) {
    // The code travels with the message: a full storage and a failed edit
    // are different problems, and the surface has to be able to tell them
    // apart.
    return { success: false, error: error.message, code: error.code };
  }
}

/**
 * Stars or unstars a note on this device and mirrors it to the cloud.
 *
 * This is the only path that may change the favorite flag: the change is
 * marked as an explicit user action, so the sync layer knows it has to be
 * pushed instead of being overwritten by the cloud copy. A note the server
 * already knows is updated through the dedicated star endpoint, so the note
 * text is never rewritten by a star click.
 */
async function handleSetNoteStarred(noteId, starred) {
  try {
    const next = starred === true;
    const namespace = await notesNamespace();
    const note = await withNamespaceLock(namespace, async () => {
      const notes = await readLocalNotes(namespace);
      const found = notes.find((candidate) => candidate.id === noteId);
      if (!found) return null;
      found.starred = next;
      found.starredDirty = true;
      await writeLocalNotes(namespace, notes);
      return found;
    });
    if (!note) return { success: false, error: "Note not found" };
    const session = await getGithubSession();
    if (session) {
      try {
        if (note.cloudId) {
          await cloudFetch("/api/notes/" + encodeURIComponent(note.cloudId) + "/star", {
            method: "PATCH",
            token: session.token,
            body: { starred: next },
          });
        } else {
          const pushed = await pushNoteToCloud(session, note);
          const cloudId = pushed && pushed.note && pushed.note.id;
          if (cloudId) {
            // Only this note is written back: another note may have been
            // saved while the upload was running.
            await patchStoredItem(namespace, noteId, { cloudId });
          }
        }
        // The server confirmed the flag: it is the new baseline.
        await patchStoredItem(namespace, noteId, {
          starredSynced: next,
          starredDirty: false,
        });
      } catch (error) {
        reportSyncSessionExpired(error);
        console.warn("[YouTube Digest] Note star cloud sync failed:", error.message);
      }
    }
    return { success: true, note };
  } catch (error) {
    return { success: false, error: error.message, code: error.code };
  }
}

async function handleGetNotes(videoId) {
  try {
    const namespace = await notesNamespace();
    const result = await chrome.storage.local.get(namespace);
    let notes = result[namespace] || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message, code: error.code };
  }
}

/**
 * Deletes a note locally (account-namespaced) and from the cloud when signed in.
 *
 * The delete is recorded as an intent BEFORE it is sent. A delete that only
 * exists as a request can be lost - the device goes offline, the server
 * refuses, the request fails - and then the note is gone from this device
 * but still on the server. The next full sync sees a note the cloud has
 * and the device does not, and pulls it back: the user deleted a note and
 * it came back.
 *
 * The note leaves this device right away either way. The user asked for it
 * to be gone, and making that wait for the network would leave the note
 * they deleted in front of them.
 */
async function handleDeleteNote(noteId) {
  const clientId = String(noteId || "");
  const session = await getGithubSession();
  const namespace = await notesNamespace();
  try {
    if (session && clientId) {
      // The intent is recorded BEFORE the note leaves the device: a worker
      // that dies in between must not lose the delete.
      const pending = await readPendingDeletes(session.githubId);
      if (!pending.some((entry) => entry.clientId === clientId)) {
        pending.push({ clientId, deletedAt: Date.now() });
        await writePendingDeletes(session.githubId, pending);
      }
    }
    // The note disappears from this device now, whether or not the network
    // is up. The list is read again here: a note saved while the intent
    // was being recorded must not be thrown away with it.
    await withNamespaceLock(namespace, async () => {
      const notes = await readLocalNotes(namespace);
      await writeLocalNotes(
        namespace,
        notes.filter((note) => String(note.id) !== clientId),
      );
    });
  } catch (error) {
    // The note is still on the device, so the delete did not happen: the
    // intent is taken back, otherwise the next sync would delete a note
    // the user still sees.
    if (session && clientId) {
      await removePendingDelete(session.githubId, clientId);
    }
    return { success: false, error: error.message, code: error.code };
  }

  if (session && clientId) {
    try {
      await deleteNoteFromCloud(session, clientId);
      // The server confirmed the delete: the intent has done its job.
      await removePendingDelete(session.githubId, clientId);
    } catch (error) {
      if (isAlreadyGoneError(error)) {
        // The server does not know the note: there is nothing left to
        // delete, so the intent is done.
        await removePendingDelete(session.githubId, clientId);
      } else {
        // The intent stays on the list and is sent again by the next
        // sync. Until then the note is kept out of the merge, so it
        // cannot come back.
        reportSyncSessionExpired(error);
        console.warn(
          "[YouTube Digest] Note cloud delete failed (it is sent again on the next sync):",
          error.message,
        );
      }
    }
  }
  return { success: true };
}

// ============================================================
// CLOUD SYNC (GitHub account)
// ============================================================

/**
 * Storage key for the last clock-offset sample.
 *
 * The offset (server clock minus device clock) is measured from the server
 * timestamp every sync response carries, and persisted: a device with a
 * wrong clock can only be corrected while it is online, and the extension
 * must not re-measure on every single request.
 */
const CLOCK_OFFSET_KEY = "ytd_clock_offset";

/**
 * An offset larger than this is not plausible clock drift. Beyond it the
 * device clock is simply wrong (manually changed, a wrong time zone in a
 * virtual machine, a reset board), and the local timestamps cannot be
 * placed on the server's timeline at all.
 */
const MAX_PLAUSIBLE_CLOCK_OFFSET_MS = 24 * 60 * 60 * 1000;

/**
 * Reads the persisted clock offset.
 *
 * @returns {Promise<{known: boolean, offset: number, trusted: boolean}>}
 *   `known` is false when no server timestamp has ever been seen, which
 *   means the client falls back to comparing raw timestamps.
 */
async function readClockContext() {
  let stored = null;
  try {
    const result = await chrome.storage.local.get(CLOCK_OFFSET_KEY);
    stored = result[CLOCK_OFFSET_KEY];
  } catch (error) {
    return { known: false, offset: 0, trusted: false };
  }
  if (!stored || typeof stored.offset !== "number" || !Number.isFinite(stored.offset)) {
    return { known: false, offset: 0, trusted: false };
  }
  return { known: true, offset: stored.offset, trusted: stored.trusted === true };
}

/**
 * Records the server's clock and derives the device clock's offset from it.
 *
 * The server stamps the response somewhere between the request going out
 * and the reply coming back, so the midpoint of that window is the best
 * estimate of what the device clock read at that moment. The measurement is
 * best-effort: a failure here must never break the request it rides on.
 *
 * @param {string} serverTime the timestamp the server put on the response.
 * @param {number} requestStartedAt device clock when the request went out.
 * @param {number} responseReceivedAt device clock when the reply arrived.
 * @returns {Promise<{known: boolean, offset: number, trusted: boolean}>}
 */
async function recordServerTime(serverTime, requestStartedAt, responseReceivedAt) {
  const serverMs = Date.parse(serverTime);
  if (!Number.isFinite(serverMs)) return readClockContext();
  const localMidpoint = (requestStartedAt + responseReceivedAt) / 2;
  const offset = Math.round(serverMs - localMidpoint);
  const trusted = Math.abs(offset) <= MAX_PLAUSIBLE_CLOCK_OFFSET_MS;
  try {
    await chrome.storage.local.set({
      [CLOCK_OFFSET_KEY]: { offset, trusted, sampledAt: Date.now() },
    });
  } catch (error) {
    // Storage unavailable: this round simply merges on raw timestamps.
  }
  if (!trusted) {
    console.warn(
      "[YouTube Digest] This device's clock is off by " +
        Math.round(offset / 3600000) +
        "h, so notes changed in two places are kept as they are instead of " +
        "one overwriting the other. Fix the system clock to resume merging.",
    );
  }
  return { known: true, offset, trusted };
}

/**
 * The stamp a note carries.
 *
 * It is the same stamp the panel shows and the same one the worker writes
 * into a note it saved here, so a note reads the same whether it was saved
 * on this device or pulled back from the cloud. One formatter, one answer:
 * a note saved locally used to read "90:00" while the same note synced
 * read "1:30:00".
 */
function formatSyncTimestamp(seconds) {
  return YTD_SETTINGS.formatTimestamp(seconds);
}

/**
 * Returns the stored GitHub session, or null when signed out. The token is
 * only ever used inside the service worker; UI callers receive login info.
 */
async function getGithubSession() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.GITHUB_SESSION_KEY);
  const session = stored[YTD_SETTINGS.GITHUB_SESSION_KEY];
  return session && session.token ? session : null;
}

async function cloudFetch(path, options) {
  const token = (options && options.token) || "";
  const method = (options && options.method) || "GET";
  const body = options && options.body;
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const requestStartedAt = Date.now();
  // The request runs under a deadline. A server that stops answering used to
  // hang the whole sync: the service worker was suspended while it waited,
  // and the user's notes simply stopped moving. The deadline is checked over
  // the body as well, because a server that sends headers and then stalls is
  // just as dead as one that never answers.
  const { response, data } = await YTD_SETTINGS.withRequestTimeout(
    async (signal) => {
      const init = {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      };
      if (signal) init.signal = signal;
      const answer = await fetch(YTD_SETTINGS.SERVER_BASE_URL + path, init);
      let payload = null;
      try {
        payload = await answer.json();
      } catch (error) {
        // A body that is not JSON is not fatal by itself: the status below
        // decides what the failure means. A request the deadline aborted is
        // fatal though - it has to surface as a timeout, not as an empty
        // answer that looks like a success.
        if (signal && signal.aborted) throw error;
        payload = null;
      }
      return { response: answer, data: payload };
    },
    YTD_SETTINGS.CLOUD_REQUEST_TIMEOUT_MS,
    () => {
      // A timeout is not a dead session. The code keeps the two apart so the
      // panel never sends the user to the sign-in screen for a slow server.
      const error = new Error(
        "The sync server did not answer within " +
          Math.round(YTD_SETTINGS.CLOUD_REQUEST_TIMEOUT_MS / 1000) +
          " seconds.",
      );
      error.code = YTD_SETTINGS.SYNC_REQUEST_TIMEOUT;
      return error;
    },
  );
  const responseReceivedAt = Date.now();
  // Any response that carries the server's clock teaches the extension how
  // far its own clock is off. Measuring here means the offset is known
  // before the next merge, and it costs nothing on the request itself.
  if (data && typeof data.serverTime === "string") {
    await recordServerTime(data.serverTime, requestStartedAt, responseReceivedAt).catch(
      () => {},
    );
  }
  if (!response.ok) {
    const error = new Error((data && data.error) || "Sync request failed: " + response.status);
    error.status = response.status;
    if (response.status === 401) {
      // The backend issues 30-day tokens with no refresh endpoint, so 401 is
      // terminal: every later write would 401 too. Tag it so callers can
      // surface a re-login prompt instead of logging and moving on.
      error.code = YTD_SETTINGS.SYNC_SESSION_EXPIRED;
    }
    throw error;
  }
  return data;
}

/**
 * True when a sync failure means "the stored session is dead", i.e. the cloud
 * mirror is no longer updating. Everything else (offline, 5xx, a malformed
 * body) is transient and must stay quiet so a flaky network never nags the
 * user into a pointless re-login.
 */
function isSyncSessionExpired(error) {
  return !!error && error.code === YTD_SETTINGS.SYNC_SESSION_EXPIRED;
}

/**
 * Records a session-expiry signal so the panel can show the re-login chip even
 * when the failing call is a fire-and-forget mirror (note save, note delete,
 * vocabulary write) whose caller only logs the error.
 */
function reportSyncSessionExpired(error) {
  if (!isSyncSessionExpired(error)) return false;
  void markSyncSessionExpired();
  return true;
}

/**
 * Synchronously flags the expiry and pings every open surface. The storage write
 * is awaited by callers that can afford it; the broadcast is fire-and-forget so
 * a closed panel never blocks the local save that called us.
 */
async function markSyncSessionExpired() {
  try {
    await chrome.storage.local.set({ [YTD_SETTINGS.SYNC_EXPIRED_KEY]: true });
  } catch (error) {
    // Storage full or unavailable: the broadcast below is still worth sending.
  }
  try {
    chrome.runtime
      .sendMessage({ action: "syncSessionExpired" })
      .catch(() => {});
  } catch (error) {
    // No receiver yet (panel closed) or the worker is shutting down.
  }
}

/**
 * Clears the expiry latch after a request the server accepted. Without this the
 * chip would stick after a re-login or any later successful pull.
 */
async function clearSyncSessionExpired() {
  try {
    const stored = await chrome.storage.local.get(YTD_SETTINGS.SYNC_EXPIRED_KEY);
    if (!stored[YTD_SETTINGS.SYNC_EXPIRED_KEY]) return;
    await chrome.storage.local.remove(YTD_SETTINGS.SYNC_EXPIRED_KEY);
  } catch (error) {
    // Nothing to clear.
  }
}

/**
 * Reports whether the account's stored token is known to be dead. Reads the
 * persisted latch rather than the in-memory one so the answer survives service
 * worker suspension. Always returns false when signed out: with no account
 * there is nothing to re-authenticate.
 */
async function isSyncSessionExpiredForAccount() {
  const session = await getGithubSession();
  if (!session) return false;
  const stored = await chrome.storage.local.get(YTD_SETTINGS.SYNC_EXPIRED_KEY);
  return stored[YTD_SETTINGS.SYNC_EXPIRED_KEY] === true;
}

async function notesNamespace() {
  const session = await getGithubSession();
  return YTD_SETTINGS.notesStorageKey(session && session.githubId);
}

async function readLocalNotes(namespace) {
  const result = await chrome.storage.local.get(namespace);
  return result[namespace] || [];
}

async function writeLocalNotes(namespace, notes) {
  await setStorageWithRecovery({ [namespace]: notes });
}

/**
 * One writer at a time for a stored list.
 *
 * Storage is read-modify-write: two saves that overlap each write the list
 * they read, and the second one drops what the first one added. The lock
 * keeps a read and its write together. The network calls stay outside it,
 * so a slow server cannot hold up the next save.
 */
const namespaceLocks = new Map();

function withNamespaceLock(namespace, action) {
  const previous = namespaceLocks.get(namespace) || Promise.resolve();
  const next = previous.then(action, action);
  namespaceLocks.set(
    namespace,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

/**
 * Writes one item back into a stored list, leaving the others alone.
 *
 * The list is read again after the network call, because another save may
 * have happened in the meantime. Writing the list that was read before the
 * call would throw that save away.
 */
async function patchStoredItem(namespace, id, changes) {
  return withNamespaceLock(namespace, async () => {
    const current = await chrome.storage.local.get(namespace);
    const items = current[namespace] || [];
    const index = items.findIndex((item) => item && item.id === id);
    if (index === -1) return null;
    items[index] = Object.assign({}, items[index], changes);
    await setStorageWithRecovery({ [namespace]: items });
    return items[index];
  });
}

/**
 * Writes a merged list without dropping what was saved meanwhile.
 *
 * The merge took a while, and the user may have saved a note in between.
 * That note is not in the merged list, so writing the merged list as it is
 * would throw the note away. Every item of the merge is written into the
 * list as it is now, and the items the merge never saw are kept.
 */
async function reconcileStoredList(namespace, mergedItems, keyOf) {
  return withNamespaceLock(namespace, async () => {
    const current = await chrome.storage.local.get(namespace);
    const items = current[namespace] || [];
    const merged = new Map();
    for (const item of mergedItems) merged.set(keyOf(item), item);
    // The items the merge never saw were saved while it was running, so
    // they are the newest ones and go first.
    const unseen = items.filter((item) => !merged.has(keyOf(item)));
    const mergedOnly = mergedItems.filter((item) =>
      items.some((existing) => keyOf(existing) === keyOf(item)),
    );
    const added = mergedItems.filter(
      (item) => !items.some((existing) => keyOf(existing) === keyOf(item)),
    );
    const next = unseen.concat(mergedOnly, added);
    await setStorageWithRecovery({ [namespace]: next });
    return next;
  });
}

/**
 * Storage key for the deletes that have not reached the server yet.
 *
 * The key is scoped to the account the notes belong to, exactly like the
 * notes namespace: a delete recorded for one account must never be applied
 * to another account's note.
 */
function pendingDeletesStorageKey(githubId) {
  const id = String(githubId || "").trim();
  return id ? "ytd_pending_deletes_" + id : "ytd_pending_deletes";
}

/**
 * Reads the deletes that have not reached the server yet.
 *
 * They live in chrome.storage.local, so they survive a restart: the device
 * can be closed before the next sync and the delete is still on its way.
 *
 * @param {string|number} githubId the account the deletes belong to.
 * @returns {Promise<Array<{clientId: string, deletedAt: number}>>}
 */
async function readPendingDeletes(githubId) {
  const key = pendingDeletesStorageKey(githubId);
  try {
    const stored = await chrome.storage.local.get(key);
    const entries = stored[key];
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((entry) => entry && typeof entry.clientId === "string" && entry.clientId)
      .map((entry) => ({ clientId: entry.clientId, deletedAt: Number(entry.deletedAt) || 0 }));
  } catch (error) {
    return [];
  }
}

/**
 * Writes the deletes that are still on their way.
 *
 * @param {string|number} githubId the account the deletes belong to.
 * @param {Array<{clientId: string, deletedAt: number}>} entries
 */
async function writePendingDeletes(githubId, entries) {
  const key = pendingDeletesStorageKey(githubId);
  try {
    await setStorageWithRecovery({ [key]: entries });
  } catch (error) {
    // Storage is full or unavailable. The note is already gone from this
    // device; the delete that could not be recorded is sent again by the
    // next sync of the note itself.
    console.warn(
      "[YouTube Digest] Pending note delete could not be stored:",
      error.message,
    );
  }
}

/**
 * Forgets a delete: the server confirmed it, or there was nothing to
 * delete in the first place.
 */
async function removePendingDelete(githubId, clientId) {
  const pending = await readPendingDeletes(githubId);
  const remaining = pending.filter((entry) => entry.clientId !== clientId);
  if (remaining.length === pending.length) return;
  await writePendingDeletes(githubId, remaining);
}

/**
 * True when the server's answer means "this note is not there any more".
 *
 * A note the server never knew is gone for good: there is nothing left to
 * delete, and retrying the delete forever would keep a dead intent alive.
 */
function isAlreadyGoneError(error) {
  return !!error && (error.status === 404 || error.status === 410);
}

/**
 * Drops a pending delete: the note was written again, so the delete is
 * older than the note and must not be applied to it.
 *
 * @param {Array<{clientId: string}>} pending the intents of this sync.
 * @param {Map<string, number>} tombstones the deletes the merge keeps out.
 * @param {string} clientId the note that was written again.
 */
function cancelPendingDelete(pending, tombstones, clientId) {
  const id = String(clientId || "");
  if (!id) return;
  tombstones.delete(id);
  const index = pending.findIndex((entry) => entry.clientId === id);
  if (index >= 0) pending.splice(index, 1);
}

/**
 * Cancels the delete of a note that was written again.
 *
 * The note is on the server again, so the delete that is still on its way
 * is stale: it must not be applied to the note the user re-created.
 *
 * @param {Array<{clientId: string}>} pending the intents of this sync.
 * @param {Map<string, number>} tombstones the deletes the merge keeps out.
 * @param {object} item the note that was pushed.
 * @param {(item: object) => string} keyOfLocal the key of a local item.
 */
function cancelPendingDeleteForPushed(pending, tombstones, item, keyOfLocal) {
  const id = keyOfLocal ? keyOfLocal(item) : "";
  if (!id) return;
  if (!tombstones.has(id)) return;
  cancelPendingDelete(pending, tombstones, id);
}

/**
 * True when two lists of pending deletes hold the same notes in the same
 * order. Used to avoid writing the same list over and over.
 */
function samePendingDeletes(a, b) {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => entry.clientId === b[index].clientId);
}

/**
 * Sends the deletes that have not reached the server yet.
 *
 * A delete the server confirms is done. A delete the server refuses
 * because the note is not there any more is done too - there is nothing
 * left to delete. Everything else - offline, a server error, a dead
 * session - keeps the intent, and the next sync tries again.
 */
async function flushPendingDeletes(session, pending, tombstones) {
  const remaining = [];
  for (const entry of pending) {
    try {
      await deleteNoteFromCloud(session, entry.clientId);
    } catch (error) {
      if (!isAlreadyGoneError(error)) {
        reportSyncSessionExpired(error);
        console.warn(
          "[YouTube Digest] Pending note delete failed (it is sent again on the next sync):",
          error.message,
        );
        remaining.push(entry);
        continue;
      }
    }
    // Confirmed, or already gone: the intent has done its job.
    tombstones.delete(entry.clientId);
  }
  // The list is written even when it is empty: a delete that was
  // cancelled - because the note was written again - has to leave the
  // storage too. A list that did not change is not written again.
  const stored = await readPendingDeletes(session.githubId);
  if (!samePendingDeletes(stored, remaining)) {
    await writePendingDeletes(session.githubId, remaining);
  }
}

/**
 * True when the favorite flag was changed on this device and the change has
 * not reached the server yet.
 *
 * The baseline is the flag the server last confirmed (`starredSynced`). A
 * note without a baseline is never dirty: before this existed the
 * extension had no way to star a note, so an unknown flag is the server's
 * value rather than a user action - treating it as dirty would let a stale
 * local copy undo a star the user removed in the dashboard.
 */
function isStarredDirty(note) {
  if (!note) return false;
  if (note.starredDirty === true) return true;
  if (typeof note.starredSynced !== "boolean") return false;
  return note.starred !== note.starredSynced;
}

/**
 * True when the payload may carry the favorite flag.
 *
 * A note the server already knows only sends the flag when the user
 * changed it here: sending the local copy on every push would clear the
 * stars the user set in the dashboard, because the local copy is usually
 * the stale one. A note the server has never seen sends it too - there is
 * nothing stored that could be cleared.
 */
function shouldSendStarred(note) {
  if (!note || typeof note.starred !== "boolean") return false;
  if (!note.cloudId) return true;
  return isStarredDirty(note);
}

function localNoteToCloudPayload(note) {
  const payload = {
    clientId: String(note.id || ""),
    note: String(note.text || ""),
    videoId: String(note.videoId || ""),
    videoTitle: String(note.videoTitle || ""),
    channelName: String(note.channelName || ""),
    timestampSeconds: Number(note.timestampSeconds) || 0,
    quote: String(note.text || "").slice(0, 3000),
  };
  // The favorite flag is only sent when the user changed it on this
  // device. The server treats a missing flag as "leave the stored value
  // alone", so sending the local copy every time would silently clear
  // every favorite the user set in the web dashboard.
  if (shouldSendStarred(note)) {
    payload.starred = note.starred === true;
  }
  return payload;
}

function cloudToLocalNote(cloud) {
  const seconds = Number(cloud.timestampSeconds) || 0;
  const createdMs = new Date(cloud.createdAt).getTime();
  const updatedMs = new Date(cloud.updatedAt).getTime();
  const starred = cloud.starred === true;
  return {
    id: String(cloud.clientId || ""),
    videoId: String(cloud.videoId || ""),
    videoTitle: String(cloud.videoTitle || "Untitled Video"),
    channelName: String(cloud.channelName || ""),
    timestamp: formatSyncTimestamp(seconds),
    timestampSeconds: seconds,
    timestampedUrl: cloud.videoId
      ? "https://www.youtube.com/watch?v=" + cloud.videoId + "&t=" + seconds + "s"
      : "",
    text: String(cloud.note || ""),
    rawText: String(cloud.note || ""),
    // The cloud is authoritative for the favorite flag: without this the
    // merge below would overwrite the local copy and drop the star. The
    // same value is the baseline a later local change is measured against.
    starred,
    starredSynced: starred,
    createdAt: Number.isFinite(createdMs) ? createdMs : Date.now(),
    updatedAt: Number.isFinite(updatedMs) ? updatedMs : Date.now(),
    cloudId: String(cloud.id || ""),
  };
}

/**
 * Decides which side of a conflict wins.
 *
 * The cloud timestamps are stamped by the server, the local ones by the
 * device clock, so the two can only be compared after the device clock has
 * been corrected with the measured offset. Without that correction a device
 * whose clock runs fast wins every conflict and silently rolls back the
 * changes made in the dashboard, and a device whose clock runs slow loses
 * every local edit.
 *
 * @param {number} cloudMs the cloud timestamp, in server time.
 * @param {number} localMs the local timestamp, in device time.
 * @param {{known: boolean, offset: number, trusted: boolean}} [clock]
 * @returns {"cloud"|"local"|"hold"}
 *   "hold" means neither side may be trusted: the conflict is left alone
 *   instead of guessing.
 */
function resolveConflictWinner(cloudMs, localMs, clock) {
  if (!clock || !clock.known) {
    // No server clock reference yet (an older server that does not send its
    // time, or a first request that failed): fall back to the raw
    // comparison so nothing changes for those deployments.
    return cloudMs > localMs ? "cloud" : "local";
  }
  if (!clock.trusted) {
    // The device clock is too far off to place the local timestamp on the
    // server's timeline. Overwriting either side would destroy work, so
    // the conflict is held until the clock can be believed.
    return "hold";
  }
  const normalizedLocalMs = localMs + clock.offset;
  return cloudMs > normalizedLocalMs ? "cloud" : "local";
}

/**
 * Merges one note's local and cloud copies.
 *
 * The note body follows the row winner, but the favorite flag is merged on
 * its own: the cloud is the source of truth unless the star was changed
 * explicitly on this device and has not been pushed yet.
 *
 * @returns {{item: object, push: boolean}} the merged note and whether it
 *   still has to be sent to the server.
 */
function mergeNoteForSync(local, cloud, winner) {
  const item = winner === "cloud" ? cloudToLocalNote(cloud) : local;
  if (isStarredDirty(local)) {
    // An explicit change that never reached the server wins, and the note
    // has to be pushed so the change actually arrives.
    item.starred = local.starred === true;
    return { item, push: true };
  }
  const cloudStarred = cloud.starred === true;
  item.starred = cloudStarred;
  item.starredSynced = cloudStarred;
  return { item, push: winner === "local" };
}

/**
 * Generic collection merge shared by notes and vocabulary. Semantics:
 * - Cloud rows come down; on a conflict the newest edit wins.
 * - Local rows that were never synced (no cloudId yet) are kept and queued
 *   for push.
 * - Local rows that were synced before but are missing from the cloud were
 *   deleted elsewhere (e.g. from the web dashboard), so they are dropped
 *   locally too; without this, deletions would resurrect on the next sync.
 *
 * `clock` carries the measured offset between the device clock and the
 * server clock; `mergeItem` can override how a conflicting pair is turned
 * into one row (the notes use it to merge the favorite flag on its own).
 *
 * `tombstones` holds the keys whose delete has not reached the server yet.
 * They are kept out of the merge on both sides: the cloud copy must not be
 * pulled down - that is exactly what brings a deleted note back - and a
 * local copy that is still there is a note the user re-created after the
 * delete, which the push then confirms to the server.
 */
function mergeCollectionsForSync(
  localItems,
  cloudItems,
  { keyOfLocal, keyOfCloud, toLocal, clock, mergeItem, tombstones },
) {
  const deleted = tombstones instanceof Map ? tombstones : new Map();
  const cloudByKey = new Map();
  for (const cloud of cloudItems || []) {
    const key = keyOfCloud(cloud);
    if (key) cloudByKey.set(key, cloud);
  }
  const merged = new Map();
  for (const local of localItems || []) {
    const key = keyOfLocal(local);
    if (!key) continue;
    if (deleted.has(key)) {
      // The user deleted this note on this device and the delete has not
      // reached the server yet. The cloud copy is not merged in: that is
      // what brings a deleted note back.
      //
      // A local copy that is NEWER than the delete is a note the user
      // re-created after the delete. It is kept and pushed, and the
      // successful push cancels the pending delete.
      const writtenAt = Number(local.updatedAt) || Number(local.createdAt) || 0;
      if (writtenAt > deleted.get(key)) {
        merged.set(key, {
          source: "local",
          item: local,
          push: true,
          updatedAt: writtenAt,
        });
      } else if (!local.cloudId) {
        // A note the server has never seen: the delete that is on its way
        // has nothing to delete there, so the note is pushed and the
        // intent is dropped. Without this the note would be pushed and
        // deleted again by the intent that follows.
        merged.set(key, {
          source: "local",
          item: local,
          push: true,
          updatedAt: writtenAt,
        });
      }
      // else: the note was deleted on this device and is not on the
      // device any more: it goes away, just like a note deleted elsewhere.
      continue;
    }
    const cloud = cloudByKey.get(key);
    if (cloud) {
      const cloudMs = new Date(cloud.updatedAt).getTime();
      const localMs = Number(local.updatedAt) || Number(local.createdAt) || 0;
      const winner = resolveConflictWinner(cloudMs, localMs, clock);
      if (winner === "hold") {
        // Keep the local copy, do not push it and do not replace it with
        // the cloud copy: with an untrustworthy clock neither side can be
        // called the newer one, so nothing is thrown away.
        merged.set(key, {
          source: "hold",
          item: local,
          push: false,
          updatedAt: localMs,
        });
        continue;
      }
      const outcome = mergeItem
        ? mergeItem(local, cloud, winner)
        : {
            item: winner === "cloud" ? toLocal(cloud) : local,
            push: winner === "local",
          };
      merged.set(key, {
        source: winner,
        item: outcome.item,
        push: outcome.push,
        updatedAt: Math.max(cloudMs, localMs),
      });
    } else if (!local.cloudId) {
      // Never synced: brand-new local item, keep and push.
      merged.set(key, {
        source: "local",
        item: local,
        push: true,
        updatedAt: Number(local.updatedAt) || Number(local.createdAt) || 0,
      });
    }
    // else: synced before but missing from the cloud -> deleted elsewhere.
  }
  for (const cloud of cloudByKey.values()) {
    const key = keyOfCloud(cloud);
    // The delete of this note is still on its way: pulling the cloud copy
    // down would bring the note back.
    if (deleted.has(key)) continue;
    if (!merged.has(key)) {
      merged.set(key, {
        source: "cloud",
        item: toLocal(cloud),
        push: false,
        updatedAt: new Date(cloud.updatedAt).getTime(),
      });
    }
  }
  const mergedItems = [];
  const toPush = [];
  for (const entry of merged.values()) {
    mergedItems.push(entry.item);
    if (entry.push) toPush.push(entry.item);
  }
  return { mergedItems, toPush };
}

function mergeNotesForSync(localNotes, cloudNotes, clock, tombstones) {
  return mergeCollectionsForSync(localNotes, cloudNotes, {
    keyOfLocal: (item) => (item && item.id ? String(item.id) : ""),
    keyOfCloud: (item) => (item && item.clientId ? String(item.clientId) : ""),
    toLocal: cloudToLocalNote,
    mergeItem: mergeNoteForSync,
    clock,
    tombstones,
  });
}

async function pushNoteToCloud(session, note, payload) {
  return cloudFetch("/api/notes", {
    method: "POST",
    token: session.token,
    body: payload || localNoteToCloudPayload(note),
  });
}

async function deleteNoteFromCloud(session, noteId) {
  return cloudFetch("/api/notes/client/" + encodeURIComponent(noteId), {
    method: "DELETE",
    token: session.token,
  });
}

/**
 * Full bidirectional sync for the signed-in account: pull the cloud list,
 * merge by clientId (newest wins), push local-only notes, write back locally.
 * Never touches the signed-out namespace, so accounts stay isolated.
 */
/**
 * Shared full-sync runner for notes and vocabulary: pull the cloud list,
 * merge (newest wins, deletions propagate), push local-only items while
 * recording their cloudId, write back locally. Never touches the signed-out
 * namespace, so accounts stay isolated.
 */
async function runFullSync({
  namespaceFor,
  fetchPath,
  pushPath,
  keyOfLocal,
  toCloudPayload,
  cloudIdOf,
  pickCloud,
  readLocal,
  writeLocal,
  merge,
  tombstones,
  onPushed,
}) {
  const session = await getGithubSession();
  if (!session) return { success: true, synced: false, reason: "not signed in" };
  const namespace = namespaceFor(session);
  const local = await readLocal(namespace);
  let cloud = [];
  try {
    const data = await cloudFetch(fetchPath, { token: session.token });
    // The server accepted our token, so any earlier expiry is stale.
    await clearSyncSessionExpired();
    // The list is named by the endpoint: the notes live under "notes" and
    // the words under "vocabulary". Picking the wrong one is not a small
    // mistake - an empty array is truthy, so "data.notes || data.vocabulary"
    // would silently hand the notes list to the vocabulary sync.
    cloud = pickCloud(data);
  } catch (error) {
    // The pull is the one step that decides whether syncing works at all, so
    // its failure is returned with the reason code intact: the caller can tell
    // a dead token (re-login prompt) from a transient failure (stay quiet).
    // The latch is persisted here too, not only on the fire-and-forget mirror
    // writes: the panel re-reads it from storage on the next open, so a signal
    // that lived only in this return value would be lost by the time the user
    // could act on it.
    await reportSyncSessionExpired(error);
    return {
      success: false,
      error: error.message,
      status: error.status,
      code: error.code,
      expired: isSyncSessionExpired(error),
    };
  }
  // The pull carried the server's clock, so the offset between the device
  // clock and the server clock is known before the merge happens.
  const clock = await readClockContext();
  const { mergedItems, toPush } = merge(local, cloud, clock, tombstones);
  for (const item of toPush) {
    try {
      const payload = toCloudPayload(item);
      const pushed = await cloudFetch(pushPath, {
        method: "POST",
        token: session.token,
        body: payload,
      });
      const cloudId = cloudIdOf(pushed);
      if (cloudId) {
        // Remember the server id so future merges treat it as synced and
        // deletions elsewhere propagate instead of resurrecting.
        const target = mergedItems.find((candidate) => keyOfLocal(candidate) === keyOfLocal(item));
        if (target) target.cloudId = cloudId;
      }
      if (payload.starred !== undefined && typeof item.starred === "boolean") {
        // The server confirmed the favorite flag, so it becomes the
        // baseline a later local change is measured against.
        item.starredSynced = item.starred;
        item.starredDirty = false;
      }
      // The note is on the server again, so the delete that is still on
      // its way is stale: it must not be applied to the note the user
      // re-created.
      if (onPushed) onPushed(item);
    } catch (error) {
      reportSyncSessionExpired(error);
      console.warn("[YouTube Digest] Sync push failed (kept locally):", error.message);
    }
  }
  // The merge was computed from a list that was read before the upload, so
  // the user may have saved something in the meantime. The merged list is
  // written into the list as it is now, and what the merge never saw is
  // kept: a note saved during a sync must not disappear because of it.
  const written = await reconcileStoredList(namespace, mergedItems, keyOfLocal);
  return { success: true, synced: true, count: written.length };
}

async function fullSyncNotes() {
  const session = await getGithubSession();
  if (!session) return { success: true, synced: false, reason: "not signed in" };
  // The deletes that have not reached the server yet. Their notes are kept
  // out of the merge, so the sync cannot bring them back, and they are
  // sent again below.
  const pending = await readPendingDeletes(session.githubId);
  // The delete intents, with the moment they were recorded. The merge
  // compares that moment with the note's own timestamp: a note that was
  // written AFTER the delete is newer, and the write wins - the delete is
  // stale and must not be applied to the note.
  const tombstones = new Map();
  for (const entry of pending) {
    tombstones.set(entry.clientId, entry.deletedAt);
  }
  const result = await runFullSync({
    namespaceFor: (session) => YTD_SETTINGS.notesStorageKey(session.githubId),
    fetchPath: "/api/notes",
    pushPath: "/api/notes",
    keyOfLocal: (item) => (item && item.id ? String(item.id) : ""),
    toCloudPayload: localNoteToCloudPayload,
    cloudIdOf: (pushed) => pushed && pushed.note && pushed.note.id,
    pickCloud: (data) => (data && Array.isArray(data.notes) ? data.notes : []),
    readLocal: readLocalNotes,
    writeLocal: writeLocalNotes,
    merge: mergeNotesForSync,
    tombstones,
    // A note that is written again is newer than the delete that is still
    // on its way: the delete is dropped, so a note the user re-created is
    // not eaten by a stale intent.
    onPushed: (item) =>
      cancelPendingDeleteForPushed(
        pending,
        tombstones,
        item,
        (candidate) => (candidate && candidate.id ? String(candidate.id) : ""),
      ),
  });
  // The deletes that are still on their way are sent again now - also when
  // the pull failed, because the delete is a request of its own.
  await flushPendingDeletes(session, pending, tombstones);
  return result;
}

async function handleGetGithubSession() {
  const session = await getGithubSession();
  return {
    success: true,
    session: session
      ? { login: session.login, githubId: session.githubId, savedAt: session.savedAt }
      : null,
    expired: session ? await isSyncSessionExpiredForAccount() : false,
  };
}

async function handleLogoutGithub() {
  await chrome.storage.local.remove(YTD_SETTINGS.GITHUB_SESSION_KEY);
  // Drop the latch too: a signed-out account has no expired session to report.
  await chrome.storage.local.remove(YTD_SETTINGS.SYNC_EXPIRED_KEY);
  return { success: true };
}
// ============================================================
// VOCABULARY + REVIEWS
// ============================================================

async function vocabularyNamespace() {
  const session = await getGithubSession();
  return YTD_SETTINGS.vocabularyStorageKey(session && session.githubId);
}

async function readLocalVocabulary(namespace) {
  const result = await chrome.storage.local.get(namespace);
  return result[namespace] || [];
}

async function writeLocalVocabulary(namespace, items) {
  await setStorageWithRecovery({ [namespace]: items });
}

/**
 * Storage key for the record of which account owns which word from the
 * signed-out bucket.
 *
 * The same rule as the notes: a word belongs to exactly one account. Once
 * an account has taken a word it is never handed to another one, so a
 * failed upload cannot make another learner inherit words that were
 * written under a different account.
 */
const VOCABULARY_CLAIM_KEY = "ytd_vocabulary_claim";

/**
 * Reads the claim record: which account owns which word id.
 *
 * @returns {Promise<Record<string, string>>} word id -> account id.
 */
async function readVocabularyClaim() {
  try {
    const result = await chrome.storage.local.get(VOCABULARY_CLAIM_KEY);
    const claim = result[VOCABULARY_CLAIM_KEY];
    if (!claim || typeof claim !== "object" || !claim.ids) return {};
    const owners = {};
    for (const [id, owner] of Object.entries(claim.ids)) {
      owners[String(id)] = String(owner);
    }
    return owners;
  } catch (error) {
    return {};
  }
}

async function writeVocabularyClaim(owners) {
  try {
    await setStorageWithRecovery({ [VOCABULARY_CLAIM_KEY]: { ids: owners } });
    return true;
  } catch (error) {
    // The claim is the safety net that keeps another account from picking
    // the words up, so a failed write has to be reported: the caller keeps
    // the source copy instead of deleting it.
    return false;
  }
}

/**
 * Moves the items that were saved while signed out into the account that is
 * signing in now.
 *
 * Without this, signing in moved the reading namespace away from what the
 * user had just captured: the items were still in the device's storage, but
 * the panel looked in the signed-in namespace and found nothing, and the
 * cloud never saw them either. The user watched their work disappear at the
 * moment they signed in.
 *
 * The import has to survive an interruption, because the browser can close
 * the tab, the service worker can be suspended, or the device can run out of
 * room at exactly the wrong moment. Three rules make it safe:
 *
 * - The ownership is recorded FIRST. An item that is not claimed yet could
 *   be picked up by the next account that signs in, so the claim is written
 *   before anything moves. When the claim cannot be written, nothing moves
 *   at all: the items stay in the signed-out bucket, where the next sign-in
 *   finds them again.
 * - The copy into the account namespace is idempotent. The items are merged
 *   by id, so running the import twice adds nothing the second time.
 * - Only the items that were really moved leave the signed-out bucket. An
 *   item that belongs to another account stays where it is: it is not this
 *   account's to move, and deleting it would lose it for good.
 *
 * The order is therefore claim, copy, clean up. Every interruption leaves
 * the items somewhere they can still be found, and never in two accounts.
 *
 * @param {Object} options
 * @param {string} options.accountId the account that is signing in
 * @param {string} options.label what the items are called ("notes", "words")
 * @param {string} options.bucketKey the signed-out bucket
 * @param {function(string): string} options.namespaceKeyFor the account bucket
 * @param {function(): Promise<Object>} options.readClaim reads the ownership
 * @param {function(Object): Promise<boolean>} options.writeClaim writes it
 * @param {function(string): Promise<Array>} options.readBucket reads a bucket
 * @param {function(string, Array): Promise<void>} options.writeBucket writes it
 * @returns {Promise<number>} how many items were imported
 */
async function migrateLegacyBucket({
  accountId,
  label,
  bucketKey,
  namespaceKeyFor,
  readClaim,
  writeClaim,
  readBucket,
  writeBucket,
}) {
  const legacy = await readBucket(bucketKey);
  if (!Array.isArray(legacy) || legacy.length === 0) return 0;
  const owners = await readClaim();
  const importable = legacy.filter((item) => {
    if (!item || !item.id) return false;
    const owner = owners[String(item.id)];
    // An item this account already owns is importable again; an item that
    // belongs to another account is not.
    return !owner || owner === accountId;
  });
  if (importable.length === 0) {
    // Every item in the bucket already belongs to another account.
    console.warn(
      `[YouTube Digest] The ${label} saved while signed out already belong to ` +
        "another account and were not imported here.",
    );
    return 0;
  }

  // The ownership is recorded before anything moves. Without the claim an
  // item could be handed to the next account that signs in, so a claim that
  // cannot be written stops the whole import: the items stay in the
  // signed-out bucket instead of being copied somewhere unprotected.
  for (const item of importable) {
    owners[String(item.id)] = accountId;
  }
  if (!(await writeClaim(owners))) {
    console.warn(
      `[YouTube Digest] The ${label} could not be marked as belonging to this ` +
        "account, so they stay where they are.",
    );
    return 0;
  }

  // The copy into the account namespace. Merging by id keeps it idempotent:
  // a run that was interrupted after the copy finds everything in place and
  // adds nothing.
  const namespace = namespaceKeyFor(accountId);
  const current = await readBucket(namespace);
  const byId = new Map(current.map((item) => [String(item.id), item]));
  let added = 0;
  for (const item of importable) {
    if (item && item.id && !byId.has(String(item.id))) {
      byId.set(String(item.id), item);
      added += 1;
    }
  }
  if (added > 0) await writeBucket(namespace, [...byId.values()]);

  // Only the items that now live in the account namespace leave the
  // signed-out bucket. The ones that belong to another account stay: they
  // are not ours to move, and the old code deleted them along with the
  // bucket, which lost them for good.
  const movedIds = new Set(importable.map((item) => String(item.id)));
  const remaining = legacy.filter((item) => {
    if (!item || !item.id) return true;
    return !movedIds.has(String(item.id));
  });
  if (remaining.length === legacy.length) return added;
  if (remaining.length === 0) {
    await chrome.storage.local.remove(bucketKey);
  } else {
    // One key, one write: the bucket is never half rewritten.
    await setStorageWithRecovery({ [bucketKey]: remaining });
  }
  return added;
}

/**
 * Imports the words that were saved while signed out into the account that
 * is signing in now.
 *
 * The words follow the same road as the notes, and the same rules: they are
 * claimed before they move, the copy is idempotent, and only the words that
 * really moved leave the signed-out bucket.
 *
 * @param {string|number} githubId the account that is signing in.
 * @returns {Promise<number>} how many words were imported.
 */
async function migrateLegacyLocalVocabulary(githubId) {
  const accountId = String(githubId || "").trim();
  if (!accountId) return 0;
  return migrateLegacyBucket({
    accountId,
    label: "words",
    bucketKey: YTD_SETTINGS.VOCABULARY_STORAGE_KEY,
    namespaceKeyFor: YTD_SETTINGS.vocabularyStorageKey,
    readClaim: readVocabularyClaim,
    writeClaim: writeVocabularyClaim,
    readBucket: readLocalVocabulary,
    writeBucket: writeLocalVocabulary,
  });
}

function localVocabToCloudPayload(item) {
  return {
    term: String(item.term || "").slice(0, 200),
    translation: String(item.translation || "").slice(0, 500),
    sentence: String(item.sentence || "").slice(0, 4000),
    sentenceTranslation: String(item.explanation || "").slice(0, 500),
    videoId: String(item.videoId || ""),
    videoTitle: String(item.videoTitle || ""),
    timestampSeconds: Number(item.timestampSeconds) || 0,
    status: item.status || "learning",
  };
}

function cloudVocabToLocal(cloud) {
  return {
    id: "vocab_" + cloud.id,
    term: String(cloud.term || ""),
    translation: String(cloud.translation || ""),
    explanation: String(cloud.sentenceTranslation || ""),
    sentence: String(cloud.sentence || ""),
    videoId: String(cloud.videoId || ""),
    videoTitle: String(cloud.videoTitle || ""),
    timestampSeconds: Number(cloud.timestampSeconds) || 0,
    status: cloud.status || "learning",
    createdAt: new Date(cloud.createdAt).getTime() || Date.now(),
    updatedAt: new Date(cloud.updatedAt).getTime() || Date.now(),
    cloudId: String(cloud.id || ""),
  };
}

function vocabKey(item) {
  return String(item.term || "") + "|" + String(item.sentence || "");
}

/**
 * Merges one word's local and cloud copies.
 *
 * The word's body follows the row winner, but the LOCAL id is kept: the
 * panel holds that id and sends it back when the user deletes the word. If
 * the id changed with every merge, the delete would arrive for a word that
 * no longer exists and the user would watch the word stay.
 *
 * @returns {{item: object, push: boolean}} the merged word and whether it
 *   still has to be sent to the server.
 */
function mergeVocabularyItem(local, cloud, winner) {
  const item = winner === "cloud" ? cloudVocabToLocal(cloud) : local;
  if (local && local.id) {
    item.id = local.id;
    item.createdAt = local.createdAt || item.createdAt;
  }
  return { item, push: winner === "local" };
}

/**
 * Merges the local words with the words in the cloud.
 *
 * The key is the word itself: the server keeps one row per term and
 * sentence, so that pair is what says whether the two sides are talking
 * about the same word.
 */
function mergeVocabularyForSync(localWords, cloudWords, clock, tombstones) {
  return mergeCollectionsForSync(localWords, cloudWords, {
    keyOfLocal: vocabKey,
    keyOfCloud: vocabKey,
    toLocal: cloudVocabToLocal,
    mergeItem: mergeVocabularyItem,
    clock,
    tombstones,
  });
}

async function fullSyncVocabulary() {
  const session = await getGithubSession();
  if (!session) return { success: true, synced: false, reason: "not signed in" };
  // The deletes that have not reached the server yet. Their words are kept
  // out of the merge, so the sync cannot bring them back, and they are sent
  // again below.
  const pending = await readPendingVocabDeletes(session.githubId);
  // The delete intents, with the moment they were recorded. The merge
  // compares that moment with the word's own timestamp: a word that was
  // captured AFTER the delete is newer, and the capture wins - the delete
  // is stale and must not be applied to the word.
  const tombstones = new Map();
  for (const entry of pending) {
    tombstones.set(entry.key, entry.deletedAt);
  }
  const result = await runFullSync({
    namespaceFor: (session) => YTD_SETTINGS.vocabularyStorageKey(session.githubId),
    fetchPath: "/api/vocabulary",
    pushPath: "/api/vocabulary",
    keyOfLocal: vocabKey,
    toCloudPayload: localVocabToCloudPayload,
    cloudIdOf: (pushed) => pushed && pushed.vocabulary && pushed.vocabulary.id,
    pickCloud: (data) => (data && Array.isArray(data.vocabulary) ? data.vocabulary : []),
    readLocal: readLocalVocabulary,
    writeLocal: writeLocalVocabulary,
    merge: mergeVocabularyForSync,
    tombstones,
    // A word that is captured again is newer than the delete that is still
    // on its way: the delete is dropped, so a word the user re-captured is
    // not eaten by a stale intent.
    onPushed: (item) =>
      cancelPendingVocabDeleteForPushed(
        pending,
        tombstones,
        item,
        vocabKey,
      ),
  });
  // The deletes that are still on their way are sent again now - also when
  // the pull failed, because the delete is a request of its own.
  await flushPendingVocabDeletes(session, pending, tombstones);
  return result;
}

/**
 * Extracts 1-2 study-worthy words from a sentence using the active AI provider.
 */

async function handleSaveVocabulary(entry) {
  try {
    const term = String(entry && entry.term || "").trim().slice(0, 200);
    const sentence = String(entry && entry.sentence || "").trim().slice(0, 4000);
    if (!term) return { success: false, error: "EMPTY_TERM" };
    const namespace = await vocabularyNamespace();
    const now = Date.now();
    const item = {
      id: "vocab_" + now + "_" + Math.floor(Math.random() * 1000),
      term,
      translation: String(entry.translation || "").trim().slice(0, 500),
      explanation: String(entry.explanation || "").trim().slice(0, 500),
      sentence,
      videoId: String(entry.videoId || ""),
      videoTitle: String(entry.videoTitle || ""),
      timestampSeconds: Number(entry.timestampSeconds) || 0,
      status: "learning",
      createdAt: now,
      updatedAt: now,
      cloudId: "",
    };
    await withNamespaceLock(namespace, async () => {
      const items = await readLocalVocabulary(namespace);
      const existingIndex = items.findIndex(
        (candidate) => vocabKey(candidate) === term + "|" + sentence,
      );
      if (existingIndex >= 0) {
        const existing = items[existingIndex];
        item.id = existing.id;
        item.cloudId = existing.cloudId || "";
        item.createdAt = existing.createdAt || now;
        item.status = existing.status || "learning";
        items[existingIndex] = item;
      } else {
        items.unshift(item);
      }
      // The cap lives in settings.js so the panel can show the same number the
      // store enforces. A word that disappears without a word is a word the
      // user lost, so the drop is recorded and logged - never a silent
      // truncation.
      const MAX_WORDS = YTD_SETTINGS.MAX_LOCAL_VOCABULARY;
      let dropped = 0;
      if (items.length > MAX_WORDS) {
        dropped = items.length - MAX_WORDS;
        items.splice(MAX_WORDS);
        await recordDroppedVocabulary(dropped);
        console.warn(
          `[YouTube Digest] ${dropped} word(s) were dropped: the local store keeps the newest ${MAX_WORDS}.`,
        );
      }
      await writeLocalVocabulary(namespace, items);
    });
    const session = await getGithubSession();
    if (session) {
      // The word is on the device again, so a delete of this word that is
      // still on its way is stale: it must not be applied to the word the
      // user just captured. Otherwise the next sync would delete the word
      // the user re-created.
      await removePendingVocabDelete(session.githubId, vocabKey(item));
      try {
        const pushed = await cloudFetch("/api/vocabulary", {
          method: "POST",
          token: session.token,
          body: localVocabToCloudPayload(item),
        });
        const cloudId =
          (pushed && pushed.vocabulary && pushed.vocabulary.id) || item.cloudId;
        // Only this word is written back: another word may have been saved
        // while the upload was running.
        await patchStoredItem(namespace, item.id, { cloudId });
      } catch (error) {
        reportSyncSessionExpired(error);
        console.warn("[YouTube Digest] Vocabulary cloud save failed:", error.message);
      }
    }
    return { success: true, item };
  } catch (error) {
    // A word that was not stored is a word the user believes is there and
    // is not, so the code has to reach the surface.
    return { success: false, error: error.message, code: error.code };
  }
}

async function handleGetVocabulary() {
  try {
    const namespace = await vocabularyNamespace();
    const items = await readLocalVocabulary(namespace);
    return { success: true, items };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Storage key for the word deletes that have not reached the server yet.
 *
 * Scoped to the account the words belong to, exactly like the notes
 * namespace: a delete recorded for one account must never be applied to
 * another account's word.
 */
function pendingVocabDeletesStorageKey(githubId) {
  const id = String(githubId || "").trim();
  return id ? "ytd_pending_vocab_deletes_" + id : "ytd_pending_vocab_deletes";
}

/**
 * Reads the word deletes that have not reached the server yet.
 *
 * @param {string|number} githubId the account the deletes belong to.
 * @returns {Promise<Array<{key: string, term: string, sentence: string,
 *   cloudId: string, deletedAt: number}>>}
 */
async function readPendingVocabDeletes(githubId) {
  const key = pendingVocabDeletesStorageKey(githubId);
  try {
    const stored = await chrome.storage.local.get(key);
    const entries = stored[key];
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((entry) => entry && typeof entry.key === "string" && entry.key)
      .map((entry) => ({
        key: entry.key,
        term: String(entry.term || ""),
        sentence: String(entry.sentence || ""),
        cloudId: String(entry.cloudId || ""),
        deletedAt: Number(entry.deletedAt) || 0,
      }));
  } catch (error) {
    return [];
  }
}

async function writePendingVocabDeletes(githubId, entries) {
  const key = pendingVocabDeletesStorageKey(githubId);
  try {
    await setStorageWithRecovery({ [key]: entries });
  } catch (error) {
    console.warn(
      "[YouTube Digest] Pending word delete could not be stored:",
      error.message,
    );
  }
}

async function removePendingVocabDelete(githubId, wordKey) {
  const pending = await readPendingVocabDeletes(githubId);
  const remaining = pending.filter((entry) => entry.key !== wordKey);
  if (remaining.length === pending.length) return;
  await writePendingVocabDeletes(githubId, remaining);
}

/**
 * Drops a pending word delete: the word was captured again, so the delete
 * is older than the word and must not be applied to it.
 *
 * @param {Array<{key: string}>} pending the intents of this sync.
 * @param {Map<string, number>} tombstones the deletes the merge keeps out.
 * @param {string} wordKey the key of the word that was captured again.
 */
function cancelPendingVocabDelete(pending, tombstones, wordKey) {
  const key = String(wordKey || "");
  if (!key) return;
  tombstones.delete(key);
  const index = pending.findIndex((entry) => entry.key === key);
  if (index >= 0) pending.splice(index, 1);
}

/**
 * Cancels the delete of a word that was captured again.
 *
 * @param {Array<{key: string}>} pending the intents of this sync.
 * @param {Map<string, number>} tombstones the deletes the merge keeps out.
 * @param {object} item the word that was pushed.
 * @param {(item: object) => string} keyOfLocal the key of a local word.
 */
function cancelPendingVocabDeleteForPushed(pending, tombstones, item, keyOfLocal) {
  const key = keyOfLocal ? keyOfLocal(item) : "";
  if (!key) return;
  if (!tombstones.has(key)) return;
  cancelPendingVocabDelete(pending, tombstones, key);
}

/**
 * True when two lists of pending word deletes hold the same words in the
 * same order. Used to avoid writing the same list over and over.
 */
function samePendingVocabDeletes(a, b) {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => entry.key === b[index].key);
}

/**
 * Finds the server's id for a word that was deleted without one.
 *
 * The server keeps one row per (word, sentence) pair, and a row can be
 * there without this device ever having seen its id: the word was pushed
 * from another device, or the local copy was never pushed at all. The
 * delete is addressed by the server's id, so the id has to be looked up in
 * the server's own list - otherwise the delete would be dropped and the
 * word would come back on the next sync.
 *
 * @param {Array<{term: string, sentence: string, cloudId: string}>} pending
 * @returns {Promise<Array<object>>} the entries whose server id is still
 *   unknown because the lookup itself failed.
 */
async function findMissingVocabCloudIds(session, pending) {
  const missing = pending.filter((entry) => !entry.cloudId);
  if (missing.length === 0) return [];
  let rows = [];
  try {
    const data = await cloudFetch("/api/vocabulary", { token: session.token });
    rows = data && Array.isArray(data.vocabulary) ? data.vocabulary : [];
  } catch (error) {
    // The lookup failed, so the ids stay unknown and the deletes are sent
    // again on the next sync. Dropping the intent here would let the word
    // come back on the next pull.
    return missing;
  }
  for (const entry of missing) {
    const match = rows.find(
      (row) =>
        row &&
        String(row.term || "") === entry.term &&
        String(row.sentence || "") === entry.sentence,
    );
    if (match && match.id) {
      entry.cloudId = String(match.id);
    } else {
      // The server does not have this word: there is nothing to delete
      // there, so the intent is done.
      entry.cloudId = "gone";
    }
  }
  return [];
}

/**
 * Sends the word deletes that have not reached the server yet.
 *
 * A delete the server confirms is done. A delete the server refuses
 * because the word is not there any more is done too. Everything else -
 * offline, a server error, a dead session - keeps the intent, and the next
 * sync tries again.
 */
async function flushPendingVocabDeletes(session, pending, tombstones) {
  const remaining = [];
  // A word whose server id is unknown gets its id looked up first: without
  // it the delete would be dropped and the word would come back.
  const unresolved = await findMissingVocabCloudIds(session, pending);
  for (const entry of pending) {
    if (entry.cloudId === "gone") {
      // The server never had this word: the intent has done its job.
      tombstones.delete(entry.key);
      continue;
    }
    if (unresolved.includes(entry)) {
      // The id could not be looked up - the network is down or the server
      // is unwell. The delete cannot be sent, but the intent stays, so the
      // next sync tries again. Dropping it here would bring the word back.
      remaining.push(entry);
      continue;
    }
    try {
      await cloudFetch("/api/vocabulary/" + encodeURIComponent(entry.cloudId), {
        method: "DELETE",
        token: session.token,
      });
    } catch (error) {
      if (!isAlreadyGoneError(error)) {
        reportSyncSessionExpired(error);
        console.warn(
          "[YouTube Digest] Pending word delete failed (it is sent again on the next sync):",
          error.message,
        );
        remaining.push(entry);
        continue;
      }
    }
    // Confirmed, or already gone: the intent has done its job.
    tombstones.delete(entry.key);
  }
  const stored = await readPendingVocabDeletes(session.githubId);
  if (!samePendingVocabDeletes(stored, remaining)) {
    await writePendingVocabDeletes(session.githubId, remaining);
  }
}

async function handleDeleteVocabulary(id) {
  try {
    const namespace = await vocabularyNamespace();
    const { items, target } = await withNamespaceLock(namespace, async () => {
      const stored = await readLocalVocabulary(namespace);
      return {
        items: stored,
        target: stored.find((item) => item.id === id),
      };
    });
    const session = await getGithubSession();
    const wordKey = target ? vocabKey(target) : "";
    try {
      if (session && target && wordKey) {
        // The intent is recorded BEFORE the word leaves the device: a
        // worker that dies in between must not lose the delete.
        const pending = await readPendingVocabDeletes(session.githubId);
        if (!pending.some((entry) => entry.key === wordKey)) {
          pending.push({
            key: wordKey,
            term: String(target.term || ""),
            sentence: String(target.sentence || ""),
            cloudId: String(target.cloudId || ""),
            deletedAt: Date.now(),
          });
          await writePendingVocabDeletes(session.githubId, pending);
        }
      }
      // The word disappears from this device now, whether or not the
      // network is up. The list is read again here: a word saved while the
      // intent was being recorded must not be thrown away with it.
      await withNamespaceLock(namespace, async () => {
        const current = await readLocalVocabulary(namespace);
        const remaining = current.filter((item) => item.id !== id);
        await writeLocalVocabulary(namespace, remaining);
      });
    } catch (error) {
      // The word is still on the device, so the delete did not happen: the
      // intent is taken back, otherwise the next sync would delete a word
      // the user still sees.
      if (session && target && wordKey) {
        await removePendingVocabDelete(session.githubId, wordKey);
      }
      return { success: false, error: error.message, code: error.code };
    }

    if (session && target && wordKey) {
      if (!target.cloudId) {
        // This device never learned the server's id for the word, so the
        // delete cannot be addressed. The server may still have the word -
        // another device pushed it - so the intent stays: the next sync
        // looks the id up in the server's own list and deletes the word
        // there. Dropping the intent here would bring the word back.
        return { success: true };
      }
      try {
        await cloudFetch("/api/vocabulary/" + encodeURIComponent(target.cloudId), {
          method: "DELETE",
          token: session.token,
        });
        // The server confirmed the delete: the intent has done its job.
        await removePendingVocabDelete(session.githubId, wordKey);
      } catch (error) {
        if (isAlreadyGoneError(error)) {
          // The server does not know the word: there is nothing left to
          // delete, so the intent is done.
          await removePendingVocabDelete(session.githubId, wordKey);
        } else {
          // The intent stays on the list and is sent again by the next
          // sync. Until then the word is kept out of the merge, so it
          // cannot come back.
          reportSyncSessionExpired(error);
          console.warn(
            "[YouTube Digest] Word cloud delete failed (it is sent again on the next sync):",
            error.message,
          );
        }
      }
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Review requires the cloud (scheduling lives server-side).
 */
async function handleGetDueReviews() {
  const session = await getGithubSession();
  if (!session) return { success: false, error: "NO_SESSION", message: "Sign in to review your vocabulary." };
  try {
    const data = await cloudFetch("/api/reviews/due", { token: session.token });
    return { success: true, reviews: data && data.reviews ? data.reviews : [] };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleSubmitReview(vocabId, grade) {
  const session = await getGithubSession();
  if (!session) return { success: false, error: "NO_SESSION", message: "Sign in to review your vocabulary." };
  try {
    const data = await cloudFetch("/api/reviews/" + encodeURIComponent(vocabId), {
      method: "POST",
      token: session.token,
      body: { grade: Number(grade) },
    });
    // Keep the local status badge in sync with the scheduler result:
    // an item with a multi-day interval has graduated past "learning".
    if (data && data.review && typeof data.review.intervalDays === "number") {
      const nextStatus =
        data.review.intervalDays >= 7
          ? "mastered"
          : data.review.intervalDays >= 1
            ? "reviewing"
            : "learning";
      await updateLocalVocabularyStatus(nextStatus, vocabId);
    }
    return { success: true, review: data.review };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function updateLocalVocabularyStatus(status, cloudId) {
  try {
    const namespace = await vocabularyNamespace();
    const items = await readLocalVocabulary(namespace);
    const target = items.find((item) => item.cloudId === cloudId);
    if (!target || target.status === status) return;
    target.status = status;
    target.updatedAt = Date.now();
    await writeLocalVocabulary(namespace, items);
  } catch (error) {
    console.warn("[YouTube Digest] Local vocabulary status update failed:", error.message);
  }
}


/**
 * Storage key for the record of which account owns which note from the
 * signed-out bucket.
 *
 * The bucket is cleared as soon as it is imported, so a failed upload can
 * never leave it behind for the next account to inherit. This record is the
 * safety net for the case where that clear did not happen (a storage
 * error, an interrupted write): those notes are already spoken for and
 * must not be imported by a second account.
 */
const NOTES_CLAIM_KEY = "ytd_notes_claim";

/**
 * Reads the claim record: which account owns which note id.
 *
 * @returns {Promise<Record<string, string>>} note id -> account id.
 */
async function readNotesClaim() {
  try {
    const result = await chrome.storage.local.get(NOTES_CLAIM_KEY);
    const claim = result[NOTES_CLAIM_KEY];
    if (!claim || typeof claim !== "object" || !claim.ids) return {};
    const owners = {};
    for (const [id, owner] of Object.entries(claim.ids)) {
      owners[String(id)] = String(owner);
    }
    return owners;
  } catch (error) {
    return {};
  }
}

async function writeNotesClaim(owners) {
  try {
    await setStorageWithRecovery({ [NOTES_CLAIM_KEY]: { ids: owners } });
    return true;
  } catch (error) {
    // The claim is the safety net that keeps another account from picking
    // the notes up, so a failed write has to be reported: the caller keeps
    // the source copy instead of deleting it.
    return false;
  }
}

/**
 * Imports the notes that were saved while signed out into the account that
 * is signing in now.
 *
 * Two rules make the import safe:
 * - A note belongs to exactly one account. Once a note has been handed to
 *   an account it is never handed to another one, so a failed sync cannot
 *   make another learner inherit notes that were written under a different
 *   account. The account that owns a note can always import it again, so a
 *   retry never loses it.
 * - The signed-out bucket is cleared of the notes that were imported, not
 *   deleted wholesale. A note that belongs to another account stays where
 *   it is: deleting the bucket took those notes with it, and a note that is
 *   gone from the device is a note that is gone for good.
 *
 * The order of the steps is what makes the import survive an interruption:
 * the ownership is recorded first, then the notes are copied, and only then
 * are the moved ones removed from the signed-out bucket.
 *
 * @param {string|number} githubId the account that is signing in.
 * @returns {Promise<number>} how many notes were imported.
 */
async function migrateLegacyLocalNotes(githubId) {
  const accountId = String(githubId || "").trim();
  if (!accountId) return 0;
  return migrateLegacyBucket({
    accountId,
    label: "notes",
    bucketKey: YTD_SETTINGS.NOTES_STORAGE_KEY,
    namespaceKeyFor: YTD_SETTINGS.notesStorageKey,
    readClaim: readNotesClaim,
    writeClaim: writeNotesClaim,
    readBucket: readLocalNotes,
    writeBucket: writeLocalNotes,
  });
}

/**
 * The interface language the user picked in the settings.
 *
 * The sign-in page greets the user after GitHub, so it has to speak their
 * language. A missing, empty or broken value falls back to English.
 */
async function readInterfaceLanguage() {
  const key =
    (typeof YTD_SETTINGS !== "undefined" &&
      YTD_SETTINGS.UI_LANGUAGE_STORAGE_KEY) ||
    "ytd_options_language";
  try {
    const stored = await chrome.storage.local.get(key);
    const language = String((stored && stored[key]) || "").trim();
    return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  } catch (error) {
    return "en";
  }
}

/**
 * Opens the OAuth login tab. The completion redirect is caught by the
 * persistent tabs.onUpdated listener registered at the bottom of this file.
 *
 * A dead token is dropped first: without this the "already signed in" shortcut
 * below would swallow the click, and the re-login chip would be a silent
 * no-op -- the exact failure this state exists to expose. The account's local
 * notes are namespaced by GitHub id and untouched, so re-authenticating loses
 * nothing.
 */
async function handleStartGithubLogin() {
  const session = await getGithubSession();
  if (session && !(await isSyncSessionExpiredForAccount())) {
    return { success: true, alreadySignedIn: true };
  }
  if (session) {
    await chrome.storage.local.remove(YTD_SETTINGS.GITHUB_SESSION_KEY);
    await chrome.storage.local.remove(YTD_SETTINGS.SYNC_EXPIRED_KEY);
  }
  // The sign-in page speaks the interface language the user picked, so the
  // page after GitHub does not greet a Chinese reader in English.
  const language = await readInterfaceLanguage();
  // The nonce ties the sign-in to this device. The sync service hands it
  // back with the token, and a token that arrives without it is refused:
  // a link carrying somebody else's token would otherwise switch the user
  // to that account and hand it the notes saved here.
  const nonce = await startPendingLogin();
  const loginUrl = YTD_SETTINGS.buildGithubLoginUrl(
    language,
    YTD_SETTINGS.SERVER_BASE_URL,
    nonce,
  );
  const tab = await chrome.tabs.create({ url: loginUrl });
  return { success: true, tabId: tab.id, replacedExpiredSession: !!session };
}

/**
 * Remembers the nonce of the sign-in this device is about to start.
 *
 * The nonce lives in the session store: it is only needed until the
 * sign-in finishes, and it must not survive the browser closing.
 */
async function startPendingLogin() {
  const nonce = YTD_SETTINGS.createLoginNonce();
  const store = chrome.storage.session || chrome.storage.local;
  try {
    await store.set({ [YTD_SETTINGS.PENDING_LOGIN_NONCE_KEY]: nonce });
  } catch (error) {
    // Without a stored nonce the sign-in cannot be completed safely, so
    // there is nothing to start.
    return "";
  }
  return nonce;
}

/**
 * Checks the nonce of a finished sign-in against the one this device asked
 * for, and spends it.
 *
 * A sign-in without the matching nonce is not ours: it is a link somebody
 * made, and accepting it would sign the user into somebody else's account.
 * A nonce that does not match is left alone, so the real sign-in can still
 * finish.
 */
async function consumePendingLoginNonce(received) {
  const store = chrome.storage.session || chrome.storage.local;
  let expected = "";
  try {
    const stored = await store.get(YTD_SETTINGS.PENDING_LOGIN_NONCE_KEY);
    expected = String(
      (stored && stored[YTD_SETTINGS.PENDING_LOGIN_NONCE_KEY]) || "",
    );
  } catch (error) {
    return false;
  }
  if (!expected || !received || expected !== received) return false;
  try {
    await store.remove(YTD_SETTINGS.PENDING_LOGIN_NONCE_KEY);
  } catch (error) {
    // The nonce stays, but it can only be used once the sign-in matches.
  }
  return true;
}

/**
 * Completes login when the OAuth redirect lands on /auth/complete#access_token=...
 * Validates the token against /api/me, stores the session (never the token in
 * UI-visible surfaces), syncs the account's notes, and closes the login tab.
 */
async function completeGithubLogin(token, tabId, nonce) {
  try {
    // A token is only ours when it carries the nonce of the sign-in this
    // device started. Without this check, any link with a token in it would
    // sign the user into another account and move their notes there.
    if (!(await consumePendingLoginNonce(nonce))) {
      console.warn(
        "[YouTube Digest] A sign-in without the matching nonce was ignored.",
      );
      return { success: false, error: "This sign-in did not come from the extension." };
    }
    const data = await cloudFetch("/api/me", { token });
    const user = data && data.user;
    if (!user) throw new Error("GitHub profile unavailable");
    await setStorageWithRecovery({
      [YTD_SETTINGS.GITHUB_SESSION_KEY]: {
        token,
        login: user.login,
        githubId: user.githubId,
        savedAt: Date.now(),
      },
    });
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
    // A fresh token is live: drop the stale-expiry latch before the first sync
    // so the panel does not briefly render the re-login chip.
    await clearSyncSessionExpired();
    // Import notes saved before sign-in, then mirror everything to the cloud.
    // The import claims the notes, copies them into the account namespace
    // and only then clears the moved ones from the signed-out bucket, so an
    // interrupted import leaves them somewhere they can still be found. A
    // failed import must not undo the sign-in: the session is already
    // stored, and the notes stay in the bucket for the next sign-in.
    try {
      await migrateLegacyLocalNotes(user.githubId);
    } catch (error) {
      console.warn(
        "[YouTube Digest] The notes saved before sign-in could not be imported yet:",
        error.message,
      );
    }
    const sync = await fullSyncNotes();
    // The words follow the same road as the notes: they are imported into
    // the account namespace first, so a failed upload keeps them on the
    // device and out of reach of the next account, and then they are
    // mirrored to the cloud. A word that stays on the device only is a word
    // that is lost with the device, so this is not optional.
    try {
      await migrateLegacyLocalVocabulary(user.githubId);
      await fullSyncVocabulary();
    } catch (error) {
      console.warn(
        "[YouTube Digest] The words could not be uploaded yet:",
        error.message,
      );
    }
    chrome.runtime
      .sendMessage({ action: "githubLoginChanged", login: user.login, sync })
      .catch(() => {});
    return sync;
  } catch (error) {
    console.warn("[YouTube Digest] Login completion failed:", error.message);
    chrome.runtime
      .sendMessage({ action: "githubLoginFailed", error: error.message })
      .catch(() => {});
    // The code travels with the message so a surface can tell a slow
    // server from a dead session and say the right thing.
    return { success: false, error: error.message, code: error.code };
  }
}


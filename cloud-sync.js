/**
 * Cloud sync layer (GitHub account): notes + vocabulary + reviews.
 * Loaded by background.js via importScripts AFTER settings.js. Relies on
 * the global YTD_SETTINGS for the server base URL and session key; never
 * touches AI code, so the AI-dependent vocabulary extractor stays in
 * background.js.
 */

async function saveNoteToStorage(note) {
  const namespace = await notesNamespace();
  const result = await chrome.storage.local.get(namespace);
  const notes = result[namespace] || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ [namespace]: notes });

  // Cloud mirror: best-effort, never blocks the local save.
  const session = await getGithubSession();
  if (session) {
    await pushNoteToCloud(session, note).catch((error) => {
      console.warn("[YouTube Digest] Note cloud sync failed:", error.message);
    });
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
    const notes = await readLocalNotes(namespace);
    const note = notes.find((candidate) => candidate.id === noteId);
    if (!note) return { success: false, error: "Note not found" };
    note.text = cleanText;
    note.rawText = cleanText;
    note.updatedAt = Date.now();
    await writeLocalNotes(namespace, notes);
    const session = await getGithubSession();
    if (session) {
      try {
        if (note.cloudId) {
          await cloudFetch("/api/notes/" + encodeURIComponent(note.cloudId), {
            method: "PATCH",
            token: session.token,
            body: localNoteToCloudPayload(note),
          });
        } else {
          const pushed = await pushNoteToCloud(session, note);
          const cloudId = pushed && pushed.note && pushed.note.id;
          if (cloudId) {
            note.cloudId = cloudId;
            await writeLocalNotes(namespace, notes);
          }
        }
      } catch (error) {
        console.warn("[YouTube Digest] Note update cloud sync failed:", error.message);
      }
    }
    return { success: true, note };
  } catch (error) {
    return { success: false, error: error.message };
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
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note locally (account-namespaced) and from the cloud when signed in
 */
async function handleDeleteNote(noteId) {
  try {
    const namespace = await notesNamespace();
    const result = await chrome.storage.local.get(namespace);
    let notes = result[namespace] || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ [namespace]: notes });

    const session = await getGithubSession();
    if (session) {
      await deleteNoteFromCloud(session, noteId).catch((error) => {
        console.warn("[YouTube Digest] Note cloud delete failed:", error.message);
      });
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// CLOUD SYNC (GitHub account)
// ============================================================

function formatSyncTimestamp(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(safe);
  const minutes = Math.floor(whole / 60);
  const remaining = whole % 60;
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return hours + ":" + String(minutes % 60).padStart(2, "0") + ":" + String(remaining).padStart(2, "0");
  }
  return minutes + ":" + String(remaining).padStart(2, "0");
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
  const response = await fetch(YTD_SETTINGS.SERVER_BASE_URL + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error((data && data.error) || "Sync request failed: " + response.status);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function notesNamespace() {
  const session = await getGithubSession();
  return session ? "ytd_notes_" + session.githubId : "ytd_notes";
}

async function readLocalNotes(namespace) {
  const result = await chrome.storage.local.get(namespace);
  return result[namespace] || [];
}

async function writeLocalNotes(namespace, notes) {
  await chrome.storage.local.set({ [namespace]: notes });
}

function localNoteToCloudPayload(note) {
  return {
    clientId: String(note.id || ""),
    note: String(note.text || ""),
    videoId: String(note.videoId || ""),
    videoTitle: String(note.videoTitle || ""),
    channelName: String(note.channelName || ""),
    timestampSeconds: Number(note.timestampSeconds) || 0,
    quote: String(note.text || "").slice(0, 3000),
  };
}

function cloudToLocalNote(cloud) {
  const seconds = Number(cloud.timestampSeconds) || 0;
  const createdMs = new Date(cloud.createdAt).getTime();
  const updatedMs = new Date(cloud.updatedAt).getTime();
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
    createdAt: Number.isFinite(createdMs) ? createdMs : Date.now(),
    updatedAt: Number.isFinite(updatedMs) ? updatedMs : Date.now(),
    cloudId: String(cloud.id || ""),
  };
}

/**
 * Generic collection merge shared by notes and vocabulary. Semantics:
 * - Cloud rows come down; on a conflict the newest edit wins.
 * - Local rows that were never synced (no cloudId yet) are kept and queued
 *   for push.
 * - Local rows that were synced before but are missing from the cloud were
 *   deleted elsewhere (e.g. from the web dashboard), so they are dropped
 *   locally too; without this, deletions would resurrect on the next sync.
 */
function mergeCollectionsForSync(localItems, cloudItems, { keyOfLocal, keyOfCloud, toLocal }) {
  const cloudByKey = new Map();
  for (const cloud of cloudItems || []) {
    const key = keyOfCloud(cloud);
    if (key) cloudByKey.set(key, cloud);
  }
  const merged = new Map();
  for (const local of localItems || []) {
    const key = keyOfLocal(local);
    if (!key) continue;
    const cloud = cloudByKey.get(key);
    if (cloud) {
      const cloudMs = new Date(cloud.updatedAt).getTime();
      const localMs = Number(local.updatedAt) || Number(local.createdAt) || 0;
      const cloudNewer = cloudMs > localMs;
      merged.set(key, {
        source: cloudNewer ? "cloud" : "local",
        item: cloudNewer ? cloud : local,
        updatedAt: Math.max(cloudMs, localMs),
      });
    } else if (!local.cloudId) {
      // Never synced: brand-new local item, keep and push.
      merged.set(key, {
        source: "local",
        item: local,
        updatedAt: Number(local.updatedAt) || Number(local.createdAt) || 0,
      });
    }
    // else: synced before but missing from the cloud -> deleted elsewhere.
  }
  for (const cloud of cloudByKey.values()) {
    const key = keyOfCloud(cloud);
    if (!merged.has(key)) {
      merged.set(key, { source: "cloud", item: cloud, updatedAt: new Date(cloud.updatedAt).getTime() });
    }
  }
  const mergedItems = [];
  const toPush = [];
  for (const entry of merged.values()) {
    mergedItems.push(entry.source === "cloud" ? toLocal(entry.item) : entry.item);
    if (entry.source === "local") toPush.push(entry.item);
  }
  return { mergedItems, toPush };
}

function mergeNotesForSync(localNotes, cloudNotes) {
  const result = mergeCollectionsForSync(localNotes, cloudNotes, {
    keyOfLocal: (item) => (item && item.id ? String(item.id) : ""),
    keyOfCloud: (item) => (item && item.clientId ? String(item.clientId) : ""),
    toLocal: cloudToLocalNote,
  });
  return { mergedNotes: result.mergedItems, toPush: result.toPush };
}

async function pushNoteToCloud(session, note) {
  return cloudFetch("/api/notes", {
    method: "POST",
    token: session.token,
    body: localNoteToCloudPayload(note),
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
  keyOfCloud,
  toLocal,
  toCloudPayload,
  cloudIdOf,
  readLocal,
  writeLocal,
}) {
  const session = await getGithubSession();
  if (!session) return { success: true, synced: false, reason: "not signed in" };
  const namespace = namespaceFor(session);
  const local = await readLocal(namespace);
  let cloud = [];
  try {
    const data = await cloudFetch(fetchPath, { token: session.token });
    cloud = data && (data.notes || data.vocabulary) ? data.notes || data.vocabulary : [];
  } catch (error) {
    return { success: false, error: error.message };
  }
  const { mergedItems, toPush } = mergeCollectionsForSync(local, cloud, {
    keyOfLocal,
    keyOfCloud,
    toLocal,
  });
  for (const item of toPush) {
    try {
      const pushed = await cloudFetch(pushPath, {
        method: "POST",
        token: session.token,
        body: toCloudPayload(item),
      });
      const cloudId = cloudIdOf(pushed);
      if (cloudId) {
        // Remember the server id so future merges treat it as synced and
        // deletions elsewhere propagate instead of resurrecting.
        const target = mergedItems.find((candidate) => keyOfLocal(candidate) === keyOfLocal(item));
        if (target) target.cloudId = cloudId;
      }
    } catch (error) {
      console.warn("[YouTube Digest] Sync push failed (kept locally):", error.message);
    }
  }
  await writeLocal(namespace, mergedItems);
  return { success: true, synced: true, count: mergedItems.length };
}

async function fullSyncNotes() {
  return runFullSync({
    namespaceFor: (session) => "ytd_notes_" + session.githubId,
    fetchPath: "/api/notes",
    pushPath: "/api/notes",
    keyOfLocal: (item) => (item && item.id ? String(item.id) : ""),
    keyOfCloud: (item) => (item && item.clientId ? String(item.clientId) : ""),
    toLocal: cloudToLocalNote,
    toCloudPayload: localNoteToCloudPayload,
    cloudIdOf: (pushed) => pushed && pushed.note && pushed.note.id,
    readLocal: readLocalNotes,
    writeLocal: writeLocalNotes,
  });
}

async function handleGetGithubSession() {
  const session = await getGithubSession();
  return {
    success: true,
    session: session
      ? { login: session.login, githubId: session.githubId, savedAt: session.savedAt }
      : null,
  };
}

async function handleLogoutGithub() {
  await chrome.storage.local.remove(YTD_SETTINGS.GITHUB_SESSION_KEY);
  return { success: true };
}
// ============================================================
// VOCABULARY + REVIEWS
// ============================================================

async function vocabularyNamespace() {
  const session = await getGithubSession();
  return session ? "ytd_vocabulary_" + session.githubId : "ytd_vocabulary";
}

async function readLocalVocabulary(namespace) {
  const result = await chrome.storage.local.get(namespace);
  return result[namespace] || [];
}

async function writeLocalVocabulary(namespace, items) {
  await chrome.storage.local.set({ [namespace]: items });
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
 * Pure merge for vocabulary, mirroring the notes strategy: cloud is the
 * source of truth, brand-new local items (no cloudId) are pushed, and
 * previously synced items missing from the cloud are dropped locally.
 */
function mergeVocabularyForSync(localItems, cloudItems) {
  const cloudByKey = new Map();
  for (const cloud of cloudItems || []) {
    if (cloud && cloud.term) cloudByKey.set(vocabKey(cloud), cloud);
  }
  const merged = new Map();
  for (const local of localItems || []) {
    if (!local || !local.term) continue;
    const key = vocabKey(local);
    const cloud = cloudByKey.get(key);
    if (cloud) {
      merged.set(key, cloudVocabToLocal(cloud));
    } else if (!local.cloudId) {
      merged.set(key, local);
    }
  }
  for (const cloud of cloudByKey.values()) {
    if (!merged.has(vocabKey(cloud))) {
      merged.set(vocabKey(cloud), cloudVocabToLocal(cloud));
    }
  }
  const localResult = [];
  const toPush = [];
  for (const entry of merged.values()) {
    localResult.push(entry);
    if (!entry.cloudId) toPush.push(entry);
  }
  return { mergedItems: localResult, toPush };
}

async function fullSyncVocabulary() {
  return runFullSync({
    namespaceFor: (session) => "ytd_vocabulary_" + session.githubId,
    fetchPath: "/api/vocabulary",
    pushPath: "/api/vocabulary",
    keyOfLocal: vocabKey,
    keyOfCloud: vocabKey,
    toLocal: cloudVocabToLocal,
    toCloudPayload: localVocabToCloudPayload,
    cloudIdOf: (pushed) => pushed && pushed.vocabulary && pushed.vocabulary.id,
    readLocal: readLocalVocabulary,
    writeLocal: writeLocalVocabulary,
  });
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
    const items = await readLocalVocabulary(namespace);
    const existingIndex = items.findIndex(
      (item) => vocabKey(item) === term + "|" + sentence,
    );
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
    if (items.length > 500) items.splice(500);
    await writeLocalVocabulary(namespace, items);
    const session = await getGithubSession();
    if (session) {
      try {
        const pushed = await cloudFetch("/api/vocabulary", {
          method: "POST",
          token: session.token,
          body: localVocabToCloudPayload(item),
        });
        item.cloudId = (pushed && pushed.vocabulary && pushed.vocabulary.id) || item.cloudId;
        await writeLocalVocabulary(namespace, items);
      } catch (error) {
        console.warn("[YouTube Digest] Vocabulary cloud save failed:", error.message);
      }
    }
    return { success: true, item };
  } catch (error) {
    return { success: false, error: error.message };
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

async function handleDeleteVocabulary(id) {
  try {
    const namespace = await vocabularyNamespace();
    const items = await readLocalVocabulary(namespace);
    const target = items.find((item) => item.id === id);
    const remaining = items.filter((item) => item.id !== id);
    await writeLocalVocabulary(namespace, remaining);
    const session = await getGithubSession();
    if (session && target && target.cloudId) {
      await cloudFetch("/api/vocabulary/" + encodeURIComponent(target.cloudId), {
        method: "DELETE",
        token: session.token,
      }).catch((error) => {
        console.warn("[YouTube Digest] Vocabulary cloud delete failed:", error.message);
      });
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
 * One-time migration of the signed-out local notes into the account's
 * namespace (copied, never moved) so existing notes appear after login.
 * The signed-out copy is removed only after a successful full sync, so a
 * failed sync can never lose data; the id-based dedupe keeps re-logins
 * from importing the same note twice.
 */
async function migrateLegacyLocalNotes(githubId) {
  const legacy = await readLocalNotes("ytd_notes");
  if (!Array.isArray(legacy) || legacy.length === 0) return 0;
  const namespace = "ytd_notes_" + githubId;
  const current = await readLocalNotes(namespace);
  const byId = new Map(current.map((note) => [String(note.id), note]));
  let added = 0;
  for (const note of legacy) {
    if (note && note.id && !byId.has(String(note.id))) {
      byId.set(String(note.id), note);
      added += 1;
    }
  }
  if (added > 0) await writeLocalNotes(namespace, [...byId.values()]);
  return added;
}

/**
 * Opens the OAuth login tab. The completion redirect is caught by the
 * persistent tabs.onUpdated listener registered at the bottom of this file.
 */
async function handleStartGithubLogin() {
  const session = await getGithubSession();
  if (session) return { success: true, alreadySignedIn: true };
  const loginUrl = YTD_SETTINGS.SERVER_BASE_URL + "/api/auth/login";
  const tab = await chrome.tabs.create({ url: loginUrl });
  return { success: true, tabId: tab.id };
}

/**
 * Completes login when the OAuth redirect lands on /auth/complete#access_token=...
 * Validates the token against /api/me, stores the session (never the token in
 * UI-visible surfaces), syncs the account's notes, and closes the login tab.
 */
async function completeGithubLogin(token, tabId) {
  try {
    const data = await cloudFetch("/api/me", { token });
    const user = data && data.user;
    if (!user) throw new Error("GitHub profile unavailable");
    await chrome.storage.local.set({
      [YTD_SETTINGS.GITHUB_SESSION_KEY]: {
        token,
        login: user.login,
        githubId: user.githubId,
        savedAt: Date.now(),
      },
    });
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
    // Import notes saved before sign-in, then mirror everything to the cloud.
    // The signed-out copy is cleared only after the sync succeeded.
    const migrated = await migrateLegacyLocalNotes(user.githubId);
    const sync = await fullSyncNotes();
    if (sync.success && migrated > 0) {
      await chrome.storage.local.remove("ytd_notes");
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
    return { success: false, error: error.message };
  }
}


/* YouTube Digest dashboard: GitHub sign-in + notes / favorites / vocabulary.
   Token lives in localStorage; every API call carries it as Bearer. The
   server scopes all queries by the verified token, so this page can only
   ever read and write the signed-in account's own data. */

(function () {
  const TOKEN_KEY = "ytd_dashboard_token";
  const LOGIN_PATH = "/api/auth/login?redirect=/";
  const STATE = { token: "", user: null, notes: [], vocabulary: [] };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function statusLine(message, isError) {
    const el = $("statusLine");
    el.textContent = message || "";
    el.classList.toggle("error", !!isError);
    if (isError) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ghost-btn";
      retry.textContent = "Retry";
      retry.style.marginLeft = "10px";
      retry.addEventListener("click", () => void boot());
      el.appendChild(retry);
    }
  }

  async function api(path, options) {
    const headers = {};
    if (STATE.token) headers.Authorization = "Bearer " + STATE.token;
    if (options && options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(path, {
      method: (options && options.method) || "GET",
      headers,
      body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const data = await response.json().catch(() => null);
    if (response.status === 401) {
      signOut();
      throw new Error("Session expired. Sign in again.");
    }
    if (!response.ok) {
      throw new Error((data && data.error) || "Request failed (" + response.status + ")");
    }
    return data;
  }

  function formatTimestamp(seconds) {
    const whole = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(whole / 60);
    const remaining = whole % 60;
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
      return hours + ":" + String(minutes % 60).padStart(2, "0") + ":" + String(remaining).padStart(2, "0");
    }
    return minutes + ":" + String(remaining).padStart(2, "0");
  }

  function watchUrl(videoId, seconds) {
    if (!videoId) return "";
    return "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId) + "&t=" + seconds + "s";
  }

  function renderNotes(notes, listId, emptyId, countId) {
    const list = $(listId);
    const empty = $(emptyId);
    $(countId).textContent = notes.length ? String(notes.length) + " note" + (notes.length === 1 ? "" : "s") : "";
    list.innerHTML = "";
    empty.hidden = notes.length > 0;
    for (const note of notes) {
      const card = document.createElement("div");
      card.className = "card";
      const ts = watchUrl(note.videoId, note.timestampSeconds);
      const head = document.createElement("div");
      head.className = "card-head";
      const star = document.createElement("button");
      star.type = "button";
      star.className = "star-btn" + (note.starred ? " on" : "");
      star.textContent = note.starred ? "★" : "☆";
      star.title = note.starred ? "Remove from favorites" : "Add to favorites";
      star.addEventListener("click", () => toggleStar(note));
      const title = document.createElement("span");
      title.className = "card-title";
      title.textContent = note.videoTitle || "Untitled Video";
      const link = document.createElement("a");
      link.className = "ts-link";
      link.href = ts;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = formatTimestamp(note.timestampSeconds);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del-btn";
      del.textContent = "Delete";
      del.addEventListener("click", () => deleteNote(note));
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "del-btn";
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.note || "");
          copy.textContent = "Copied";
          setTimeout(() => {
            copy.textContent = "Copy";
          }, 1500);
        } catch (error) {
          statusLine("Could not copy: " + error.message, true);
        }
      });
      head.append(star, title, link, copy, del);
      const body = document.createElement("div");
      body.className = "card-body";
      body.textContent = note.note || "";
      const meta = document.createElement("div");
      meta.className = "card-meta";
      const videoId = document.createElement("span");
      videoId.textContent = note.videoId || "";
      const saved = document.createElement("span");
      saved.textContent = "Saved " + new Date(note.createdAt).toLocaleString();
      meta.append(videoId, saved);
      card.append(head, body, meta);
      list.appendChild(card);
    }
  }

  function renderVocabulary(rows) {
    const list = $("vocabularyList");
    const empty = $("vocabularyEmpty");
    $("vocabularyCount").textContent = rows.length ? String(rows.length) + " word" + (rows.length === 1 ? "" : "s") : "";
    list.innerHTML = "";
    empty.hidden = rows.length > 0;
    for (const row of rows) {
      const card = document.createElement("div");
      card.className = "card";
      const head = document.createElement("div");
      head.className = "card-head";
      const term = document.createElement("span");
      term.className = "vocab-term";
      term.textContent = row.term;
      const status = document.createElement("select");
      status.className = "status-select";
      for (const option of ["learning", "reviewing", "mastered"]) {
        const el = document.createElement("option");
        el.value = option;
        el.textContent = option;
        el.selected = row.status === option;
        status.appendChild(el);
      }
      status.addEventListener("change", () => setVocabStatus(row, status.value));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del-btn";
      del.textContent = "Delete";
      del.addEventListener("click", () => deleteVocabularyEntry(row));
      const video = document.createElement("a");
      video.className = "ts-link";
      video.href = watchUrl(row.videoId, row.timestampSeconds);
      video.target = "_blank";
      video.rel = "noreferrer";
      video.textContent = row.videoTitle || row.videoId || "";
      head.append(term, status, video, del);
      const translation = document.createElement("div");
      translation.className = "vocab-translation";
      translation.textContent = row.translation || "";
      const sentence = document.createElement("div");
      sentence.className = "vocab-sentence";
      sentence.textContent = row.sentence || "";
      const meta = document.createElement("div");
      meta.className = "card-meta";
      meta.textContent = "Saved " + new Date(row.createdAt).toLocaleString();
      card.append(head, translation, sentence, meta);
      list.appendChild(card);
    }
  }

  async function toggleStar(note) {
    try {
      const data = await api("/api/notes/" + note.id + "/star", {
        method: "PATCH",
        body: { starred: !note.starred },
      });
      note.starred = data.note.starred;
      renderAll();
    } catch (error) {
      statusLine(error.message, true);
    }
  }

  async function deleteNote(note) {
    if (!confirm("Delete this note?")) return;
    try {
      await api("/api/notes/" + note.id, { method: "DELETE" });
      STATE.notes = STATE.notes.filter((item) => item.id !== note.id);
      renderAll();
    } catch (error) {
      statusLine(error.message, true);
    }
  }

  async function deleteVocabularyEntry(row) {
    if (!confirm("Delete this word and its review history?")) return;
    try {
      await api("/api/vocabulary/" + row.id, { method: "DELETE" });
      STATE.vocabulary = STATE.vocabulary.filter((item) => item.id !== row.id);
      renderAll();
    } catch (error) {
      statusLine(error.message, true);
    }
  }

  async function setVocabStatus(row, status) {
    try {
      const data = await api("/api/vocabulary/" + row.id, {
        method: "PATCH",
        body: { status },
      });
      row.status = data.vocabulary.status;
      renderAll();
    } catch (error) {
      statusLine(error.message, true);
    }
  }

  const dashReviewState = { queue: [], index: 0, revealed: false };

  async function loadDueReviews() {
    const countEl = $("reviewCount");
    const empty = $("reviewEmpty");
    const card = $("reviewCard");
    const actions = $("dashReviewActions");
    try {
      const data = await api("/api/reviews/due");
      dashReviewState.queue = data.reviews || [];
      dashReviewState.index = 0;
      dashReviewState.revealed = false;
      countEl.textContent = dashReviewState.queue.length
        ? String(dashReviewState.queue.length) + " due"
        : "";
      empty.hidden = dashReviewState.queue.length > 0;
      card.hidden = dashReviewState.queue.length === 0;
      actions.hidden = dashReviewState.queue.length === 0;
      $("dashReviewProgress").textContent = "";
      if (dashReviewState.queue.length) renderDashReviewCard();
    } catch (error) {
      statusLine(error.message, true);
    }
  }

  function renderDashReviewCard() {
    const review = dashReviewState.queue[dashReviewState.index];
    if (!review) {
      void loadDueReviews();
      return;
    }
    dashReviewState.revealed = false;
    $("dashReviewTerm").textContent = review.vocabulary.term;
    $("dashReviewSentence").textContent = review.vocabulary.sentence || "";
    $("dashReviewTranslation").textContent = review.vocabulary.translation || "";
    $("dashReviewExplanation").textContent = review.vocabulary.sentenceTranslation || "";
    $("dashReviewTranslation").hidden = true;
    $("dashReviewExplanation").hidden = true;
    $("dashReviewProgress").textContent =
      "Card " + (dashReviewState.index + 1) + " of " + dashReviewState.queue.length;
  }

  async function submitDashReview(grade) {
    const review = dashReviewState.queue[dashReviewState.index];
    if (!review) return;
    try {
      await api("/api/reviews/" + review.vocabulary.id, {
        method: "POST",
        body: { grade },
      });
      dashReviewState.index += 1;
      renderDashReviewCard();
    } catch (error) {
      statusLine(error.message, true);
    }
  }

  function renderAll() {
    const favorites = STATE.notes.filter((note) => note.starred);
    renderNotes(STATE.notes, "notesList", "notesEmpty", "notesCount");
    renderNotes(favorites, "favoritesList", "favoritesEmpty", "favoritesCount");
    renderVocabulary(STATE.vocabulary);
  }

  async function loadAll(silent) {
    if (!silent) statusLine("Loading your data…");
    try {
      const [notesData, vocabData] = await Promise.all([
        api("/api/notes"),
        api("/api/vocabulary"),
      ]);
      STATE.notes = notesData.notes || [];
      STATE.vocabulary = vocabData.vocabulary || [];
      renderAll();
      if (!silent) statusLine("");
    } catch (error) {
      if (!silent) statusLine(error.message, true);
    }
  }

  function showSignedIn(user) {
    $("loginBtn").hidden = true;
    $("userChip").hidden = false;
    $("userName").textContent = user.login;
    $("signedOut").hidden = true;
    $("tabsNav").hidden = false;
    $("notesPanel").hidden = false;
    $("favoritesPanel").hidden = false;
    $("vocabularyPanel").hidden = false;
    $("reviewPanel").hidden = false;
    $("footer").hidden = false;
    void loadDueReviews();
  }

  function showSignedOut() {
    $("loginBtn").hidden = false;
    $("userChip").hidden = true;
    $("signedOut").hidden = false;
    $("tabsNav").hidden = true;
    $("notesPanel").hidden = true;
    $("favoritesPanel").hidden = true;
    $("vocabularyPanel").hidden = true;
    $("reviewPanel").hidden = true;
    $("footer").hidden = true;
  }

  function signOut() {
    localStorage.removeItem(TOKEN_KEY);
    STATE.token = "";
    STATE.user = null;
    showSignedOut();
  }

  function switchTab(tab) {
    document.querySelectorAll(".tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === tab);
    });
    $("notesPanel").hidden = tab !== "notes";
    $("favoritesPanel").hidden = tab !== "favorites";
    $("vocabularyPanel").hidden = tab !== "vocabulary";
    $("reviewPanel").hidden = tab !== "review";
    // Refresh the visible data when switching tabs so edits made elsewhere
    // (e.g. in the extension) show up without a manual reload.
    if (tab === "review") {
      void loadDueReviews();
    } else {
      void loadAll(true);
    }
  }

  async function boot() {
    // OAuth completes with #access_token=... on this page.
    const match = location.hash.match(/access_token=([^&]+)/);
    if (match) {
      localStorage.setItem(TOKEN_KEY, decodeURIComponent(match[1]));
      history.replaceState(null, "", location.pathname);
    }
    STATE.token = localStorage.getItem(TOKEN_KEY) || "";
    if (!STATE.token) {
      showSignedOut();
      return;
    }
    try {
      const me = await api("/api/me");
      STATE.user = me.user;
      showSignedIn(me.user);
      await loadAll();
    } catch (error) {
      showSignedOut();
      statusLine(error.message, true);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("refreshBtn").addEventListener("click", () => {
      void loadAll();
      void loadDueReviews();
      statusLine("Refreshed.");
      setTimeout(() => statusLine(""), 1200);
    });
    // Coming back to this tab refreshes data from the cloud.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && STATE.token) void loadAll(true);
    });
    $("logoutBtn").addEventListener("click", () => {
      signOut();
      statusLine("Signed out. Your data stays in your account.");
    });
    $("exportBtn").addEventListener("click", async () => {
      try {
        const data = await api("/api/export");
        const blob = new Blob([JSON.stringify(data, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "youtube-digest-export-" + new Date().toISOString().slice(0, 10) + ".json";
        link.click();
        URL.revokeObjectURL(url);
        statusLine("Export downloaded.");
        setTimeout(() => statusLine(""), 2000);
      } catch (error) {
        statusLine(error.message, true);
      }
    });
    $("deleteAccountBtn").addEventListener("click", async () => {
      if (!confirm("Delete your account and ALL notes, words, and review progress? This cannot be undone.")) return;
      if (!confirm("Really delete everything? This is permanent.")) return;
      try {
        await api("/api/account", { method: "DELETE" });
        localStorage.removeItem(TOKEN_KEY);
        STATE.token = "";
        showSignedOut();
        statusLine("Account deleted. Sorry to see you go.");
      } catch (error) {
        statusLine(error.message, true);
      }
    });
    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => switchTab(button.dataset.tab));
    });
    $("reviewCard").addEventListener("click", () => {
      if (dashReviewState.revealed) return;
      dashReviewState.revealed = true;
      $("dashReviewTranslation").hidden = false;
      $("dashReviewExplanation").hidden = false;
    });
    document.querySelectorAll("#dashReviewActions .grade-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        void submitDashReview(Number(btn.dataset.grade));
      });
    });
    void boot();
  });
})();

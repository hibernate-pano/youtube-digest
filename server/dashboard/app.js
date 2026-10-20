/* YouTube Digest dashboard: GitHub sign-in + notes / favorites / vocabulary.
   Token lives in localStorage; every API call carries it as Bearer. The
   server scopes all queries by the verified token, so this page can only
   ever read and write the signed-in account's own data. */

(function () {
  const TOKEN_KEY = "ytd_dashboard_token";
  const LOGIN_PATH = "/api/auth/login?redirect=/";
  const STATE = { token: "", user: null, notes: [], vocabulary: [] };

  // The three learning states a saved word can be in. The label is what the
  // user reads; the value is what the server stores. Showing the raw value
  // ("learning") in a sentence-case UI was the odd one out.
  const VOCAB_STATUSES = [
    { value: "learning", label: "Learning" },
    { value: "reviewing", label: "Reviewing" },
    { value: "mastered", label: "Mastered" },
  ];

  const $ = (id) => document.getElementById(id);

  const STAR_PATH =
    "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.12 2.12 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.597-1.16z";

  // Favouriting is a state, not a colour: the filled/outline difference is drawn
  // by CSS off `.star-btn.on`, so it survives greyscale, forced-colours and low
  // vision instead of relying on the amber hue alone.
  function starIcon() {
    return (
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="' + STAR_PATH + '"></path></svg>'
    );
  }

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
      star.innerHTML = starIcon();
      star.title = note.starred ? "Remove from favorites" : "Add to favorites";
      star.setAttribute("aria-label", star.title);
      star.setAttribute("aria-pressed", note.starred ? "true" : "false");
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
      // The channel tells the user which series a note came from. The video
      // id used to be shown here instead; it is a database key and told the
      // user nothing.
      if (note.channelName) {
        const channel = document.createElement("span");
        channel.textContent = note.channelName;
        meta.appendChild(channel);
      }
      const saved = document.createElement("span");
      saved.textContent = "Saved " + new Date(note.createdAt).toLocaleString();
      meta.appendChild(saved);
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
      for (const option of VOCAB_STATUSES) {
        const el = document.createElement("option");
        el.value = option.value;
        el.textContent = option.label;
        el.selected = row.status === option.value;
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
      // A video id is a database key, not a title. When the title is missing
      // the link still needs a name, so it says what it does.
      video.textContent = row.videoTitle || "Watch the video";
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
    $("reviewCard").setAttribute("aria-expanded", "false");
    $("dashReviewHint").hidden = false;
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
    $("footer").hidden = false;
    // Only the selected tab's panel is shown. Unhiding all four made the tab
    // bar a lie: the page showed Notes, Favorites, Vocabulary and Review
    // stacked under a "Notes" tab that looked selected, and clicking a tab
    // then hid three sections the user had just been reading.
    switchTab("notes", { reload: false });
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

  /**
   * Keeps the tab bar honest: the selected tab says so, and only the
   * selected tab stays in the tab order.
   */
  function syncTabState(tab) {
    document.querySelectorAll(".tab").forEach((button) => {
      const selected = button.dataset.tab === tab;
      button.setAttribute("aria-selected", selected ? "true" : "false");
      button.setAttribute("tabindex", selected ? "0" : "-1");
    });
  }

  /**
   * Moves the roving tab stop to a tab the user arrowed onto. The stop
   * follows the focus, so Tab leaves the tab bar from where the user is
   * looking.
   */
  function moveTabFocus(nextTab) {
    document.querySelectorAll(".tab").forEach((button) => {
      button.setAttribute("tabindex", button === nextTab ? "0" : "-1");
    });
    nextTab.focus();
  }

  /**
   * Arrow keys move between the tabs, the way the ARIA tabs pattern asks
   * for. They move the focus only: the user activates a tab with Enter or
   * Space, like any button.
   */
  function handleTabKeydown(event) {
    const tabs = [...document.querySelectorAll(".tab")];
    const index = tabs.indexOf(event.currentTarget);
    if (index === -1) return;

    let nextIndex = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    }
    if (nextIndex === null) return;

    event.preventDefault();
    moveTabFocus(tabs[nextIndex]);
  }

  function switchTab(tab, options) {
    const reload = !options || options.reload !== false;
    document.querySelectorAll(".tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === tab);
    });
    syncTabState(tab);
    $("notesPanel").hidden = tab !== "notes";
    $("favoritesPanel").hidden = tab !== "favorites";
    $("vocabularyPanel").hidden = tab !== "vocabulary";
    $("reviewPanel").hidden = tab !== "review";
    if (!reload) return;
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
      button.addEventListener("keydown", handleTabKeydown);
    });
    $("reviewCard").addEventListener("click", () => {
      if (dashReviewState.revealed) return;
      dashReviewState.revealed = true;
      $("dashReviewTranslation").hidden = false;
      $("dashReviewExplanation").hidden = false;
      $("reviewCard").setAttribute("aria-expanded", "true");
      $("dashReviewHint").hidden = true;
    });
    document.querySelectorAll("#dashReviewActions .grade-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        void submitDashReview(Number(btn.dataset.grade));
      });
    });
    void boot();
  });
})();

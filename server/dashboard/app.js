/* YouTube Digest dashboard: GitHub sign-in + notes / favorites / vocabulary.
   Token lives in localStorage; every API call carries it as Bearer. The
   server scopes all queries by the verified token, so this page can only
   ever read and write the signed-in account's own data. */

(function () {
  const TOKEN_KEY = "ytd_dashboard_token";
  const LANG_KEY = "ytd_dashboard_lang";
  const LOGIN_PATH = "/api/auth/login?redirect=/";
  // The sign-in is tied to the page that started it. The sync service hands
  // the nonce back with the token, and a token that arrives without the
  // matching nonce is not ours: it would quietly sign the reader into
  // somebody else's account.
  const NONCE_KEY = "ytd_dashboard_login_nonce";
  const STATE = { token: "", user: null, notes: [], vocabulary: [] };

  // The three learning states a saved word can be in. The label is what the
  // user reads; the value is what the server stores. Showing the raw value
  // ("learning") in a sentence-case UI was the odd one out. The label lives
  // in the copy table, so it can be translated.
  const VOCAB_STATUSES = [
    { value: "learning", labelKey: "statusLearning" },
    { value: "reviewing", labelKey: "statusReviewing" },
    { value: "mastered", labelKey: "statusMastered" },
  ];

  // ============================================================
  // DASHBOARD COPY (LOCALIZATION)
  // ============================================================
  // The side panel and the options page already speak the user's language.
  // The dashboard is the one surface a Chinese user meets after signing in
  // to sync their notes, so it speaks it too.
  // English is the fallback for every missing key, so a partial table can
  // never blank out the page.
  const DASHBOARD_COPY = {
    en: {
      pageTitle: "YouTube Digest · My Dashboard",
      brandSubtitle: "My dashboard",
      languageLabel: "Language",
      signIn: "Sign in with GitHub",
      signOut: "Sign out",
      refresh: "Refresh",
      refreshTitle: "Refresh your data",
      tablistLabel: "Dashboard sections",
      tabNotes: "Notes",
      tabFavorites: "Favorites",
      tabVocabulary: "Vocabulary",
      tabReview: "Review",
      notesHeading: "Notes",
      favoritesHeading: "Favorites",
      vocabularyHeading: "Vocabulary",
      reviewHeading: "Review due words",
      notesEmpty:
        "No notes yet. Save one from the extension while watching a video.",
      favoritesEmpty:
        "Nothing starred yet. Star a note in the extension and it is pinned here.",
      vocabularyEmpty:
        "No words saved yet. Save a word in the extension and it appears here.",
      reviewEmpty:
        "Nothing due right now. Saved words come back here on their own schedule.",
      favoritesNote:
        "Starred notes come from the extension: star a note in the side panel and it is pinned here, on every device signed in to the same account.",
      vocabularyNote:
        "Words come from the extension: save a word from its Words tab and it is listed here, ready for review.",
      reviewNote:
        "Review is scheduled on the server: saved words come back here on their own schedule, and the grade you give sets the next one.",
      heroTitle: "Your learning data, in one place",
      heroBody:
        "Sign in with GitHub to see the notes you wrote while watching a video, the notes you starred, and the words you saved for review. Each GitHub account only ever sees its own data.",
      heroNote:
        "Your notes arrive here as soon as you sign in with the same GitHub account the extension uses. Starred notes and saved words are created in the extension - the star on a note, and the Words tab - so this page fills up as you use them.",
      howToTitle: "Coming from the extension?",
      howToStep1: "Open the YouTube Digest side panel on any YouTube tab.",
      howToStep2:
        "Click **Sign in** in the panel header and sign in with GitHub.",
      howToStep3:
        "Sign in here with the same account to see the same data.",
      howToBody:
        "This page is the sync service your extension already talks to. Its address is in the extension's settings, in the GitHub sync section.",
      showAnswer: "Show answer",
      gradeAgain: "Again",
      gradeHard: "Hard",
      gradeGood: "Good",
      gradeEasy: "Easy",
      privacy: "Privacy",
      exportData: "Export my data",
      deleteAccount: "Delete my account",
      // Copy that only shows up at runtime, once data has loaded.
      retry: "Retry",
      copyAction: "Copy",
      copied: "Copied",
      deleteAction: "Delete",
      addFavorite: "Add to favorites",
      removeFavorite: "Remove from favorites",
      untitledVideo: "Untitled Video",
      watchTheVideo: "Watch the video",
      savedAt: "Saved {date}",
      noteCount: (params) =>
        params.count + " note" + (params.count === 1 ? "" : "s"),
      wordCount: (params) =>
        params.count + " word" + (params.count === 1 ? "" : "s"),
      dueCount: (params) => params.count + " due",
      cardPosition: "Card {index} of {total}",
      statusLearning: "Learning",
      statusReviewing: "Reviewing",
      statusMastered: "Mastered",
      loading: "Loading your data…",
      refreshed: "Refreshed.",
      exportDownloaded: "Export downloaded.",
      accountDeleted: "Account deleted. Sorry to see you go.",
      signedOut: "Signed out. Your data stays in your account.",
      sessionExpired: "Session expired. Sign in again.",
      signInNotOurs:
        "This sign-in did not come from this page, so it was not accepted. Please sign in again.",
      requestFailed: "Request failed ({status})",
      copyFailed: "Could not copy: {message}",
      confirmDeleteNote: "Delete this note?",
      confirmDeleteWord: "Delete this word and its review history?",
      confirmDeleteAccount:
        "Delete your account and ALL notes, words, and review progress? This cannot be undone.",
      confirmDeleteEverything:
        "Really delete everything? This is permanent.",
    },
    "zh-CN": {
      pageTitle: "YouTube Digest · 我的面板",
      brandSubtitle: "我的面板",
      languageLabel: "语言",
      signIn: "用 GitHub 登录",
      signOut: "退出登录",
      refresh: "刷新",
      refreshTitle: "刷新你的数据",
      tablistLabel: "面板分区",
      tabNotes: "笔记",
      tabFavorites: "收藏",
      tabVocabulary: "词汇",
      tabReview: "复习",
      notesHeading: "笔记",
      favoritesHeading: "收藏",
      vocabularyHeading: "词汇",
      reviewHeading: "待复习的单词",
      notesEmpty: "还没有笔记。看视频时在扩展里保存一条吧。",
      favoritesEmpty:
        "还没有收藏。在扩展里给笔记加星，它就会固定在这里。",
      vocabularyEmpty:
        "还没有保存单词。在扩展里保存一个单词，它就会出现在这里。",
      reviewEmpty: "现在没有要复习的单词。保存的单词会按自己的节奏回到这里。",
      favoritesNote:
        "收藏来自扩展：在侧边栏给笔记加星，它会固定在这里，在登录同一账号的每台设备上都能看到。",
      vocabularyNote:
        "单词来自扩展：在扩展里保存一个单词，它就会列在这里，等待复习。",
      reviewNote:
        "复习时间由服务器安排：保存的单词会按各自的时间回到这里，你给出的评分决定下一次复习的时间。",
      heroTitle: "你的学习数据，都在这里",
      heroBody:
        "用 GitHub 登录，就能看到你看视频时记下的笔记、你加星收藏的笔记，以及你保存待复习的单词。每个 GitHub 账号只能看到自己的数据。",
      heroNote:
        "用扩展使用的同一个 GitHub 账号登录后，你的笔记就会出现在这里。加星笔记和保存的单词都在扩展里创建，也就是笔记上的星号和保存单词的功能。所以你用得越多，这个页面就越充实。",
      howToTitle: "刚装好扩展？",
      howToStep1: "在任意 YouTube 页面上打开 YouTube Digest 侧边栏。",
      howToStep2: "点击面板顶部的**登录**，用 GitHub 登录。",
      howToStep3: "在这里用同一个账号登录，就能看到同样的数据。",
      howToBody:
        "这个页面就是扩展一直在用的同步服务。它的地址在扩展的设置里，位于「GitHub 同步」那一节。",
      showAnswer: "显示答案",
      gradeAgain: "忘了",
      gradeHard: "有点难",
      gradeGood: "记得",
      gradeEasy: "太简单",
      privacy: "隐私",
      exportData: "导出我的数据",
      deleteAccount: "删除我的账号",
      retry: "重试",
      copyAction: "复制",
      copied: "已复制",
      deleteAction: "删除",
      addFavorite: "加入收藏",
      removeFavorite: "取消收藏",
      untitledVideo: "无标题视频",
      watchTheVideo: "观看视频",
      savedAt: "保存于 {date}",
      noteCount: (params) => params.count + " 条笔记",
      wordCount: (params) => params.count + " 个词",
      dueCount: (params) => params.count + " 个待复习",
      cardPosition: "第 {index} / {total} 张",
      statusLearning: "学习中",
      statusReviewing: "复习中",
      statusMastered: "已掌握",
      loading: "正在加载你的数据…",
      refreshed: "已刷新。",
      exportDownloaded: "数据已导出并下载。",
      accountDeleted: "账号已删除。很遗憾你要离开。",
      signedOut: "已退出登录。你的数据仍保留在账号里。",
      sessionExpired: "登录状态已过期，请重新登录。",
      signInNotOurs: "这次登录不是从本页面发起的，因此没有被接受。请重新登录。",
      requestFailed: "请求失败（{status}）",
      copyFailed: "复制失败：{message}",
      confirmDeleteNote: "确定删除这条笔记吗？",
      confirmDeleteWord: "确定删除这个词和它的复习记录吗？",
      confirmDeleteAccount:
        "确定删除你的账号以及全部笔记、单词和复习进度吗？此操作无法撤销。",
      confirmDeleteEverything: "真的要删除所有数据吗？此操作是永久的。",
    },
  };

  const $ = (id) => document.getElementById(id);

  // The language the page is currently rendered in. It is settled before
  // anything is drawn, so the first paint is already in the right language.
  let language = "en";

  /**
   * Maps a language tag to the two the dashboard ships. Mirrors the
   * extension's own normalization, but lives here: the dashboard is a
   * separate page with its own copy.
   */
  function normalizeLanguage(value) {
    if (typeof value !== "string") return "en";
    const tag = value.trim().toLowerCase();
    if (
      tag === "zh" ||
      tag === "zh-cn" ||
      tag === "zh-hans" ||
      tag === "zh-tw" ||
      tag === "zh-hant"
    ) {
      return "zh-CN";
    }
    return "en";
  }

  /**
   * Picks the language to start in. An explicit ?lang= in the URL wins, so
   * a link can be shared in one language; then the user's own last choice;
   * then the browser's preference; then English. A URL override is
   * remembered, so the next visit opens in the language the link used.
   */
  function detectLanguage() {
    const override = new URLSearchParams(location.search).get("lang");
    if (override !== null && override.trim() !== "") {
      const chosen = normalizeLanguage(override);
      storeLanguage(chosen);
      return chosen;
    }
    const stored = readStoredLanguage();
    if (stored) {
      // The choice can predate the cookie, so it is stored again: the
      // server and the dashboard then speak the same language.
      const chosen = normalizeLanguage(stored);
      storeLanguage(chosen);
      return chosen;
    }
    return normalizeLanguage(navigator.language || "");
  }

  function readStoredLanguage() {
    try {
      return localStorage.getItem(LANG_KEY);
    } catch (_error) {
      // Private browsing can refuse storage. The page still has to render.
      return null;
    }
  }

  function storeLanguage(value) {
    try {
      localStorage.setItem(LANG_KEY, value);
    } catch (_error) {
      // Same as above: not being able to remember the choice is not a
      // reason to break the page.
    }
    // The sign-in page is rendered by the server, so the choice travels
    // there in a cookie the server can read.
    try {
      document.cookie =
        LANG_KEY +
        "=" +
        encodeURIComponent(value) +
        "; path=/; max-age=31536000; samesite=lax";
    } catch (_error) {
      // A blocked cookie only costs the sign-in page its language.
    }
  }

  /**
   * Returns the copy for the current language. English is the fallback for
   * every missing key, so a partial table can never blank out the page.
   */
  function copy(key, params) {
    const table = DASHBOARD_COPY[language] || DASHBOARD_COPY.en;
    const value = table[key] ?? DASHBOARD_COPY.en[key];
    if (value === undefined || value === null) return "";
    if (typeof value === "function") return String(value(params || {}));
    return String(value).replace(/\{(\w+)\}/g, (match, name) =>
      Object.hasOwn(params || {}, name) ? String(params[name]) : match,
    );
  }

  /**
   * Writes copy into an element. The table marks emphasis with **...**, so
   * a phrase like "Sign in" stays bold inside a sentence that is
   * translated as a whole.
   */
  function setCopy(element, text) {
    if (!text) return;
    element.innerHTML = escapeHtml(text).replace(
      /\*\*(.+?)\*\*/g,
      "<strong>$1</strong>",
    );
  }

  /**
   * Applies the copy to the static markup and tells the document which
   * language it is in, so a screen reader pronounces it correctly.
   */
  function applyCopy() {
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      setCopy(element, copy(element.getAttribute("data-i18n")));
    });
    // Labels and tooltips follow the interface language too, so a screen
    // reader never reads an English name on a Chinese page.
    const attributeBindings = [
      ["data-i18n-aria-label", "aria-label"],
      ["data-i18n-title", "title"],
    ];
    for (const [marker, attribute] of attributeBindings) {
      document.querySelectorAll(`[${marker}]`).forEach((element) => {
        const value = copy(element.getAttribute(marker));
        if (value) element.setAttribute(attribute, value);
      });
    }
    if (document.documentElement) document.documentElement.lang = language;
  }

  /**
   * Paints the language switcher: the selected language is filled with the
   * accent colour and marked with aria-pressed, so the choice is visible
   * and announced. The state is painted through the CSSOM because the
   * dashboard ships a strict CSP and its stylesheet is not ours to change.
   */
  function paintLangSwitch() {
    document.querySelectorAll("#langSwitch .lang-btn").forEach((button) => {
      const selected = button.dataset.lang === language;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      button.style.background = selected ? "var(--accent-solid)" : "";
      button.style.color = selected ? "var(--on-accent)" : "";
      button.style.borderColor = selected ? "var(--accent-solid)" : "";
    });
  }

  /**
   * Switches the language and puts the page back together in place: the
   * copy changes, the already-loaded data is redrawn in the new language
   * and the signed-in state is untouched. No reload, no second round trip
   * to the server.
   */
  function setLanguage(next) {
    language = normalizeLanguage(next);
    storeLanguage(language);
    applyCopy();
    paintLangSwitch();
    renderAll();
    renderReview({ preserveReveal: true });
    // A message that is still on screen has to change with the page.
    if (statusState.key) {
      statusLine(copy(statusState.key, statusState.params), statusState.isError);
    }
  }

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

  // The last message on the status line, and where its wording came from.
  // A message the copy table owns is remembered by key, so a language
  // change can put it back in the new language instead of leaving one
  // English sentence behind.
  const statusState = { key: null, params: {}, isError: false };

  function statusLine(message, isError, key, params, options) {
    statusState.key = key || null;
    statusState.params = params || {};
    statusState.isError = !!isError;
    const el = $("statusLine");
    el.textContent = message || "";
    el.classList.toggle("error", !!isError);
    // A retry button that cannot succeed is worse than no button: it
    // invites the reader to press it and see the same failure again.
    if (isError && !(options && options.retry === false)) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ghost-btn";
      retry.textContent = copy("retry");
      retry.style.marginLeft = "10px";
      retry.addEventListener("click", () => void boot());
      el.appendChild(retry);
    }
  }

  /**
   * Shows a message that the copy table owns and remembers its key.
   */
  function statusFromCopy(key, params, isError) {
    statusLine(copy(key, params), isError, key, params);
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
      // The session is gone for good. Signing in again is the way out, so
      // the message must not offer a retry that cannot work.
      const error = new Error(copy("sessionExpired"));
      error.noRetry = true;
      throw error;
    }
    if (!response.ok) {
      throw new Error(
        (data && data.error) || copy("requestFailed", { status: response.status }),
      );
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
    $(countId).textContent = notes.length
      ? copy("noteCount", { count: notes.length })
      : "";
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
      star.title = note.starred
        ? copy("removeFavorite")
        : copy("addFavorite");
      star.setAttribute("aria-label", star.title);
      star.setAttribute("aria-pressed", note.starred ? "true" : "false");
      star.addEventListener("click", () => toggleStar(note));
      const title = document.createElement("span");
      title.className = "card-title";
      title.textContent = note.videoTitle || copy("untitledVideo");
      const link = document.createElement("a");
      link.className = "ts-link";
      link.href = ts;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = formatTimestamp(note.timestampSeconds);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del-btn";
      del.textContent = copy("deleteAction");
      del.addEventListener("click", () => deleteNote(note));
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "del-btn";
      copyBtn.textContent = copy("copyAction");
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.note || "");
          copyBtn.textContent = copy("copied");
          setTimeout(() => {
            copyBtn.textContent = copy("copyAction");
          }, 1500);
        } catch (error) {
          statusLine(copy("copyFailed", { message: error.message }), true);
        }
      });
      head.append(star, title, link, copyBtn, del);
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
      saved.textContent = copy("savedAt", {
        date: new Date(note.createdAt).toLocaleString(),
      });
      meta.appendChild(saved);
      card.append(head, body, meta);
      list.appendChild(card);
    }
  }

  function renderVocabulary(rows) {
    const list = $("vocabularyList");
    const empty = $("vocabularyEmpty");
    $("vocabularyCount").textContent = rows.length
      ? copy("wordCount", { count: rows.length })
      : "";
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
        el.textContent = copy(option.labelKey);
        el.selected = row.status === option.value;
        status.appendChild(el);
      }
      status.addEventListener("change", () => setVocabStatus(row, status.value));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del-btn";
      del.textContent = copy("deleteAction");
      del.addEventListener("click", () => deleteVocabularyEntry(row));
      const video = document.createElement("a");
      video.className = "ts-link";
      video.href = watchUrl(row.videoId, row.timestampSeconds);
      video.target = "_blank";
      video.rel = "noreferrer";
      // A video id is a database key, not a title. When the title is missing
      // the link still needs a name, so it says what it does.
      video.textContent = row.videoTitle || copy("watchTheVideo");
      head.append(term, status, video, del);
      const translation = document.createElement("div");
      translation.className = "vocab-translation";
      translation.textContent = row.translation || "";
      const sentence = document.createElement("div");
      sentence.className = "vocab-sentence";
      sentence.textContent = row.sentence || "";
      const meta = document.createElement("div");
      meta.className = "card-meta";
      meta.textContent = copy("savedAt", {
        date: new Date(row.createdAt).toLocaleString(),
      });
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
    if (!confirm(copy("confirmDeleteNote"))) return;
    try {
      await api("/api/notes/" + note.id, { method: "DELETE" });
      STATE.notes = STATE.notes.filter((item) => item.id !== note.id);
      renderAll();
    } catch (error) {
      statusLine(error.message, true);
    }
  }

  async function deleteVocabularyEntry(row) {
    if (!confirm(copy("confirmDeleteWord"))) return;
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
    try {
      const data = await api("/api/reviews/due");
      dashReviewState.queue = data.reviews || [];
      dashReviewState.index = 0;
      dashReviewState.revealed = false;
      renderReview();
    } catch (error) {
      statusLine(error.message, true);
    }
  }

  /**
   * Draws the review panel from the reviews already in memory, so a
   * language change does not need another round trip to the server.
   */
  function renderReview(options) {
    const queue = dashReviewState.queue;
    $("reviewCount").textContent = queue.length
      ? copy("dueCount", { count: queue.length })
      : "";
    $("reviewEmpty").hidden = queue.length > 0;
    $("reviewCard").hidden = queue.length === 0;
    $("dashReviewActions").hidden = queue.length === 0;
    if (!queue.length) {
      $("dashReviewProgress").textContent = "";
      return;
    }
    renderDashReviewCard(options);
  }

  function renderDashReviewCard(options) {
    const preserveReveal = !!(options && options.preserveReveal);
    const review = dashReviewState.queue[dashReviewState.index];
    if (!review) {
      void loadDueReviews();
      return;
    }
    if (!preserveReveal) dashReviewState.revealed = false;
    $("dashReviewTerm").textContent = review.vocabulary.term;
    $("dashReviewSentence").textContent = review.vocabulary.sentence || "";
    $("dashReviewTranslation").textContent = review.vocabulary.translation || "";
    $("dashReviewExplanation").textContent = review.vocabulary.sentenceTranslation || "";
    $("dashReviewTranslation").hidden = !dashReviewState.revealed;
    $("dashReviewExplanation").hidden = !dashReviewState.revealed;
    $("reviewCard").setAttribute(
      "aria-expanded",
      dashReviewState.revealed ? "true" : "false",
    );
    $("dashReviewHint").hidden = dashReviewState.revealed;
    $("dashReviewProgress").textContent = copy("cardPosition", {
      index: dashReviewState.index + 1,
      total: dashReviewState.queue.length,
    });
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
    if (!silent) statusFromCopy("loading");
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

  /**
   * A random value that ties a sign-in to this page.
   *
   * The sync service gives the nonce back with the token. A token that
   * arrives without it is refused: without this, a crafted link could
   * switch the reader to another account and show that account's notes.
   */
  function createLoginNonce() {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    let nonce = "";
    for (const byte of bytes) nonce += byte.toString(16).padStart(2, "0");
    return nonce;
  }

  function readPendingNonce() {
    try {
      return window.sessionStorage.getItem(NONCE_KEY) || "";
    } catch {
      // Private mode can refuse to store anything. The sign-in then does
      // not complete, and the reader is asked to try again.
      return "";
    }
  }

  function clearPendingNonce() {
    try {
      window.sessionStorage.removeItem(NONCE_KEY);
    } catch {
      // Nothing to do: the nonce is already gone.
    }
  }

  /**
   * Puts the nonce into the sign-in links.
   *
   * The link stays a link: the nonce is added when the reader presses it,
   * so the button works the same way with the mouse and with the keyboard.
   */
  function prepareSignInLinks() {
    document.querySelectorAll('a[href^="/api/auth/login"]').forEach((link) => {
      const base = link.getAttribute("href") || LOGIN_PATH;
      link.addEventListener("click", () => {
        const nonce = createLoginNonce();
        try {
          window.sessionStorage.setItem(NONCE_KEY, nonce);
        } catch {
          // Without storage the nonce cannot come back, so the sign-in is
          // left as it is. It will be refused on the way back, which is the
          // honest outcome.
          return;
        }
        const separator = base.includes("?") ? "&" : "?";
        link.setAttribute("href", base + separator + "nonce=" + encodeURIComponent(nonce));
      });
    });
  }

  async function boot() {
    // OAuth completes with #access_token=... on this page. The token is only
    // ours when the nonce that came with it is the one this page produced
    // when the reader pressed "Sign in": a link that carries somebody else's
    // token carries no nonce of ours, and it is refused.
    const match = location.hash.match(/access_token=([^&]+)/);
    if (match) {
      const nonceMatch = location.hash.match(/nonce=([^&]+)/);
      const expected = readPendingNonce();
      const received = nonceMatch ? decodeURIComponent(nonceMatch[1]) : "";
      history.replaceState(null, "", location.pathname);
      clearPendingNonce();
      if (!expected || !received || received !== expected) {
        // Not our sign-in. The reader stays signed out, the button is right
        // there, and the reason is said once without a retry that cannot
        // work.
        showSignedOut();
        statusLine(copy("signInNotOurs"), true, "signInNotOurs", null, {
          retry: false,
        });
        return;
      }
      localStorage.setItem(TOKEN_KEY, decodeURIComponent(match[1]));
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
      // An expired session is not a broken page: the reader is signed out
      // and the sign-in button is right there. It is said calmly, without
      // the red error colour of a failure.
      if (error.noRetry) {
        // The key is remembered, so a language change puts the sentence
        // back in the new language instead of leaving English behind.
        statusLine(error.message, false, "sessionExpired", null, {
          retry: false,
        });
      } else {
        statusLine(error.message, true);
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    // The language is settled before anything is drawn, so the first paint
    // is already in the user's language.
    language = detectLanguage();
    applyCopy();
    paintLangSwitch();
    prepareSignInLinks();

    $("refreshBtn").addEventListener("click", () => {
      void loadAll();
      void loadDueReviews();
      statusFromCopy("refreshed");
      setTimeout(() => statusLine(""), 1200);
    });
    // Coming back to this tab refreshes data from the cloud.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && STATE.token) void loadAll(true);
    });
    $("logoutBtn").addEventListener("click", () => {
      signOut();
      statusFromCopy("signedOut");
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
        statusFromCopy("exportDownloaded");
        setTimeout(() => statusLine(""), 2000);
      } catch (error) {
        statusLine(error.message, true);
      }
    });
    $("deleteAccountBtn").addEventListener("click", async () => {
      if (!confirm(copy("confirmDeleteAccount"))) return;
      if (!confirm(copy("confirmDeleteEverything"))) return;
      try {
        await api("/api/account", { method: "DELETE" });
        localStorage.removeItem(TOKEN_KEY);
        STATE.token = "";
        showSignedOut();
        statusFromCopy("accountDeleted");
      } catch (error) {
        statusLine(error.message, true);
      }
    });
    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => switchTab(button.dataset.tab));
      button.addEventListener("keydown", handleTabKeydown);
    });
    // Switching the language redraws the page where the user is looking at
    // it. The signed-in state is untouched: nothing is signed out, nothing
    // is fetched again.
    document.querySelectorAll("#langSwitch .lang-btn").forEach((button) => {
      button.addEventListener("click", () => setLanguage(button.dataset.lang));
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

  // A small seam for the test: it needs to reach the copy table to prove
  // that a missing key falls back to English, the way the options page
  // exports its own table for its test.
  window.YTD_DASHBOARD = { copy, normalizeLanguage, DASHBOARD_COPY };
})();

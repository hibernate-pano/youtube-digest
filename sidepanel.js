/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for YouTube Digest: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let youtubeTabId = null; // Store the YouTube tab ID for reliable messaging
// True when the panel shows a saved copy of a video instead of the video in
// the front tab. The user has to be told: a note written here belongs to the
// saved video, not to what the tab is playing.
let showingCachedVideo = false;
let errorAction = null;
// True while the panel waits for the user to add a missing API key. The
// settings watcher uses it to know when a settings change should bring the
// panel back to life.
let awaitingApiKey = false;
// The notes filter is a preference, not a per-open choice: the panel document
// is recreated on every open, so it has to be remembered.
const NOTES_FILTER_KEY = "ytd_notes_filter";
let notesFilterShowAll = false;

// --- Translation state ---
// The universal language control supports original content, Chinese, and an
// aligned bilingual view across Transcript, Overview, and Notes.
let currentTranscriptMode = "original";
const DISPLAY_LANGUAGE_MODE_KEY = "ytd_display_language_modes_by_video";
const DISPLAY_LANGUAGE_MODES = new Set(["original", "zh", "bilingual"]);
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
let interfaceTranslationCache = new Map();
let interfaceTranslationInFlight = new Set();
let interfaceTranslationFailures = new Set();
let currentNotes = [];
let currentNotesFilterVideoId = null;
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;
const TRANSLATION_BATCH_SIZE = 3;
// A translation is paid for with the user's own provider balance, so a batch
// that failed for a reason that goes away on its own is asked again before
// the panel gives up on it. This is how many times the panel asks on its
// own: one try plus TRANSLATION_MAX_AUTO_RETRIES retries.
const TRANSLATION_MAX_AUTO_RETRIES = 3;
// The pause between two attempts grows with every retry, so a provider that
// is throttling the panel is given room to breathe.
const TRANSLATION_RETRY_BASE_DELAY_MS = 2000;
// How often the pause looks at the world to see whether the retry is still
// worth doing. A smaller number stops the wait sooner, a bigger one costs
// less while the panel waits.
const TRANSLATION_RETRY_POLL_MS = 250;
// The failures that never get better on their own. The user has to fix the
// settings first, so asking again would only spend the user's balance.
const TRANSLATION_NON_RETRYABLE_ERROR_CODES = new Set([
  "NO_AI_KEY",
  "INVALID_AI_KEY",
  "NO_SUPADATA_KEY",
  "INVALID_SUPADATA_KEY",
]);
// The failures that are usually over by the time the panel asks again.
const TRANSLATION_RETRYABLE_ERROR_CODES = new Set([
  "RATE_LIMITED",
  "EMPTY_AI_RESPONSE",
  "AI_IDLE_TIMEOUT",
  "AI_HARD_TIMEOUT",
]);
// A key that is missing or was refused. The message is what the worker
// sends when it has no code to go by, so the words have to be read too.
const TRANSLATION_KEY_PROBLEM_PATTERN =
  /api key|not configured|unauthoriz|authentication|forbidden|\b401\b|\b403\b/i;
// The failures a network hiccup or a model hiccup can cause.
const TRANSLATION_TRANSIENT_PATTERN =
  /rate.?limit|\b429\b|timed?\s*out|timeout|inactive|network|fetch failed|failed to fetch|econnreset|econnrefused|etimedout|socket hang up|json|unexpected token|unterminated|no valid|too many requests/i;

// --- Vocabulary, review and library state ---
// The vocabulary is local-first: it works without a sign-in, so the Words
// tab is usable in the welcome state too.
let vocabularyItems = [];
let reviewQueue = [];
let reviewIndex = 0;
let reviewRevealed = false;
let libraryEntries = [];
let librarySearchQuery = "";
// The library cleanup is a fact the user must be able to see: entries that
// were dropped are remembered here so the panel can say how many.
const LIBRARY_CLEANUP_KEY = "ytd_library_cleanup";
let libraryCleanup = null;
// The local note store keeps the most recent notes. The number that really
// limits the user is the one the store enforces, so the panel reads it from
// the shared settings instead of keeping a second copy that drifts.
const LOCAL_NOTE_LIMIT =
  typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.MAX_LOCAL_NOTES
    ? YTD_SETTINGS.MAX_LOCAL_NOTES
    : 100;
// The same rule for the words: the number that really limits the user is
// the one the store enforces, so the panel reads it from the shared
// settings instead of keeping a second copy that drifts.
const LOCAL_VOCAB_LIMIT =
  typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.MAX_LOCAL_VOCABULARY
    ? YTD_SETTINGS.MAX_LOCAL_VOCABULARY
    : 500;
// The cached digests keep 20 videos for 30 days.
const LIBRARY_MAX_ENTRIES = 20;
const LIBRARY_MAX_AGE_DAYS = 30;

// The video on screen changed. This ticket changes ONLY when that happens,
// so a response that is still perfectly valid - because the user re-ran the
// digest for the same video - is never thrown away.
let videoTicket = 0;

// A digest run started. This counts runs, not video changes: a re-run for the
// same video is a new run, but the work it does is still valid.
let digestRunCount = 0;

// The panel pays for every analysis (the user's own provider balance), and
// for a transcript lookup whenever the local caption read failed and the
// paid fallback had to run. The same work must never be paid for twice.
// These ledgers hold one entry per video: while the request is on the wire
// a second run joins it, and once it settled with a result the result is
// kept, so a later run reuses it instead of paying again.
const transcriptLedger = new Map(); // videoId -> paid request
const analysisLedger = new Map(); // videoId -> paid request

// The ledgers live for the whole life of the panel document, so they are
// kept small. The persistent digest cache still holds the older videos.
const PAID_REQUEST_LEDGER_LIMIT = 20;

/**
 * Runs a request that costs the user money and keeps it in the ledger.
 *
 * A request that failed leaves the ledger, so the user can retry it. A
 * request that succeeded stays, because its result is worth keeping.
 */
function startPaidRequest(ledger, videoId, send) {
  const existing = ledger.get(videoId);
  if (existing) return existing;

  const entry = { settled: false, result: null, promise: null };
  entry.promise = (async () => {
    try {
      return await send();
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  })().then((result) => {
    entry.settled = true;
    entry.result = result;
    if (!result?.success && ledger.get(videoId) === entry) {
      ledger.delete(videoId);
    }
    return result;
  });
  ledger.set(videoId, entry);

  while (ledger.size > PAID_REQUEST_LEDGER_LIMIT) {
    const oldest = ledger.keys().next().value;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }

  return entry;
}

/**
 * True while a request for this video is still on the wire. A request that
 * already settled is not in flight: the user may start a new one.
 */
function isRequestInFlight(ledger, videoId) {
  const entry = ledger.get(videoId);
  return Boolean(entry && !entry.settled);
}

/**
 * True while the analysis of the video on screen is being paid for.
 */
function isAnalysisInFlight(videoId = currentVideoId) {
  return isRequestInFlight(analysisLedger, videoId);
}

// ============================================================
// PANEL COPY (LOCALIZATION)
// ============================================================
// The panel speaks the language the user picked on the settings page. The
// table below covers the state, empty and error copy a user actually hits;
// it is deliberately not a translation of every string in the panel.
const PANEL_COPY = {
  en: {
    welcomeTitle: "Ready to Digest",
    welcomeDescription:
      "Open a YouTube video and click the extension icon to read its transcript and build a summary. Your vocabulary and library are one click away.",
    fetchingTranscript: "Fetching transcript",
    extractingCaptions: "Extracting captions from video...",
    loadingQuotes: "Loading quotes...",
    generatingOverview: "Generating overview... uses your AI balance",
    errorTitle: "Error",
    errorMessage: "Something went wrong.",
    // The failure codes the worker returns. They are for the developer, so
    // every one of them has a sentence the user can act on.
    errorCodeNoAiKey:
      "No AI key is set. Open YouTube Digest Settings and add the key of your AI provider.",
    errorCodeInvalidAiKey:
      "The AI provider rejected the API key. Check the key in YouTube Digest Settings.",
    errorCodeNoSupadataKey:
      "No Supadata API key is set. Open YouTube Digest Settings to add one.",
    errorCodeInvalidSupadataKey:
      "The Supadata API key is invalid. Open YouTube Digest Settings to replace it.",
    errorCodeNoTranscript:
      "This video has no subtitles, so there is nothing to read.",
    errorCodeEmptyTranscript: "The transcript for this video came back empty.",
    errorCodeOutOfCredits:
      "Your Supadata credits are used up. Add credits at dash.supadata.ai.",
    errorCodeRateLimited: "Too many requests. Wait a moment and try again.",
    errorCodeEmptySentence:
      "There was no sentence to read. Select a sentence in the transcript and try again.",
    errorCodeAiIdleTimeout: "The AI provider stopped answering. Try again.",
    errorCodeAiHardTimeout: "The AI provider took too long. Try again.",
    errorCodeSyncSessionExpired:
      "The GitHub session expired, so the cloud backup stopped. Sign in again to resume it.",
    errorCodeSyncRequestTimeout:
      "The sync service did not answer in time. Check your connection and try again.",
    errorCodeTranscriptRequestTimeout:
      "The transcript service did not answer in time. Try again in a moment.",
    errorCodeStorageQuotaExceeded:
      "This device's storage is full, so the change was not saved. Free some space in YouTube Digest Settings and try again.",
    cacheNotSaved:
      "This device's storage is full, so this video was not cached. Free some space in YouTube Digest Settings and try again.",
    toastDismiss: "Dismiss",
    toastDismissTitle: "Dismiss this notice",
    serviceErrorTitle: "YouTube Digest could not start",
    tryAgain: "Try Again",
    openSettings: "Open Settings",
    apiKeysMissingTitle: "API Keys Missing",
    apiKeyMissingTitle: "API key missing",
    addSupadataKey: "Add your Supadata API key in YouTube Digest Settings.",
    // The subtitles are read out of the page itself, so the Supadata key is
    // only a fallback. The AI key is what the summary and the translation
    // need, so that is the one the dead end names first.
    addAiKey: "Add your AI provider key in YouTube Digest Settings.",
    noCaptionsNoKey:
      "This video has no subtitles that could be read, and no Supadata key is set as a fallback. Add the key in YouTube Digest Settings to try the paid service.",
    invalidApiKeyTitle: "Invalid API key",
    invalidSupadataKey:
      "Your Supadata API key is invalid. Open YouTube Digest Settings.",
    rateLimitedTitle: "Too many requests",
    rateLimitedMessage:
      "Supadata rate limit reached. Please wait a minute and try again.",
    noTranscriptTitle: "No transcript found",
    noTranscriptMessage: "No subtitles found for this video.",
    emptyTranscriptTitle: "Empty transcript",
    transcriptTimeoutTitle: "The transcript service did not answer",
    emptyTranscriptMessage:
      "Supadata returned an empty transcript for this video.",
    outOfCreditsTitle: "Out of credits",
    outOfCreditsMessage:
      "Your Supadata credits are exhausted. Add credits at dash.supadata.ai.",
    chaptersEmpty: "The chapters come with the summary.",
    quotesEmpty: "The quotes come with the summary.",
    chaptersNone: "This summary came without any chapters.",
    quotesNone: "This summary came without any quotes.",
    fullTranscript: "Full Transcript",
    savedNotes: "Saved Notes",
    noNotesForVideo:
      "No notes for this video yet. Hover over the video and click Note to save.",
    noNotesYet:
      "No notes saved yet. Hover over a video and click Note to save.",
    costDisclosure:
      "AI calls use your own provider balance. Transcripts are read out of the page, so they cost nothing; only the fallback uses a Supadata credit.",
    translationUnavailable: "Translation unavailable.",
    translationFailed: "Translation failed.",
    translationCancelled: "Translation cancelled.",
    translationWaiting: "Waiting for translation...",
    translating: "Translating...",
    retry: "Retry",
    retrying: "Retrying...",
    signIn: "Sign in",
    signInTitle: "Sign in with GitHub to back up your notes",
    settings: "Settings",
    openSettingsTitle: "Open YouTube Digest settings",
    contentLanguage: "Content language",
    modeOriginal: "Original",
    modeChinese: "中文",
    modeBilingual: "Bilingual",
    tabListLabel: "Panel sections",
    tabTranscript: "Transcript",
    tabSummary: "Summary",
    tabNotes: "Notes",
    tabWords: "Words",
    tabLibrary: "Library",
    copy: "Copy",
    export: "Export",
    chapters: "Chapters",
    keyQuotes: "Key Quotes",
    thisVideo: "This Video",
    allNotes: "All Notes",
    notesIntro:
      'Move your mouse over the video and click Note to save a timestamped note, or press the "n" key while the video is focused.',
    followPlayback: "Follow playback",
    searchPlaceholder: "Search words or phrases",
    searchTranscript: "Search transcript",
    clearSearch: "Clear transcript search",
    searchResults: "Search results",
    previousMatch: "Previous transcript match",
    nextMatch: "Next transcript match",
    searchNoMatches: "No matches",
    digestReady: "Digest ready",
    explainTitle: "Explain",
    close: "Close",
    analyzing: "Analyzing...",
    explainFailed: "Could not explain this selection.",
    jumpTo: "Jump to {time}",
    playFrom: "Play from {time}",
    editNoteTitle: "Click to edit",
    note: "Note",
    copied: "Copied",
    copyText: "Copy text",
    copyTimestamp: "Copy timestamp",
    play: "Play",
    deleteNote: "Delete note",
    save: "Save",
    cancel: "Cancel",
    couldNotSave: "Could not save. Try again.",
    saveNote: "Save this quote as a note",
    copyQuote: "Copy this quote",
    saving: "Saving...",
    saved: "Saved",
    selectionActions: "Selected transcript actions",
    openVocabulary: "Vocabulary",
    openVocabularyTitle: "Open your vocabulary",
    openLibrary: "Library",
    openLibraryTitle: "Open the videos you have read",
    emptyNoVideoTranscript: "Open a YouTube video to read its transcript.",
    emptyNoVideoSummary: "Open a YouTube video to build its summary.",
    emptyNoVideoNotes: "Open a YouTube video to see the notes for it.",
    chooseAnotherVideo: "Choose another video",
    summaryTitle: "AI summary",
    generateSummary: "Build summary",
    summaryCostNote:
      "One AI call, charged to your own provider (DeepSeek, MiniMax or OpenCode Go).",
    summaryFailed: "The summary could not be built.",
    wordsTitle: "My vocabulary",
    wordsIntro:
      "Select a word in the transcript and choose Word to add it here. Words are stored on this device.",
    wordsEmpty: "No words yet. Select a word in the transcript and choose Word.",
    refresh: "Refresh",
    wordStatusLearning: "Learning",
    wordStatusReviewing: "Reviewing",
    wordStatusMastered: "Mastered",
    deleteWord: "Delete word",
    deleteNote: "Delete note",
    reviewTitle: "Review",
    reviewSignIn:
      "Sign in with GitHub to review your words on a schedule.",
    reviewEmptyState: "Nothing is due for review right now.",
    reviewShowAnswer: "Show answer",
    reviewHideAnswer: "Hide answer",
    reviewAgain: "Again",
    reviewHard: "Hard",
    reviewGood: "Good",
    reviewEasy: "Easy",
    reviewProgress: "Card {index} of {total}",
    extractWord: "Word",
    extractWordTitle: "Add words to your vocabulary",
    extractWordCost:
      "This calls your own AI provider once, so it uses your provider balance.",
    extractWordConfirm:
      "Your AI provider will read this sentence and pick out the words worth learning.",
    extractWordRun: "Find words",
    extractWordCancel: "Cancel",
    extractWordResults: "Words found",
    extractWordSave: "Save to vocabulary",
    extractWordFailed: "No words could be read from this sentence.",
    extractWordSaved: "Saved to your vocabulary.",
    quickNoteLabel: "Write a note",
    noteAtCurrentMoment:
      "Saved at the start of the video: the panel could not read the playback position.",
    quickNotePlaceholder: "Write a note at the current moment...",
    quickNoteSave: "Save note",
    quickNoteSaved: "Note saved.",
    quickNoteEmpty: "Write something before saving.",
    notesCount: "{count} / {limit}",
    notesNearLimit:
      "You are close to the note limit. When it is reached, the oldest note is dropped first.",
    notesDropped:
      "Last time you saved a note, {count} older note(s) were removed to stay under the {limit}-note limit on this device.",
    wordsCount: "{count} / {limit}",
    wordsNearLimit:
      "You are close to the word limit. When it is reached, the oldest word is dropped first.",
    wordsDropped:
      "Last time you saved a word, {count} older word(s) were removed to stay under the {limit}-word limit on this device.",
    exportNotes: "Export Markdown",
    exportNotesCopied: "Markdown copied",
    exportNotesFailed: "The notes could not be copied.",
    starNote: "Star this note",
    unstarNote: "Remove the star",
    libraryTitle: "Videos you have read",
    librarySearchPlaceholder: "Search by title or channel",
    librarySearchLabel: "Search the library",
    libraryEmpty:
      "Nothing here yet. Every video you open is kept for 30 days, so you can read it again without spending another credit.",
    libraryNoResults: "No video matches your search.",
    libraryJustNow: "just now",
    libraryMinutesAgo: "{count} min ago",
    libraryHoursAgo: "{count} h ago",
    libraryDaysAgo: "{count} d ago",
    libraryMonthsAgo: "{count} mo ago",
    libraryHasSummary: "Summary",
    libraryTranscriptOnly: "Transcript only",
    libraryRetention:
      "The library keeps the last {count} videos for {days} days. Opening one costs nothing.",
    libraryCleaned: "{count} entries older than {days} days were removed.",
    libraryOpenVideo: "Open this video on YouTube",
    libraryOpenInPanel: "Read in the panel",
    libraryCachedView:
      "This is a saved copy, not the video in this tab. Notes you write here belong to the saved video.",
    untitledVideo: "Untitled video",
  },
  "zh-CN": {
    welcomeTitle: "准备开始",
    welcomeDescription:
      "打开一个 YouTube 视频并点击扩展图标，即可阅读字幕并生成摘要。词汇本和资料库就在手边。",
    fetchingTranscript: "正在获取字幕",
    extractingCaptions: "正在从视频中提取字幕...",
    loadingQuotes: "正在加载引用...",
    generatingOverview: "正在生成概览... 会消耗你的 AI 额度",
    errorTitle: "出错了",
    errorMessage: "出了点问题。",
    // The failure codes the worker returns. They are for the developer, so
    // every one of them has a sentence the user can act on.
    errorCodeNoAiKey:
      "还没有设置 AI 密钥。请在 YouTube Digest 设置里填入你的 AI 服务密钥。",
    errorCodeInvalidAiKey:
      "AI 服务拒绝了这个密钥。请检查 YouTube Digest 设置里的密钥。",
    errorCodeNoSupadataKey:
      "还没有设置 Supadata API 密钥。请在 YouTube Digest 设置里填入。",
    errorCodeInvalidSupadataKey:
      "Supadata API 密钥无效。请在 YouTube Digest 设置里更换。",
    errorCodeNoTranscript: "这个视频没有字幕，所以没有可以阅读的内容。",
    errorCodeEmptyTranscript: "这个视频的字幕是空的。",
    errorCodeOutOfCredits:
      "Supadata 额度已经用完，请前往 dash.supadata.ai 充值。",
    errorCodeRateLimited: "请求过于频繁，请稍等一下再试。",
    errorCodeEmptySentence: "没有可以读取的句子。请在字幕里选中一句话再试。",
    errorCodeAiIdleTimeout: "AI 服务没有继续响应了，请重试。",
    errorCodeAiHardTimeout: "AI 服务响应超时了，请重试。",
    errorCodeSyncSessionExpired:
      "GitHub 登录已过期，云端备份已经停止。重新登录即可恢复。",
    errorCodeSyncRequestTimeout:
      "同步服务没有在规定时间内响应。请检查网络后重试。",
    errorCodeTranscriptRequestTimeout:
      "字幕服务没有在规定时间内响应。请稍等一下再试。",
    errorCodeStorageQuotaExceeded:
      "这台设备的存储空间已满，这次改动没有保存。请在 YouTube Digest 设置里清理空间后重试。",
    cacheNotSaved:
      "这台设备的存储空间已满，这个视频没有被缓存。请在 YouTube Digest 设置里清理空间后重试。",
    toastDismiss: "关闭",
    toastDismissTitle: "关闭这条提示",
    serviceErrorTitle: "YouTube Digest 无法启动",
    tryAgain: "重试",
    openSettings: "打开设置",
    apiKeysMissingTitle: "缺少 API 密钥",
    apiKeyMissingTitle: "缺少 API 密钥",
    addSupadataKey: "请在 YouTube Digest 设置中填写 Supadata API 密钥。",
    // 字幕直接从页面里读，Supadata 密钥只是兜底。摘要和翻译要的是 AI 密钥，
    // 所以死胡同先说它。
    addAiKey: "请在 YouTube Digest 设置中填写你的 AI 服务商密钥。",
    noCaptionsNoKey:
      "这个视频没有能读到的字幕，也没有设置 Supadata 密钥作为兜底。请在 YouTube Digest 设置里填入密钥，改用付费服务再试。",
    invalidApiKeyTitle: "API 密钥无效",
    invalidSupadataKey: "Supadata API 密钥无效，请在 YouTube Digest 设置中修改。",
    rateLimitedTitle: "请求过于频繁",
    rateLimitedMessage: "已触发 Supadata 速率限制，请稍等一分钟再试。",
    noTranscriptTitle: "没有找到字幕",
    noTranscriptMessage: "这个视频没有可用的字幕。",
    emptyTranscriptTitle: "字幕为空",
    transcriptTimeoutTitle: "字幕服务没有响应",
    emptyTranscriptMessage: "Supadata 返回了空字幕。",
    outOfCreditsTitle: "额度已用完",
    outOfCreditsMessage: "Supadata 额度已用完，请前往 dash.supadata.ai 充值。",
    chaptersEmpty: "章节会跟着摘要一起出现。",
    quotesEmpty: "精彩引用会跟着摘要一起出现。",
    chaptersNone: "这份摘要里没有章节。",
    quotesNone: "这份摘要里没有精彩引用。",
    fullTranscript: "完整字幕",
    savedNotes: "已保存的笔记",
    noNotesForVideo:
      "这个视频还没有笔记。把鼠标移到视频上并点击视频上的「笔记」按钮即可保存。",
    noNotesYet:
      "还没有保存任何笔记。把鼠标移到视频上并点击视频上的「笔记」按钮即可保存。",
    costDisclosure:
      "AI 调用使用你自己的服务额度。字幕直接从页面里读，不花钱；只有兜底那一次会消耗 1 个 Supadata 额度。",
    translationUnavailable: "翻译不可用。",
    translationFailed: "翻译失败。",
    translationCancelled: "翻译已取消。",
    translationWaiting: "等待翻译...",
    translating: "正在翻译...",
    retry: "重试",
    retrying: "重试中...",
    signIn: "登录",
    signInTitle: "使用 GitHub 登录以备份你的笔记",
    settings: "设置",
    openSettingsTitle: "打开 YouTube Digest 设置",
    contentLanguage: "内容语言",
    modeOriginal: "原文",
    modeChinese: "中文",
    modeBilingual: "双语",
    tabListLabel: "面板分区",
    tabTranscript: "字幕",
    tabSummary: "摘要",
    tabNotes: "笔记",
    tabWords: "词汇",
    tabLibrary: "资料库",
    copy: "复制",
    export: "导出",
    chapters: "章节",
    keyQuotes: "精彩引用",
    thisVideo: "本视频",
    allNotes: "全部笔记",
    notesIntro:
      "把鼠标移到视频上并点击视频上的「笔记」按钮保存带时间戳的笔记，也可以在视频获得焦点时按 \"n\" 键。",
    followPlayback: "跟随播放",
    searchPlaceholder: "搜索词语或短语",
    searchTranscript: "搜索字幕",
    clearSearch: "清除字幕搜索",
    searchResults: "搜索结果",
    previousMatch: "上一个字幕匹配",
    nextMatch: "下一个字幕匹配",
    searchNoMatches: "没有匹配",
    digestReady: "摘要已就绪",
    explainTitle: "解释",
    close: "关闭",
    analyzing: "正在分析...",
    explainFailed: "无法解释这段内容。",
    jumpTo: "跳转到 {time}",
    playFrom: "从 {time} 播放",
    editNoteTitle: "点击编辑",
    note: "笔记",
    copied: "已复制",
    copyText: "复制文字",
    copyTimestamp: "复制时间戳",
    play: "播放",
    deleteNote: "删除笔记",
    save: "保存",
    cancel: "取消",
    couldNotSave: "保存失败，请重试。",
    saveNote: "把这个引用存为笔记",
    copyQuote: "复制这个引用",
    saving: "保存中...",
    saved: "已保存",
    selectionActions: "选中的字幕操作",
    openVocabulary: "词汇本",
    openVocabularyTitle: "打开你的词汇本",
    openLibrary: "资料库",
    openLibraryTitle: "打开你看过的视频",
    emptyNoVideoTranscript: "打开一个 YouTube 视频即可阅读字幕。",
    emptyNoVideoSummary: "打开一个 YouTube 视频即可生成摘要。",
    emptyNoVideoNotes: "打开一个 YouTube 视频即可查看它的笔记。",
    chooseAnotherVideo: "换一个视频",
    summaryTitle: "AI 摘要",
    generateSummary: "生成摘要",
    summaryCostNote:
      "一次 AI 调用，使用你自己的服务额度（DeepSeek、MiniMax 或 OpenCode Go）。",
    summaryFailed: "摘要生成失败。",
    wordsTitle: "我的词汇本",
    wordsIntro:
      "在字幕里选中一个词并点「生词」，它就会出现在这里。词汇保存在这台设备上。",
    wordsEmpty: "还没有生词。在字幕里选中一个词并点「生词」即可。",
    refresh: "刷新",
    wordStatusLearning: "学习中",
    wordStatusReviewing: "复习中",
    wordStatusMastered: "已掌握",
    deleteWord: "删除生词",
    deleteNote: "删除笔记",
    reviewTitle: "复习",
    reviewSignIn: "使用 GitHub 登录后，可以按计划复习你的生词。",
    reviewEmptyState: "现在没有需要复习的生词。",
    reviewShowAnswer: "显示答案",
    reviewHideAnswer: "收起答案",
    reviewAgain: "忘了",
    reviewHard: "有点难",
    reviewGood: "记得",
    reviewEasy: "太简单",
    reviewProgress: "第 {index} 张，共 {total} 张",
    extractWord: "生词",
    extractWordTitle: "把生词加入词汇本",
    extractWordCost:
      "这会调用你自己的 AI 服务一次，因此会消耗你自己的服务额度。",
    extractWordConfirm:
      "你的 AI 服务会读这句话，并挑出值得学习的词。",
    extractWordRun: "找生词",
    extractWordCancel: "取消",
    extractWordResults: "找到的生词",
    extractWordSave: "存进词汇本",
    extractWordFailed: "没能从这句话里读出生词。",
    extractWordSaved: "已存进词汇本。",
    quickNoteLabel: "写笔记",
    noteAtCurrentMoment: "已保存在视频开头，因为面板读不到当前的播放进度。",
    quickNotePlaceholder: "在当前这一刻写一条笔记...",
    quickNoteSave: "保存笔记",
    quickNoteSaved: "笔记已保存。",
    quickNoteEmpty: "先写点内容再保存。",
    notesCount: "{count} / {limit}",
    notesNearLimit:
      "笔记快到上限了。达到上限后，最旧的笔记会先被清掉。",
    notesDropped:
      "上次保存笔记时，有 {count} 条更早的笔记被清理掉了（这台设备最多保留 {limit} 条）。",
    wordsCount: "{count} / {limit}",
    wordsNearLimit: "词汇快到上限了。达到上限后，最旧的生词会先被清掉。",
    wordsDropped:
      "上次保存生词时，有 {count} 条更早的生词被清理掉了（这台设备最多保留 {limit} 条）。",
    exportNotes: "导出 Markdown",
    exportNotesCopied: "Markdown 已复制",
    exportNotesFailed: "笔记没能复制成功。",
    starNote: "收藏这条笔记",
    unstarNote: "取消收藏",
    libraryTitle: "你看过的视频",
    librarySearchPlaceholder: "按标题或频道搜索",
    librarySearchLabel: "搜索资料库",
    libraryEmpty:
      "这里还是空的。每个打开过的视频都会保留 30 天，你可以免费重读，不会再花额度。",
    libraryNoResults: "没有符合搜索条件的视频。",
    libraryJustNow: "刚刚",
    libraryMinutesAgo: "{count} 分钟前",
    libraryHoursAgo: "{count} 小时前",
    libraryDaysAgo: "{count} 天前",
    libraryMonthsAgo: "{count} 个月前",
    libraryHasSummary: "有摘要",
    libraryTranscriptOnly: "只有字幕",
    libraryRetention:
      "资料库保留最近 {count} 个视频，共 {days} 天。打开它们不花钱。",
    libraryCleaned: "已清理 {count} 条超过 {days} 天的记录。",
    libraryOpenVideo: "在 YouTube 上打开这个视频",
    libraryOpenInPanel: "在面板里重看",
    libraryCachedView:
      "这是已保存的副本，不是当前标签页里的视频。在这里写的笔记属于这个已保存的视频。",
    untitledVideo: "未命名视频",
  },
};

let panelLanguage = "en";

// The failure codes the worker hands back. They are written for the
// developer, so the panel never shows one: every code has a copy key that
// says the same thing in words a user can act on.
const PANEL_ERROR_CODE_COPY = {
  NO_AI_KEY: "errorCodeNoAiKey",
  INVALID_AI_KEY: "errorCodeInvalidAiKey",
  NO_SUPADATA_KEY: "errorCodeNoSupadataKey",
  INVALID_SUPADATA_KEY: "errorCodeInvalidSupadataKey",
  NO_TRANSCRIPT: "errorCodeNoTranscript",
  EMPTY_TRANSCRIPT: "errorCodeEmptyTranscript",
  OUT_OF_CREDITS: "errorCodeOutOfCredits",
  RATE_LIMITED: "errorCodeRateLimited",
  EMPTY_SENTENCE: "errorCodeEmptySentence",
  AI_IDLE_TIMEOUT: "errorCodeAiIdleTimeout",
  AI_HARD_TIMEOUT: "errorCodeAiHardTimeout",
  SYNC_SESSION_EXPIRED: "errorCodeSyncSessionExpired",
  SYNC_REQUEST_TIMEOUT: "errorCodeSyncRequestTimeout",
  TRANSCRIPT_REQUEST_TIMEOUT: "errorCodeTranscriptRequestTimeout",
  STORAGE_QUOTA_EXCEEDED: "errorCodeStorageQuotaExceeded",
};

function normalizePanelLanguage(language) {
  if (
    typeof YTD_SETTINGS !== "undefined" &&
    YTD_SETTINGS.normalizeUiLanguage
  ) {
    return YTD_SETTINGS.normalizeUiLanguage(language);
  }
  return language === "zh-CN" ? "zh-CN" : "en";
}

/**
 * Returns the copy for the current panel language. English is the fallback
 * for every missing key, so a partial table can never blank out the panel.
 */
function panelCopy(key) {
  const table = PANEL_COPY[panelLanguage] || PANEL_COPY.en;
  return table[key] ?? PANEL_COPY.en[key] ?? "";
}

/**
 * Returns the copy for the current language with its {placeholders} filled
 * in. Used for the labels that name a time, which read in a different order
 * in English and Chinese.
 */
function panelCopyFormat(key, values = {}) {
  return panelCopy(key).replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

/**
 * The numbers the product's own limits produce. A sentence that says "the
 * library keeps the last {count} videos for {days} days" has to be told
 * what those limits are, or it ships with the braces still in it.
 */
function copyPlaceholders() {
  return {
    count: String(LIBRARY_MAX_ENTRIES),
    days: String(LIBRARY_MAX_AGE_DAYS),
    limit: String(LOCAL_NOTE_LIMIT),
  };
}

/**
 * Picks the sentence a failed request is shown with.
 *
 * The order matters. A message from the provider comes first: it is the only
 * thing that can explain a provider failure, and hiding it would leave the
 * user with nothing. Our own code comes next, turned into a sentence. A
 * string that still looks like a code (all caps, no spaces) is one we do
 * not know, and it is replaced by the generic sentence rather than shown as
 * it is.
 */
function panelFailureMessage(result) {
  const message = String(result?.message || "").trim();
  if (message) return message;

  const code = String(result?.error || "").trim();
  const copyKey = PANEL_ERROR_CODE_COPY[code];
  if (copyKey) return panelCopy(copyKey);
  if (code && /^[A-Z][A-Z0-9_]*$/.test(code)) return panelCopy("errorMessage");
  return code || panelCopy("errorMessage");
}

/**
 * Picks the sentence a failed note save is shown with.
 *
 * A note that did not save is a note the user lost, so the reason matters
 * more than the mechanics. Our own code comes first: a code is the same in
 * every language, and the sentence that explains it can be translated. A
 * message is only used when there is no code to go by, and a message that is
 * really a code in disguise is replaced by the generic sentence.
 */
function noteSaveFailureMessage(result) {
  const code = String(result?.code || "").trim();
  if (code && PANEL_ERROR_CODE_COPY[code]) {
    return panelCopy(PANEL_ERROR_CODE_COPY[code]);
  }
  const message = String(result?.error || "").trim();
  if (message && !/^[A-Z][A-Z0-9_]*$/.test(message)) return message;
  return panelCopy("couldNotSave");
}

/**
 * Applies the translated copy to the static markup. Dynamic copy (errors,
 * empty states) is written at render time through panelCopy().
 */
function applyPanelCopy() {
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    // A few sentences carry numbers that change with the product's limits.
    // A placeholder that is never filled is worse than no sentence at all:
    // the user would read "{count} videos" and have to guess.
    const value = /\{\w+\}/.test(panelCopy(key))
      ? panelCopyFormat(key, copyPlaceholders())
      : panelCopy(key);
    if (value) element.textContent = value;
  });

  // Labels, placeholders and tooltips follow the interface language too, so
  // a screen reader never reads an English name on a Chinese panel.
  const attributeBindings = [
    ["data-i18n-aria-label", "aria-label"],
    ["data-i18n-placeholder", "placeholder"],
    ["data-i18n-title", "title"],
  ];
  for (const [marker, attribute] of attributeBindings) {
    document.querySelectorAll(`[${marker}]`).forEach((element) => {
      const key = element.getAttribute(marker);
      const value = panelCopy(key);
      if (value) element.setAttribute(attribute, value);
    });
  }

  // The document language tells screen readers which pronunciation to use.
  if (document.documentElement) {
    document.documentElement.lang = panelLanguage;
  }
}

/**
 * Reads the interface language the user picked on the settings page and
 * applies it to the panel. Never throws: the panel must still render.
 */
async function loadPanelLanguage() {
  try {
    const key =
      typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.UI_LANGUAGE_STORAGE_KEY
        ? YTD_SETTINGS.UI_LANGUAGE_STORAGE_KEY
        : "ytd_options_language";
    const stored = await chrome.storage.local.get(key);
    panelLanguage = normalizePanelLanguage(stored?.[key]);
  } catch (error) {
    panelLanguage = "en";
  }
  applyPanelCopy();
}

// ============================================================
// KEYBOARD AND SCREEN READER HELPERS
// ============================================================

/**
 * Makes an element that is not a real button operable with the keyboard.
 *
 * A screen reader calls out the role, and the element joins the tab order, so
 * the action is reachable without a mouse. Enter and Space are handled here
 * because an element that is not a button does not turn them into a click on
 * its own, and Space would scroll the panel while it does.
 */
function makeKeyboardActivatable(
  element,
  activate,
  { role = "button", label = "" } = {},
) {
  if (!element) return;
  element.setAttribute("role", role);
  element.setAttribute("tabindex", "0");
  if (label) element.setAttribute("aria-label", label);
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") {
      return;
    }
    // A control inside the row answers its own keys.
    if (event.target && event.target !== element) return;
    event.preventDefault();
    activate();
  });
}

/**
 * Tells whether the system asked for less movement.
 *
 * The panel asks the browser the same way the stylesheet does, so a change
 * in the system setting takes effect without reloading the panel.
 */
function prefersReducedMotion() {
  if (typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The way the panel scrolls something into view.
 *
 * A smooth scroll is movement, so a user who asked for less movement must
 * not get one.
 */
function scrollBehavior() {
  return prefersReducedMotion() ? "auto" : "smooth";
}

/**
 * Keeps the selection toolbar inside the panel.
 *
 * The toolbar is centred on the selection, so a selection near the left edge
 * pushed half of it outside the panel, where overflow-x:hidden made it
 * unreachable. The toolbar is therefore clamped between the two edges.
 */
function clampToolbarCenter(center, toolbarWidth, panelWidth) {
  const half = toolbarWidth / 2;
  if (!Number.isFinite(center) || !Number.isFinite(half)) return center;
  if (!Number.isFinite(panelWidth) || panelWidth <= 0) return center;
  const min = half;
  const max = Math.max(half, panelWidth - half);
  return Math.min(Math.max(center, min), max);
}

/** Elements a keyboard user can reach with Tab inside a container. */
const FOCUSABLE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
]);

/**
 * The keys a selection is built with.
 *
 * A selection that grows from the place the caret stands is made with one of
 * these, so they are the keys the panel watches for a keyboard selection.
 */
const SELECTION_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * Returns the focusable elements inside a container, in document order.
 * The dialog trap needs this list, and it must not depend on a selector
 * engine the panel can rely on everywhere.
 */
function collectFocusableElements(root) {
  const items = [];
  const visit = (node) => {
    for (const child of node.children || []) {
      const tag = String(child.tagName || "").toLowerCase();
      const tabindex = child.getAttribute?.("tabindex");
      const focusable =
        FOCUSABLE_TAGS.has(tag) ||
        (tabindex !== null && tabindex !== undefined && tabindex !== "-1");
      const disabled = child.getAttribute?.("disabled") !== null;
      const hidden = child.getAttribute?.("hidden") !== null;
      if (focusable && !disabled && !hidden) items.push(child);
      visit(child);
    }
  };
  visit(root);
  return items;
}

/**
 * Keeps the keyboard inside a modal dialog.
 *
 * A dialog that says it is modal has to behave like one: Tab cycles inside
 * it, Shift+Tab walks back, and Escape closes it. The listener sits on the
 * document in the capture phase, so the dialog owns the keyboard for as
 * long as it is open.
 */
function createDialogKeyHandler(dialog, close) {
  return (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;

    const items = collectFocusableElements(dialog);
    if (!items.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !dialog.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };
}

/**
 * Takes the rest of the panel out of reach while a dialog is open.
 *
 * The announcers stay live, so a state change is still spoken. The returned
 * function puts the panel back the way it was.
 */
function makeBackgroundInert(modal) {
  const background = [...(document.body.children || [])].filter(
    (child) =>
      child !== modal &&
      child.id !== "panelStatus" &&
      child.id !== "panelAlert",
  );
  const previousInert = background.map((child) => [child, Boolean(child.inert)]);
  background.forEach((child) => {
    child.inert = true;
  });
  return () => {
    previousInert.forEach(([child, wasInert]) => {
      child.inert = wasInert;
    });
  };
}

// --- Transcript search state ---
// Matches point to visible marks in the active transcript language mode.
// Search navigation only scrolls the panel. It does not seek the video.
let transcriptSearchMatches = [];
let transcriptSearchIndex = -1;

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * transcript queue stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Translation request timed out after 130 seconds. Please Retry.",
        ),
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

/**
 * Decides whether a failed translation deserves another attempt.
 *
 * A missing or refused key never gets better on its own: the user has to
 * open the settings first, so asking again would only spend the user's
 * balance for the same answer. Everything else - a rate limit, a timeout, a
 * model that answered with half a JSON - is worth one more try, because
 * those failures are over by the time the next attempt goes out.
 */
function isRetryableTranslationError(result) {
  if (!result || result.success) return false;

  const code = String(result.code || "").trim().toUpperCase();
  if (code && TRANSLATION_NON_RETRYABLE_ERROR_CODES.has(code)) return false;
  if (code && TRANSLATION_RETRYABLE_ERROR_CODES.has(code)) return true;

  // The worker sends a code when it has one. When it does not, the message
  // is all the panel has, so it has to be read.
  const error = String(result.error || "");
  if (TRANSLATION_KEY_PROBLEM_PATTERN.test(error)) return false;
  if (TRANSLATION_TRANSIENT_PATTERN.test(error)) return true;
  return false;
}

/**
 * Waits before the next attempt. The pause grows with the attempt number, so
 * a provider that is throttling the panel is given more room each time.
 *
 * The wait ends early when the request became pointless - the user left the
 * video or went back to the original language. The panel then stops at once
 * instead of sitting out a pause nobody is waiting for.
 */
function translationRetryDelay(attempt, isStale) {
  const total = TRANSLATION_RETRY_BASE_DELAY_MS * attempt;
  const step = Math.min(TRANSLATION_RETRY_POLL_MS, total);
  return new Promise((resolve) => {
    let waited = 0;
    const wait = () => {
      if (waited >= total || (typeof isStale === "function" && isStale())) {
        resolve();
        return;
      }
      waited += step;
      setTimeout(wait, step);
    };
    wait();
  });
}

/**
 * Sends a translation message and asks again when the failure is one that
 * goes away on its own.
 *
 * The panel used to give up after the first failure: the row kept its error
 * and only a manual "Retry" click could fix it, so a single network hiccup
 * left a paid translation sitting in the original language forever. The
 * retries here cost the user's provider balance only when the previous
 * attempt already failed, and the payload never changes, so the cache key of
 * the batch stays the same.
 *
 * `isStale` is asked before every attempt. When the user has moved on - a
 * different video, a different language mode - the panel stops instead of
 * paying for a result nobody is waiting for.
 */
async function sendTranslationWithRetry(message, isStale) {
  const stale = typeof isStale === "function" ? isStale : () => false;
  let lastResult = null;
  let lastError = null;

  for (let attempt = 0; attempt <= TRANSLATION_MAX_AUTO_RETRIES; attempt += 1) {
    if (stale()) {
      return {
        success: false,
        error: panelCopy("translationCancelled"),
        cancelled: true,
      };
    }
    try {
      const result = await sendTranslationMessage(message);
      if (result?.success || !isRetryableTranslationError(result)) {
        return result;
      }
      lastResult = result;
    } catch (error) {
      // A dead message channel or the watchdog timeout is a temporary
      // problem too, so it gets the same number of chances.
      lastError = error;
      lastResult = null;
    }
    if (attempt < TRANSLATION_MAX_AUTO_RETRIES) {
      await translationRetryDelay(attempt + 1, stale);
    }
  }

  if (!lastResult && lastError) throw lastError;
  return lastResult;
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)

// --- Transcript reading position state ---
// Session storage survives a side panel close but clears when Chrome closes.
const TRANSCRIPT_VIEW_STATE_KEY = "ytd_transcript_view_state";
let pendingTranscriptViewState = null;
let transcriptViewStateSaveTimer = null;
let isRestoringTranscriptView = false;
let selectionActionsController = null;
let lastTranscriptScrollTop = 0;
// True while the explanation dialog owns the screen. The selection toolbar
// stays put while the dialog is open, so the focus can go back to it.
let explainModalOpen = false;
// The width of the selection toolbar, measured after it is shown. The
// toolbar is centred on the selection and clamped inside the panel.
let selectionToolbarWidth = 0;

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed Supadata entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          start: start + duration * ratio,
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) current = { start: piece.start, text: "" };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  setTranscriptModeButtons("original");
  setupEventListeners();
  // The user may add their keys while the panel is open, so watch the
  // settings from the very first moment - including the dead end.
  setupSettingsWatcher();
  await loadPanelLanguage();
  await loadNotesFilter();
  await evictOldCacheEntries(20);
  await bootPanel();
});

/**
 * Loads everything the panel needs once the configuration is usable.
 * Split out of the boot path so the panel can re-enter it after the user
 * adds a key without reloading the document.
 */
async function loadPanelContent() {
  awaitingApiKey = false;
  await refreshGithubSyncStatus();
  // Pull cloud changes when the panel opens (no-op when signed out). The
  // verdict carries a reason code, so a dead token shows the re-login chip
  // instead of resolving quietly: the old chain swallowed exactly the failure
  // that silently ended the backup.
  const notesSync = await chrome.runtime
    .sendMessage({ action: "syncNotes" })
    .catch(() => null);
  await applySyncSessionSignal(notesSync);
  await loadNotes(notesFilterShowAll ? null : currentVideoId);
  await updateWelcomeCounts();
  await checkCurrentTab();
}

/**
 * Reads the configuration and decides what the panel can do.
 * Only the transcript key gates the start: the AI key is required lazily by
 * the Overview tab, which explains the missing key where it is needed.
 */
async function bootPanel() {
  const configStatus = await chrome.runtime
    .sendMessage({ action: "checkConfig" })
    .catch((error) => ({ error: error.message }));

  // A broken service worker or storage area must never be reported as a
  // missing key: the panel used to ask for API keys it did not need.
  if (configStatus?.error) {
    showServiceError(configStatus.error);
    return;
  }

  // A Supadata key is no longer a dead end. The subtitles are read out of
  // the page itself first, and the key is only needed for the fallback. A
  // user without one still gets the transcript of most videos.
  if (!configStatus?.hasSupadataKey && !configStatus?.hasAiKey) {
    showConfigError(configStatus);
    return;
  }

  // Only the fallback key is missing. The panel still works, so it says so
  // once and then gets out of the way: a notice that stays on screen would
  // read like something is broken.
  if (!configStatus?.hasSupadataKey) {
    announceAlert(panelCopy("noCaptionsNoKey"), { notice: true });
  }

  await loadPanelContent();
}

/**
 * Watches the stored settings so the panel recovers from the missing-key
 * dead end as soon as the user fills the settings page.
 */
function setupSettingsWatcher() {
  if (!chrome.storage?.onChanged?.addListener) return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName && areaName !== "local") return;
    const settingsKey =
      typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.STORAGE_KEY
        ? YTD_SETTINGS.STORAGE_KEY
        : "ytd_settings";
    const languageKey =
      typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.UI_LANGUAGE_STORAGE_KEY
        ? YTD_SETTINGS.UI_LANGUAGE_STORAGE_KEY
        : "ytd_options_language";
    if (changes?.[settingsKey]) {
      void handleSettingsChanged();
    }
    if (changes?.[languageKey]) {
      void loadPanelLanguage();
    }
  });
}

/**
 * Re-checks the configuration after the settings changed. A panel that is
 * already working keeps its state; only the dead end is left behind.
 */
async function handleSettingsChanged() {
  if (!awaitingApiKey) return;
  const configStatus = await chrome.runtime
    .sendMessage({ action: "checkConfig" })
    .catch(() => null);
  if (!configStatus || configStatus.error) return;
  if (!configStatus.hasSupadataKey && !configStatus.hasAiKey) return;
  await bootPanel();
}

/**
 * Turns a sync verdict into a visible header state. Only an explicit
 * SYNC_SESSION_EXPIRED code re-renders the chip: a network blip or a 5xx must
 * not push a signed-in user into a re-login prompt, or the prompt stops
 * meaning anything.
 */
async function applySyncSessionSignal(result) {
  if (!result || result.success !== false) return false;
  const code =
    result.code ||
    (result.expired === true && typeof YTD_SETTINGS !== "undefined"
      ? YTD_SETTINGS.SYNC_SESSION_EXPIRED
      : "");
  const expired =
    typeof YTD_SETTINGS !== "undefined" &&
    code === YTD_SETTINGS.SYNC_SESSION_EXPIRED;
  if (expired) await refreshGithubSyncStatus();
  return expired;
}

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startDigestFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    loadNotes(notesFilterShowAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  if (message.action === "githubLoginChanged") {
    refreshGithubSyncStatus();
    loadNotes(notesFilterShowAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  if (message.action === "syncSessionExpired") {
    // A background mirror write (note save, delete, vocabulary) hit a 401
    // while this panel was open: show the re-login chip now rather than waiting
    // for the next panel open.
    refreshGithubSyncStatus();
    sendResponse({ success: true });
  }
  return false;
});

/**
 * Reflects the GitHub sign-in state in the panel header. Three conditions share
 * one control:
 *   - signed out      -> the sign-in button
 *   - signed in       -> the account name, click to sign out
 *   - signed in but the
 *     server rejected
 *     our token (401) -> an explicit "Sync expired" chip whose click re-runs
 *                        OAuth instead of signing out. The cloud mirror has
 *                        stopped, so staying silent here is what let the backup
 *                        die unnoticed.
 */
async function refreshGithubSyncStatus() {
  const syncBtn = document.getElementById("syncBtn");
  const syncAccount = document.getElementById("syncAccount");
  if (!syncBtn || !syncAccount) return;
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getGithubSession",
    });
    const session = result && result.success ? result.session : null;
    const copy = await loadSyncHeaderCopy();
    if (session) {
      const expired = result.expired === true;
      syncBtn.hidden = true;
      syncAccount.hidden = false;
      syncAccount.classList.toggle("sync-account-expired", expired);
      // aria-label wins over title for assistive tech, so the actionable
      // wording survives even where the tooltip is not reachable.
      syncAccount.setAttribute(
        "aria-label",
        expired ? copy.expiredTitle : copy.signedInTitle({ login: session.login }),
      );
      syncAccount.textContent = expired
        ? copy.expiredLabel
        : session.login;
      syncAccount.title = expired
        ? copy.expiredTitle
        : copy.signedInTitle({ login: session.login });
      // The click handler branches on this, so the chip's meaning is stated
      // once here rather than re-derived from the label text.
      syncAccount.dataset.syncExpired = expired ? "true" : "false";
    } else {
      syncBtn.hidden = false;
      syncAccount.hidden = true;
      syncAccount.classList.remove("sync-account-expired");
      delete syncAccount.dataset.syncExpired;
      syncAccount.removeAttribute("aria-label");
    }
  } catch (error) {
    console.error("[YouTube Digest Panel] Sync status error:", error);
  }
}

/**
 * Reads the interface language the user picked on the settings page so the
 * header speaks the same language. Falls back to English when unavailable; the
 * expired state must still render, so this never throws.
 */
async function loadSyncHeaderCopy() {
  let language = "en";
  try {
    const key =
      typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.UI_LANGUAGE_STORAGE_KEY
        ? YTD_SETTINGS.UI_LANGUAGE_STORAGE_KEY
        : "ytd_options_language";
    const stored = await chrome.storage.local.get(key);
    if (typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.normalizeUiLanguage) {
      language = YTD_SETTINGS.normalizeUiLanguage(stored[key]);
    } else if (stored[key] === "zh-CN") {
      language = "zh-CN";
    }
  } catch (error) {
    // Keep the English default.
  }
  if (typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.translateSyncCopy) {
    return {
      expiredLabel: YTD_SETTINGS.translateSyncCopy(language, "expiredLabel"),
      expiredTitle: YTD_SETTINGS.translateSyncCopy(language, "expiredTitle"),
      signedInTitle: (params) =>
        YTD_SETTINGS.translateSyncCopy(language, "signedInTitle", params),
    };
  }
  return {
    expiredLabel: "Sync expired",
    expiredTitle:
      "Your notes are still saved on this device, but the cloud backup stopped because the GitHub session expired. Click to sign in again and resume syncing.",
    signedInTitle: (params) =>
      `Signed in as ${params.login}. Click to sign out.`,
  };
}

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT YouTube  -> the panel closes itself (window.close()).
//     We do this OURSELVES rather than relying only on the background
//     script's per-tab enable/disable, because Chrome doesn't reliably
//     apply per-tab panel state to tabs spawned in unusual ways (e.g. a
//     link opened from another app) — which let the panel linger on
//     non-YouTube pages.
//   - Front tab IS YouTube but on a different video -> refresh the digest.
//     YouTube is a single-page app (clicking a video swaps content without
//     a reload), so we track URL changes; startDigest() caches per video,
//     making re-checks instant and free for already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});

function scheduleDigestRefresh() {
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    checkCurrentTab();
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function handleFrontTabUrl(url) {
  if (!(url || "").startsWith("https://www.youtube.com")) {
    // Start the position save, then close in this same event callback. Chrome
    // does not reliably honor window.close() after an asynchronous wait.
    void saveCurrentTranscriptViewState();
    window.close();
    return;
  }

  const newVideoId = extractVideoId(url);
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newVideoId !== currentVideoId || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

/**
 * Gets the best URL from a tab update that can change the visible page.
 * The status events repeat the close request after Chrome commits the first
 * non-YouTube navigation, when an early URL event alone can be lost.
 */
function getNavigationUrl(changeInfo, tab) {
  if (changeInfo.url) return changeInfo.url;
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") {
    return "";
  }
  return tab.pendingUrl || tab.url || "";
}

// Fires when a tab starts or completes navigation, including YouTube's
// no-reload navigation. The completion event is a deliberate second close
// attempt for the first non-YouTube page.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  const url = getNavigationUrl(changeInfo, tab);
  if (!url) return;
  handleFrontTabUrl(url);
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Brand-new tabs may not have committed their URL yet — fall back to
    // the pending one so we judge where the tab is actually going.
    handleFrontTabUrl(tab.url || tab.pendingUrl || "");
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    tab.addEventListener("keydown", handleTabKeydown);
  });

  // The welcome page is a way in, not a dead end: the vocabulary and the
  // library do not need a video.
  document.getElementById("welcomeWordsBtn")?.addEventListener("click", () => {
    showState("results");
    switchTab("words");
  });
  document.getElementById("welcomeLibraryBtn")?.addEventListener("click", () => {
    showState("results");
    switchTab("library");
  });

  // The summary is bought with one click, and the click is the consent.
  document
    .getElementById("summaryGenerateBtn")
    ?.addEventListener("click", () => {
      void triggerAnalysis();
    });

  // Notes: compose, export.
  document
    .getElementById("quickNoteSaveBtn")
    ?.addEventListener("click", () => {
      void saveQuickNote();
    });
  document.getElementById("quickNoteInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void saveQuickNote();
    }
  });
  document
    .getElementById("exportNotesBtn")
    ?.addEventListener("click", () => {
      void exportNotesAsMarkdown();
    });

  // Words: refresh and review.
  document.getElementById("wordsRefreshBtn")?.addEventListener("click", () => {
    void loadVocabulary();
    void loadDueReviews();
  });
  document.getElementById("reviewCard")?.addEventListener("click", () => {
    revealReviewAnswer();
  });
  document
    .querySelectorAll("#reviewActions .grade-btn")
    .forEach((button) => {
      button.addEventListener("click", () => {
        void submitReviewGrade(Number(button.dataset.grade));
      });
    });

  // Library: search.
  document.getElementById("librarySearchInput")?.addEventListener("input", (event) => {
    librarySearchQuery = String(event.target?.value || "");
    renderLibrary();
  });

  // The visible notice can be dismissed. An error waits for the user, so it
  // needs a way out that does not involve waiting.
  document.getElementById("panelToastClose")?.addEventListener("click", () => {
    hideToast();
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      errorAction();
      return;
    }
    if (currentVideoId) {
      startDigest(currentVideoId, currentVideoUrl);
    }
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // GitHub sync: sign-in opens the OAuth flow; the account button signs out.
  document.getElementById("syncBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "startGithubLogin" });
  });
  document.getElementById("syncAccount")?.addEventListener("click", async () => {
    const syncAccount = document.getElementById("syncAccount");
    // Expired sessions must re-authenticate. Signing out instead would throw
    // away the only pointer to the dead token and quietly return the user to
    // the signed-out state, hiding the very problem this state reports.
    if (syncAccount?.dataset.syncExpired === "true") {
      await chrome.runtime.sendMessage({ action: "startGithubLogin" });
      await refreshGithubSyncStatus();
      return;
    }
    await chrome.runtime.sendMessage({ action: "logoutGithub" });
    await refreshGithubSyncStatus();
    loadNotes(notesFilterShowAll ? null : currentVideoId);
  });

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleDisplayLanguageModeChange(button.dataset.transcriptMode);
    });
  });
  setupTranscriptSearch();

  // pagehide also covers closing the side panel without a tab change.
  window.addEventListener("pagehide", () => {
    void saveCurrentTranscriptViewState();
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });
}

function setNotesFilter(showAll, { persist = true } = {}) {
  notesFilterShowAll = Boolean(showAll);
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
  if (persist) void saveNotesFilter(notesFilterShowAll);
}

/**
 * Restores the notes filter the user picked last time. The panel document is
 * recreated on every open, so reading the buttons back from the markup would
 * silently reset the choice.
 */
async function loadNotesFilter() {
  try {
    const stored = await chrome.storage.local.get(NOTES_FILTER_KEY);
    notesFilterShowAll = stored?.[NOTES_FILTER_KEY] === "all";
  } catch (error) {
    notesFilterShowAll = false;
  }
  setNotesFilter(notesFilterShowAll, { persist: false });
}

async function saveNotesFilter(showAll) {
  try {
    await chrome.storage.local.set({
      [NOTES_FILTER_KEY]: showAll ? "all" : "this",
    });
  } catch (error) {
    // A failed preference write must never interrupt the user.
  }
}

// ============================================================
// VIDEO DETECTION
// ============================================================

/**
 * Reads the tab the panel belongs to. The panel belongs only to the active
 * tab: looking for another open YouTube tab here can keep an old transcript
 * visible on a non-YouTube page, so never fall back to background tabs.
 */
async function getFrontTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return tabs[0] || null;
}

/**
 * Reads the title, the channel and the description of the video on screen.
 * A failure is not fatal: the panel shows the transcript without them.
 */
async function requestVideoMetadata() {
  try {
    // Route through background script for reliable message passing
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: { action: "getVideoInfo" },
    });
    debugLog("[YouTube Digest Panel] getVideoInfo result:", result);
    if (result?.success && result.response) return result.response;
  } catch (e) {
    console.error("[YouTube Digest Panel] getVideoInfo error:", e);
  }
  return null;
}

async function checkCurrentTab() {
  try {
    const tab = await getFrontTab();

    debugLog("[YouTube Digest Panel] Found tab:", tab?.id, tab?.url);

    if (!tab?.url) {
      showState("welcome");
      return;
    }

    if (!tab.url.startsWith("https://www.youtube.com")) {
      handleFrontTabUrl(tab.url);
      return;
    }

    // Store the tab ID for reliable messaging later
    youtubeTabId = tab.id;

    const videoId = extractVideoId(tab.url);

    if (!videoId) {
      showState("welcome");
      return;
    }

    const metadata = await requestVideoMetadata();

    // The user can move to another video while the metadata request is on
    // the wire. The title that just arrived belongs to the video we asked
    // about, so it must not be applied to the video on screen now.
    const frontTab = await getFrontTab();
    const frontVideoId = frontTab?.url
      ? extractVideoId(frontTab.url)
      : null;
    if (frontVideoId !== videoId) {
      // The video changed under us. The navigation handler refreshes the
      // panel for the new video, so this run has nothing left to do.
      return;
    }

    if (metadata) {
      currentVideoTitle = metadata.title || "";
      currentChannelName = metadata.channelName || "";
      currentVideoDescription = metadata.description || "";
      currentVideoDuration = metadata.duration || 0;
    }
    currentVideoUrl = tab.url;

    startDigest(videoId, tab.url);
  } catch (error) {
    console.error("Tab check error:", error);
    showState("welcome");
  }
}

/**
 * Finds the video id in whatever shape YouTube serves a video.
 *
 * The content script already knows how to read a Shorts, a live page or an
 * embedded player, and it puts a Digest button on all of them. The panel
 * has to agree: a button that opens a panel which says "no video" is worse
 * than no button at all.
 *
 * @param {string} url the page URL
 * @returns {string|null} the video id, or null when the page has no video
 */
function extractVideoId(url) {
  try {
    const urlObj = new URL(url);
    const candidates = [];

    if (
      urlObj.hostname.includes("youtube.com") &&
      urlObj.searchParams.has("v")
    ) {
      candidates.push(urlObj.searchParams.get("v"));
    }

    if (urlObj.hostname === "youtu.be" || urlObj.hostname === "www.youtu.be") {
      candidates.push(urlObj.pathname.split("/")[1]);
    }

    // /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
    const pathPrefixes = ["embed", "shorts", "live", "v"];
    const segments = urlObj.pathname.split("/").filter(Boolean);
    if (
      segments.length >= 2 &&
      pathPrefixes.includes(segments[0].toLowerCase())
    ) {
      candidates.push(segments[1]);
    }

    for (const candidate of candidates) {
      if (candidate && /^[A-Za-z0-9_-]{6,20}$/.test(candidate)) {
        return candidate;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

/**
 * Moves the panel to another video. The chapters, the quotes and the analysis
 * on screen belong to the video the user just left, so they must not stay
 * visible for the new one.
 */
function onVideoChanged(videoId) {
  currentVideoId = videoId;
  // The ticket changes with the video, so a response for the video the user
  // left can never be applied to the one on screen.
  videoTicket += 1;
  currentAnalysis = null;
  // A new video on screen is the live one, not a saved copy.
  showingCachedVideo = false;
  renderCachedViewNote();
  clearOverviewLists();
}

async function startDigest(videoId, videoUrl) {
  // Check if we already have this video loaded in memory
  if (videoId === currentVideoId && currentAnalysis) {
    showState("results");
    return;
  }

  // A digest run started. This counts runs, not video changes: a re-run for
  // the same video is a new run, but the work it does is still valid.
  digestRunCount += 1;
  debugLog("[YouTube Digest Panel] Digest run", digestRunCount, videoId);

  // The video on screen changed. Everything the panel shows belongs to the
  // video the user just left, so it has to go before the new one is fetched.
  const videoChanged = videoId !== currentVideoId;
  if (videoChanged) onVideoChanged(videoId);

  // The ticket this run belongs to. It only changes when the video changes,
  // so a response that is still valid is never thrown away.
  const ticket = videoTicket;

  // Every video change invalidates observer work and in-flight translations.
  if (videoChanged) {
    translationGeneration += 1;
    if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
    resetTranscriptSearch();
    lastTranscriptScrollTop = 0;
    // A failed interface translation used to be permanent: the failure set
    // was only cleared by a mode switch, so one timeout blocked the same
    // chapter for the rest of the panel's life.
    interfaceTranslationFailures.clear();
    interfaceTranslationInFlight.clear();
    pruneTranslationCachesForVideo(videoId);
    pendingTranscriptViewState = await loadTranscriptViewState(videoId);
    if (ticket !== videoTicket) return;
    // An unseen video always starts in Original, so opening it never spends
    // translation tokens. A saved choice is restored only for this video.
    currentTranscriptMode = await loadDisplayLanguageMode(videoId);
    if (ticket !== videoTicket) return;
    document
      .getElementById("contentArea")
      ?.classList.toggle(
        "restoring-transcript-view",
        Boolean(pendingTranscriptViewState),
      );
  }

  // Check cache for this video
  const cached = await loadFromCache(videoId);
  if (ticket !== videoTicket) return;
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoUrl = videoUrl;
    currentAnalysis = cached.analysis || null;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage = cached.transcriptLanguage || null;

    // Restore semantic-segment translations from persistent storage.
    if (cached.paragraphCache) {
      for (const [key, value] of Object.entries(cached.paragraphCache)) {
        transcriptParagraphCache.set(key, value);
      }
    }
    if (cached.interfaceCache) {
      for (const [key, value] of Object.entries(cached.interfaceCache)) {
        interfaceTranslationCache.set(key, value);
      }
    }

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      document.getElementById("videoChannel").textContent = currentChannelName;
      videoInfo.style.display = "block";
    }

    // Always render transcript first
    renderTranscript();

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
    }

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";
    restorePendingTranscriptViewState(videoId);

    // Load notes for this video
    loadNotes(notesFilterShowAll ? null : videoId);

    // Setup explain feature
    setupExplainFeature();
    if (currentTranscriptMode !== "original") translateTranscript();
    return;
  }

  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById("videoInfo");
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    videoInfo.style.display = "block";
  }

  showState("loading");
  updateLoading(panelCopy("fetchingTranscript"), panelCopy("extractingCaptions"));

  // A transcript lookup can cost a Supadata credit, when the local caption
  // read did not work and the paid fallback had to run. The ledger makes
  // sure the panel pays for it once, no matter how many runs ask for it.
  const transcriptRequest = startPaidRequest(transcriptLedger, videoId, () =>
    chrome.runtime.sendMessage({
      action: "fetchTranscript",
      videoId: videoId,
      // The worker reads the captions out of the page itself when it can,
      // and only spends a credit when it cannot.
      tabId: youtubeTabId,
    }),
  );
  const transcriptResult = await transcriptRequest.promise;

  // The video can change while the transcript is on the wire. A transcript
  // for a video the user already left must not overwrite the current one.
  if (ticket !== videoTicket || videoId !== currentVideoId) return;

  if (!transcriptResult.success) {
    showTranscriptError(transcriptResult);
    return;
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptLanguage = transcriptResult.language || null;

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";
  restorePendingTranscriptViewState(videoId);

  // Load notes for this video
  loadNotes(videoId);

  // Setup explain feature for text selection
  setupExplainFeature();
  if (currentTranscriptMode !== "original") translateTranscript();

  // Save transcript to cache (without analysis)
  await saveToCache(videoId);

  // DON'T run LLM analysis automatically - wait for user to click Overview tab
  // This saves tokens when user just wants to see the transcript
}

// ============================================================
// RENDERING
// ============================================================

function interfaceTranslationCacheKey(surface, id, text) {
  return `${currentVideoId || "none"}:zh:${surface}:${id}:${text}`;
}

/**
 * Drops the translation caches that belong to other videos. The caches live
 * for the whole life of the panel document, so without this they grew
 * without bound while the user moved from video to video.
 */
function pruneTranslationCachesForVideo(videoId) {
  if (!videoId) return;
  const prefix = `${videoId}:`;
  for (const key of [...transcriptParagraphCache.keys()]) {
    if (!key.startsWith(prefix)) transcriptParagraphCache.delete(key);
  }
  for (const key of [...interfaceTranslationCache.keys()]) {
    if (!key.startsWith(prefix)) interfaceTranslationCache.delete(key);
  }
}

function getInterfaceTranslation(surface, id, text) {
  return interfaceTranslationCache.get(
    interfaceTranslationCacheKey(surface, id, text),
  );
}

function renderLocalizedContent(text, surface, id) {
  const original = String(text || "");
  if (!original) return "";
  const cacheKey = interfaceTranslationCacheKey(surface, id, original);
  const translated = getInterfaceTranslation(surface, id, original);
  if (currentTranscriptMode === "original") return escapeHtml(original);

  const translation = translated
    ? escapeHtml(translated)
    : interfaceTranslationFailures.has(cacheKey)
      ? `<span class="translation-error">${escapeHtml(panelCopy("translationUnavailable"))}</span><button class="translation-retry-btn" type="button" data-interface-retry-surface="${escapeHtml(surface)}" data-interface-retry-id="${escapeHtml(id)}">${escapeHtml(panelCopy("retry"))}</button>`
      : `<span class="translation-pending">${escapeHtml(panelCopy("translating"))}</span>`;
  if (currentTranscriptMode === "bilingual") {
    return `<span class="localized-copy"><span class="localized-original">${escapeHtml(original)}</span><span class="localized-translation">${translation}</span></span>`;
  }
  return `<span class="localized-copy"><span class="localized-translation">${translation}</span></span>`;
}

/**
 * Retries one failed interface translation. The failure set is a deny list,
 * so the key has to be removed before the segment is requested again.
 */
async function retryInterfaceTranslation(surface, id) {
  const prefix = `${currentVideoId || "none"}:zh:${surface}:${id}:`;
  for (const key of [...interfaceTranslationFailures]) {
    if (key.startsWith(prefix)) interfaceTranslationFailures.delete(key);
  }
  if (surface === "overview") {
    if (currentAnalysis) renderAnalysisResults(currentAnalysis);
    void translateOverviewContent();
    return;
  }
  if (surface === "notes") {
    if (currentNotes.length) renderNotes(currentNotes, currentNotesFilterVideoId);
    void translateNotesContent();
  }
}

// The retry button lives inside the chapter/quote rows, which have their own
// click handlers (they seek the video). Listening in the capture phase means
// the retry wins and the row click never fires.
function handleInterfaceRetryClick(event) {
  const trigger = event.target?.closest?.("[data-interface-retry-surface]");
  if (!trigger) return;
  event.preventDefault();
  event.stopPropagation();
  void retryInterfaceTranslation(
    trigger.getAttribute("data-interface-retry-surface"),
    trigger.getAttribute("data-interface-retry-id"),
  );
}

document.addEventListener("click", handleInterfaceRetryClick, true);

function getLocalizedPlainText(text, surface, id) {
  const original = String(text || "");
  const translated = getInterfaceTranslation(surface, id, original);
  if (currentTranscriptMode === "zh") return translated || original;
  if (currentTranscriptMode === "bilingual" && translated) {
    return `${original}\n\n${translated}`;
  }
  return original;
}

async function translateInterfaceSegments(surface, segments, rerender) {
  if (currentTranscriptMode === "original" || !segments.length) return;
  const generation = translationGeneration;
  const videoId = currentVideoId;
  const missing = segments
    .filter((segment) => segment.text)
    .map((segment) => ({
      ...segment,
      cacheKey: interfaceTranslationCacheKey(
        surface,
        segment.id,
        segment.text,
      ),
    }))
    .filter(
      (segment) =>
        !interfaceTranslationCache.has(segment.cacheKey) &&
        !interfaceTranslationFailures.has(segment.cacheKey) &&
        !interfaceTranslationInFlight.has(segment.cacheKey),
    );
  if (!missing.length) return;

  // The batch belongs to the video, the mode and the generation it was
  // started for. Once one of them changes, the answer is worth nothing to
  // the user, so the retries stop as well.
  const isStaleBatch = () =>
    generation !== translationGeneration ||
    videoId !== currentVideoId ||
    currentTranscriptMode === "original";

  missing.forEach((segment) => interfaceTranslationInFlight.add(segment.cacheKey));
  setTranslatingSpinner(true);
  try {
    for (
      let start = 0;
      start < missing.length;
      start += TRANSLATION_BATCH_SIZE
    ) {
      const batch = missing.slice(start, start + TRANSLATION_BATCH_SIZE);
      let result;
      try {
        // The payload is built once and never changes between the attempts,
        // so every attempt asks for the very same thing and the cache key of
        // the batch stays correct.
        result = await sendTranslationWithRetry(
          {
            action: "translateContent",
            content: {
              segments: batch.map(({ id, text }) => ({ id, text })),
            },
            contentType: "interfaceBatch",
            targetLanguage: "zh",
            videoTitle: currentVideoTitle,
          },
          isStaleBatch,
        );
      } catch (error) {
        console.error("[YouTube Digest] Interface batch error:", error);
        result = { success: false, error: error.message };
      }
      if (isStaleBatch()) {
        return;
      }
      const aligned = alignTranslatedSegmentBatch(
        batch,
        result?.success ? result.translatedContent?.segments : [],
      );
      aligned.forEach((item, index) => {
        if (item.text) {
          interfaceTranslationCache.set(batch[index].cacheKey, item.text);
        } else {
          // Only now, with every automatic attempt used up, does the segment
          // go on the list of the ones the panel gave up on. Until then the
          // "Retry" button is still there for the user to press.
          interfaceTranslationFailures.add(batch[index].cacheKey);
        }
      });
      // Match the Transcript UX: reveal and persist every small batch as soon
      // as it returns instead of waiting for the full Overview or Notes list.
      rerender();
      await updateCache();
    }
  } catch (error) {
    console.error("[YouTube Digest] Interface translation error:", error);
    missing.forEach((segment) =>
      interfaceTranslationFailures.add(segment.cacheKey),
    );
  } finally {
    missing.forEach((segment) => interfaceTranslationInFlight.delete(segment.cacheKey));
    setTranslatingSpinner(false);
  }
}

function getOverviewTranslationSegments() {
  if (!currentAnalysis) return [];
  const segments = [];
  // The summary is the first thing the reader sees, so it is translated too.
  // Its id is stable, so a summary that was already translated is not paid
  // for twice.
  if (currentAnalysis.summary) {
    segments.push({ id: "summary", text: currentAnalysis.summary });
  }
  (currentAnalysis.chapters || []).forEach((chapter, index) => {
    if (chapter.title) {
      segments.push({ id: `chapter-${index}-title`, text: chapter.title });
    }
    if (chapter.summary) {
      segments.push({ id: `chapter-${index}-summary`, text: chapter.summary });
    }
  });
  [...(currentAnalysis.keyQuotes || [])]
    .sort((a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0))
    .forEach((quote, index) => {
      if (quote.quote) segments.push({ id: `quote-${index}`, text: quote.quote });
    });
  return segments;
}

function translateOverviewContent() {
  return translateInterfaceSegments(
    "overview",
    getOverviewTranslationSegments(),
    () => {
      const contentArea = document.getElementById("contentArea");
      const scrollTop = contentArea?.scrollTop || 0;
      renderAnalysisResults(currentAnalysis);
      if (contentArea) contentArea.scrollTop = scrollTop;
    },
  );
}

function getNoteTranslationId(note, index) {
  const stablePart = String(note.id || note.createdAt || index)
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 96);
  return `note-${stablePart || index}`;
}

function translateNotesContent() {
  const segments = currentNotes.map((note, index) => ({
    id: getNoteTranslationId(note, index),
    text: note.text || "",
  }));
  return translateInterfaceSegments("notes", segments, () => {
    const contentArea = document.getElementById("contentArea");
    const scrollTop = contentArea?.scrollTop || 0;
    renderNotes(currentNotes, currentNotesFilterVideoId);
    if (contentArea) contentArea.scrollTop = scrollTop;
  });
}

/**
 * Empties the Overview tab and puts the empty state back.
 *
 * The chapters and the quotes on screen belong to the video that was open
 * before. Leaving them there would let the user save a note from the
 * previous video under the new one.
 */
function clearOverviewLists() {
  // The summary belongs to the video that was open before, so it goes with
  // the chapters and the quotes.
  const summaryBlock = document.getElementById("summaryBlock");
  if (summaryBlock) summaryBlock.hidden = true;
  const summaryText = document.getElementById("summaryText");
  if (summaryText) summaryText.innerHTML = "";

  const chapterList = document.getElementById("chapterList");
  if (chapterList) {
    chapterList.innerHTML = "";
    const item = document.createElement("li");
    item.className = "chapter-item";
    item.style.color = "var(--text-muted)";
    item.style.cursor = "default";
    item.style.borderColor = "var(--border)";
    item.textContent = panelCopy("chaptersEmpty");
    chapterList.appendChild(item);
  }

  const quotesList = document.getElementById("quotesList");
  if (quotesList) {
    quotesList.innerHTML = "";
    const item = document.createElement("div");
    item.className = "quote-item";
    item.style.color = "var(--text-muted)";
    item.style.borderLeftColor = "var(--border)";
    item.style.cursor = "default";
    const text = document.createElement("div");
    text.className = "quote-text";
    text.style.fontStyle = "normal";
    text.textContent = panelCopy("quotesEmpty");
    item.appendChild(text);
    quotesList.appendChild(item);
  }
}

/**
 * Renders the analysis results into the Overview tab.
 * Shows chapters and key quotes only.
 */
function renderAnalysisResults(analysis) {
  // The summary is here, so the invitation to pay for it is not.
  hideSummaryGate();

  // The summary text is the first thing the reader sees. An old cache or a
  // model that wrote no summary leaves the block out entirely, so there is
  // never an empty shell on screen.
  const summaryBlock = document.getElementById("summaryBlock");
  const summaryText = document.getElementById("summaryText");
  const summary = String(analysis?.summary || "").trim();
  if (summaryBlock) summaryBlock.hidden = !summary;
  if (summaryText) {
    summaryText.innerHTML = summary
      ? renderLocalizedContent(summary, "overview", "summary")
      : "";
  }

  // Chapters
  const chapterList = document.getElementById("chapterList");
  chapterList.innerHTML = "";
  (analysis.chapters || []).forEach((chapter, index) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = chapter.timestampSeconds;
    const stamp = displayTimestamp(chapter);
    // The timestamp is a real button, so a keyboard user can jump to a
    // chapter. The list item keeps its list semantics and stays clickable
    // for the mouse, and the click of the button bubbles up to it.
    li.innerHTML = `
      <button class="chapter-timestamp" type="button" style="border: none; cursor: pointer;" aria-label="${escapeHtml(panelCopyFormat("jumpTo", { time: stamp }))}">${escapeHtml(stamp)}</button>
      <div class="chapter-content">
        <span class="chapter-title">${renderLocalizedContent(chapter.title, "overview", `chapter-${index}-title`)}</span>
        <span class="chapter-summary">${renderLocalizedContent(chapter.summary || "", "overview", `chapter-${index}-summary`)}</span>
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Chapter clicked:",
        stamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });
  if (!chapterList.children.length) {
    // The model wrote a summary but no chapters. An empty list under a
    // heading looks like the panel broke, so it says what happened.
    const item = document.createElement("li");
    item.className = "chapter-item";
    item.style.color = "var(--text-muted)";
    item.style.cursor = "default";
    item.style.borderColor = "var(--border)";
    item.textContent = panelCopy("chaptersNone");
    chapterList.appendChild(item);
  }

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  quotesList.innerHTML = "";
  const sortedQuotes = [...(analysis.keyQuotes || [])].sort(
    (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
  );
  sortedQuotes.forEach((quote, index) => {
    const div = document.createElement("div");
    div.className = "quote-item";
    div.dataset.seconds = quote.timestampSeconds;
    const stamp = displayTimestamp(quote);

    // The quote card already holds two buttons of its own, so the card
    // cannot be a button as well: nested controls are a trap for screen
    // reader users. The timestamp is the control that jumps to the quote.
    div.innerHTML = `
      <div class="quote-text">${renderLocalizedContent(quote.quote, "overview", `quote-${index}`)}</div>
      <div class="quote-meta">
        <button class="quote-timestamp" type="button" style="border: none; cursor: pointer;" aria-label="${escapeHtml(panelCopyFormat("jumpTo", { time: stamp }))}">${escapeHtml(stamp)}</button>
        <div class="quote-actions">
          <button class="quote-save-note-btn" type="button" title="${escapeHtml(panelCopy("saveNote"))}">${escapeHtml(panelCopy("note"))}</button>
          <button class="quote-copy-btn" type="button" title="${escapeHtml(panelCopy("copyQuote"))}">${escapeHtml(panelCopy("copy"))}</button>
        </div>
      </div>
    `;

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");

    div.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Quote clicked:",
        stamp,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });

    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(
          getLocalizedPlainText(quote.quote, "overview", `quote-${index}`),
        );
        quoteCopyBtn.textContent = panelCopy("copied");
        setTimeout(() => {
          quoteCopyBtn.textContent = panelCopy("copy");
        }, 1500);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    quoteSaveNoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveQuoteAsNote(quote, quoteSaveNoteBtn);
    });

    quotesList.appendChild(div);
  });
  if (!quotesList.children.length) {
    // The model wrote a summary but no quotes. An empty list under a
    // heading looks like the panel broke, so it says what happened.
    const item = document.createElement("div");
    item.className = "quote-item";
    item.style.color = "var(--text-muted)";
    item.style.borderLeftColor = "var(--border)";
    item.style.cursor = "default";
    const text = document.createElement("div");
    text.className = "quote-text";
    text.style.fontStyle = "normal";
    text.textContent = panelCopy("quotesNone");
    item.appendChild(text);
    quotesList.appendChild(item);
  }

  if (
    currentTranscriptMode !== "original" &&
    resultTabIsActive("overview")
  ) {
    void translateOverviewContent();
  }
}

/**
 * Saves a key quote as a timestamped note.
 *
 * The quote itself travels with the request. Without it the background would
 * have to look the transcript up again - another lookup, and a credit if the
 * fallback has to run - and clean up a different line with the AI, throwing
 * the quote the user picked away.
 */
async function saveQuoteAsNote(quote, btn) {
  if (!currentVideoId) return;

  const originalText = btn.textContent;
  btn.textContent = panelCopy("saving");
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      quote: quote.quote,
    });

    if (result.success) {
      btn.textContent = panelCopy("saved");
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      loadNotes(currentVideoId);
    } else {
      console.error("[YouTube Digest] Save quote as note failed:", result.error);
      // The button says "Error" for a second and a half, which nobody reads.
      // The note is gone, so the reason is said out loud.
      announceAlert(noteSaveFailureMessage(result));
      btn.textContent = panelCopy("errorTitle");
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error("[YouTube Digest] Save quote as note error:", error);
    announceAlert(panelCopy("couldNotSave"));
    btn.textContent = panelCopy("errorTitle");
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  renderTranscript();

  document.getElementById("tabsNav").style.display = "flex";

  // Setup explain feature for text selection
  setupExplainFeature();
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    const timestamp = YTD_SETTINGS.formatTimestamp(group.start);

    // The timestamp is a real button, so a keyboard user can jump to the
    // moment and a screen reader hears a control instead of loose text.
    div.innerHTML = `
      <button class="transcript-time" type="button" style="border: none; background: none; text-align: left; align-self: flex-start; cursor: pointer;" aria-label="${escapeHtml(panelCopyFormat("jumpTo", { time: timestamp }))}">${timestamp}</button>
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
    `;

    // The timestamp always seeks, even while text is selected. The row
    // itself stays quiet then, so a selection can be explained or copied.
    const timeButton = div.querySelector(".transcript-time");
    timeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      seekTo(group.start);
    });

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );
    transcriptList.appendChild(div);
  });

  // Reapply an active query after a language mode rerenders the transcript.
  refreshTranscriptSearch({ preserveIndex: false, scroll: false });

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

// ============================================================
// TRANSCRIPT SEARCH
// ============================================================

/**
 * Finds separate, case-insensitive literal matches. A literal search is
 * important here because punctuation such as "." must be treated as transcript
 * text, not as a regular expression command.
 */
function findLiteralTranscriptMatches(text, query) {
  const source = String(text || "");
  const needle = String(query || "").trim();
  if (!needle) return [];

  const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(escapedNeedle, "giu");
  const matches = [];
  for (const match of source.matchAll(matcher)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }

  return matches;
}

/**
 * Removes old marks before a new search. Restoring plain text first prevents
 * nested marks when the user types one more letter into the search field.
 */
function clearTranscriptSearchHighlights() {
  document
    .querySelectorAll("#transcriptList mark.transcript-search-highlight")
    .forEach((mark) => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
      parent?.normalize();
    });

  document
    .querySelectorAll("#transcriptList .transcript-entry.search-current")
    .forEach((row) => row.classList.remove("search-current"));
}

/**
 * Replaces matching parts of one text node with mark elements. We collect all
 * text nodes before changing the DOM, so each replacement is safe and stable.
 */
function markTranscriptTextNode(textNode, query) {
  const ranges = findLiteralTranscriptMatches(textNode.nodeValue, query);
  if (!ranges.length) return [];

  const fragment = document.createDocumentFragment();
  const marks = [];
  let cursor = 0;

  ranges.forEach(({ start, end }) => {
    if (start > cursor) {
      fragment.appendChild(
        document.createTextNode(textNode.nodeValue.slice(cursor, start)),
      );
    }

    const mark = document.createElement("mark");
    mark.className = "transcript-search-highlight";
    mark.textContent = textNode.nodeValue.slice(start, end);
    fragment.appendChild(mark);
    marks.push(mark);
    cursor = end;
  });

  if (cursor < textNode.nodeValue.length) {
    fragment.appendChild(
      document.createTextNode(textNode.nodeValue.slice(cursor)),
    );
  }

  textNode.parentNode.replaceChild(fragment, textNode);
  return marks;
}

/**
 * Updates the result count and navigation buttons from the current search
 * state. The live output gives the same information to screen reader users.
 */
function updateTranscriptSearchControls(query) {
  const count = document.getElementById("transcriptSearchCount");
  const previous = document.getElementById("transcriptSearchPrevBtn");
  const next = document.getElementById("transcriptSearchNextBtn");
  const hasMatches = transcriptSearchMatches.length > 0;

  if (count) {
    count.textContent = !query
      ? ""
      : hasMatches
        ? `${transcriptSearchIndex + 1} of ${transcriptSearchMatches.length}`
        : panelCopy("searchNoMatches");
  }
  if (previous) previous.disabled = !hasMatches;
  if (next) next.disabled = !hasMatches;
}

/**
 * Shows which match is current. Search navigation pauses automatic transcript
 * following, so playback cannot pull the user away from the result they found.
 */
function revealCurrentTranscriptSearchMatch({ scroll = true } = {}) {
  transcriptSearchMatches.forEach((mark) => mark.classList.remove("current"));
  document
    .querySelectorAll("#transcriptList .transcript-entry.search-current")
    .forEach((row) => row.classList.remove("search-current"));

  const mark = transcriptSearchMatches[transcriptSearchIndex];
  if (!mark) return;

  mark.classList.add("current");
  mark.closest(".transcript-entry")?.classList.add("search-current");

  if (!scroll) return;
  if (autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
  mark.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
}

/**
 * Searches the transcript that is visible now. This means Original searches
 * source subtitles, Chinese searches translated text, and Bilingual searches
 * both columns. Translated rows call this again as their text arrives.
 */
function refreshTranscriptSearch({ preserveIndex = false, scroll = true } = {}) {
  const input = document.getElementById("transcriptSearchInput");
  const clearButton = document.getElementById("transcriptSearchClearBtn");
  const query = String(input?.value || "").trim();
  const previousIndex = transcriptSearchIndex;

  clearTranscriptSearchHighlights();
  transcriptSearchMatches = [];
  transcriptSearchIndex = -1;
  if (clearButton) clearButton.hidden = !input?.value;

  if (!query) {
    updateTranscriptSearchControls(query);
    return;
  }

  document
    .querySelectorAll("#transcriptList .transcript-entry")
    .forEach((row) => {
      const content = row.querySelector(".transcript-text, .transcript-copy");
      if (!content) return;

      const textNodes = [];
      const walker = document.createTreeWalker(
        content,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!node.nodeValue || parent?.closest("button")) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      textNodes.forEach((node) => {
        transcriptSearchMatches.push(...markTranscriptTextNode(node, query));
      });
    });

  if (transcriptSearchMatches.length) {
    transcriptSearchIndex = preserveIndex
      ? Math.min(Math.max(previousIndex, 0), transcriptSearchMatches.length - 1)
      : 0;
    revealCurrentTranscriptSearchMatch({ scroll });
  }
  updateTranscriptSearchControls(query);
}

/**
 * Moves through results in a loop, like the browser's built-in Find control.
 */
function moveTranscriptSearch(direction) {
  if (!transcriptSearchMatches.length) return;
  transcriptSearchIndex =
    (transcriptSearchIndex + direction + transcriptSearchMatches.length) %
    transcriptSearchMatches.length;
  revealCurrentTranscriptSearchMatch();
  updateTranscriptSearchControls(
    document.getElementById("transcriptSearchInput")?.value.trim(),
  );
}

/**
 * Clears search when the user opens a different video. A query for the old
 * video is unlikely to help and can make the next transcript look empty.
 */
function resetTranscriptSearch({ focus = false } = {}) {
  const input = document.getElementById("transcriptSearchInput");
  if (input) input.value = "";
  refreshTranscriptSearch({ scroll: false });
  if (focus) input?.focus();
}

/**
 * Wires mouse and keyboard controls once when the side panel starts.
 */
function setupTranscriptSearch() {
  const input = document.getElementById("transcriptSearchInput");
  const clearButton = document.getElementById("transcriptSearchClearBtn");
  const previous = document.getElementById("transcriptSearchPrevBtn");
  const next = document.getElementById("transcriptSearchNextBtn");
  if (!input) return;

  input.addEventListener("input", () => refreshTranscriptSearch());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      moveTranscriptSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && input.value) {
      event.preventDefault();
      resetTranscriptSearch({ focus: true });
    }
  });

  clearButton?.addEventListener("click", () => {
    resetTranscriptSearch({ focus: true });
  });
  previous?.addEventListener("click", () => moveTranscriptSearch(-1));
  next?.addEventListener("click", () => moveTranscriptSearch(1));
}

function getDisplayedTranscriptText() {
  if (currentTranscriptMode === "original") return currentTranscriptText || "";
  return getActiveTranscriptSegments()
    .map((segment) => {
      const translated = transcriptParagraphCache.get(
        transcriptTranslationCacheKey(segment),
      );
      if (currentTranscriptMode === "zh") return translated || segment.text;
      return translated ? `${segment.text}\n${translated}` : segment.text;
    })
    .join("\n\n");
}

function copyTranscript() {
  copyToClipboardWithFeedback(getDisplayedTranscriptText(), "copyTranscriptBtn");
}

function exportTranscript() {
  const transcriptContent = getDisplayedTranscriptText();
  const videoUrl = `https://youtube.com/watch?v=${currentVideoId}`;

  let exportText = "";
  exportText += `TRANSCRIPT\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `Title: ${currentVideoTitle || "Unknown"}\n`;
  exportText += `Channel: ${currentChannelName || "Unknown"}\n`;
  exportText += `URL: ${videoUrl}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (currentVideoDescription) {
    exportText += `DESCRIPTION:\n${currentVideoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `TRANSCRIPT:\n\n${transcriptContent}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `Exported by YouTube Digest\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript.txt`;
  downloadTextFile(exportText, filename);
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

/**
 * Writes a message into a live region.
 *
 * The region is a permanent, visually hidden live region. It never leaves the
 * DOM, so the message is read out no matter which state container is on
 * screen. A live region inside a container that is hidden with display:none
 * is never announced, which is why the panel announces here instead of inside
 * the state blocks.
 */
function writeLiveRegion(regionId, message) {
  const region = document.getElementById(regionId);
  if (region) region.textContent = message ? String(message) : "";
}

// How long a passing message stays on screen. An error does not use this:
// it waits for the user.
const TOAST_TIMEOUT_MS = 4000;
let toastTimer = null;

/**
 * Shows a message on screen.
 *
 * The live regions are invisible, so a failure used to reach the screen
 * reader and nobody else. This bar is the visible half of the same message.
 * It is the only place where the panel says something the user did not have
 * to ask for, so it stays out of the way: fixed at the bottom, no pointer
 * events, and gone again in a few seconds unless it is an error.
 */
function showToast(message, kind) {
  const toast = document.getElementById("panelToast");
  if (!toast) return;

  const text = message ? String(message) : "";
  // An empty message says nothing, so it changes nothing. In particular it
  // must not wipe a message the user has not read yet.
  if (!text) return;

  const isError = kind === "error";
  // An error waits for the user. A passing message must not wipe away an
  // error the user has not read yet.
  if (!isError && !toast.hidden && toast.dataset.kind === "error") return;

  const label = document.getElementById("panelToastText");
  if (label) label.textContent = text;
  toast.dataset.kind = isError ? "error" : "status";
  toast.hidden = false;
  document.body?.classList.add("toast-visible");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  if (!isError) {
    toastTimer = setTimeout(() => {
      hideToast();
    }, TOAST_TIMEOUT_MS);
  }
}

/**
 * Takes the visible message off the screen.
 */
function hideToast() {
  const toast = document.getElementById("panelToast");
  if (toast) {
    toast.hidden = true;
    toast.dataset.kind = "";
  }
  document.body?.classList.remove("toast-visible");
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
}

/**
 * Announces a message to screen readers, and shows it on screen as well.
 *
 * A state the panel already shows (the loading screen, an empty state, the
 * error screen) does not need a second copy of itself on screen, so it is
 * announced with {notice: false}.
 */
function announceStatus(message, options = {}) {
  writeLiveRegion("panelStatus", message);
  if (options.notice !== false) showToast(message, "status");
}

/**
 * Announces a failure to screen readers, assertively, and shows it on screen
 * as well. Used for the failures that have no error container of their own.
 */
function announceAlert(message, options = {}) {
  writeLiveRegion("panelAlert", message);
  if (options.notice !== false) showToast(message, "error");
}

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";
  document.getElementById("transcriptModeControl").style.display =
    state === "results" ? "inline-flex" : "none";

  if (state !== "results") {
    stopPlaybackTracking();
  }

  // The error screen takes over the whole panel and says what went wrong, so
  // a notice from an earlier action would only repeat it.
  if (state === "error") {
    hideToast();
  }

  // The states that have no live region of their own are announced here, so
  // a screen reader user learns that the panel moved on. The panel itself is
  // on screen as well, so these do not get a notice of their own.
  if (state === "results") {
    announceStatus(panelCopy("digestReady"), { notice: false });
  } else if (state === "welcome") {
    announceStatus(panelCopy("welcomeTitle"), { notice: false });
  }

  updateEmptyStates();
}

/**
 * Shows how many words and videos the welcome page can take the user to.
 *
 * The numbers are read from the local stores, so they cost nothing and are
 * available without a sign-in.
 */
async function updateWelcomeCounts() {
  const wordsCount = document.getElementById("welcomeWordsCount");
  const libraryCount = document.getElementById("welcomeLibraryCount");

  if (wordsCount) {
    try {
      const result = await chrome.runtime.sendMessage({
        action: "getVocabulary",
      });
      const count = result?.success && Array.isArray(result.items)
        ? result.items.length
        : 0;
      wordsCount.textContent = `(${count})`;
    } catch (error) {
      wordsCount.textContent = "(0)";
    }
  }

  if (libraryCount) {
    try {
      const all = await chrome.storage.local.get(null);
      const count = Object.keys(all).filter((key) =>
        key.startsWith("digest_"),
      ).length;
      libraryCount.textContent = `(${count})`;
    } catch (error) {
      libraryCount.textContent = "(0)";
    }
  }
}

/**
 * Shows the empty state of every tab that needs a video.
 *
 * The three video-bound tabs are useless without one, so they say so
 * instead of showing a blank page. The vocabulary and the library do not
 * need a video, so they never get an empty state.
 */
function updateEmptyStates() {
  const hasVideo = Boolean(currentVideoId);
  const resultsVisible =
    document.getElementById("resultsState")?.style.display !== "none";

  const transcriptEmpty = document.getElementById("emptyTranscript");
  const transcriptContent = document.getElementById("transcriptContent");
  if (transcriptEmpty) transcriptEmpty.hidden = hasVideo || !resultsVisible;
  if (transcriptContent)
    transcriptContent.hidden = !hasVideo && Boolean(resultsVisible);

  const overviewEmpty = document.getElementById("emptyOverview");
  const overviewContent = document.getElementById("overviewContent");
  if (overviewEmpty) overviewEmpty.hidden = hasVideo || !resultsVisible;
  if (overviewContent)
    overviewContent.hidden = !hasVideo && Boolean(resultsVisible);

  const notesEmpty = document.getElementById("emptyNotes");
  const notesContent = document.getElementById("notesContent");
  if (notesEmpty) notesEmpty.hidden = hasVideo || !resultsVisible;
  if (notesContent)
    notesContent.hidden = !hasVideo && Boolean(resultsVisible);
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
  // The loading screen says all of this already.
  announceStatus([title, subtitle].filter(Boolean).join(". "), { notice: false });
}

function showError(title, message, options = {}) {
  errorAction = options.action || null;
  showState("error");
  const errorTitle = title || panelCopy("errorTitle");
  const errorMessage = message || panelCopy("errorMessage");
  document.getElementById("errorTitle").textContent = errorTitle;
  document.getElementById("errorMessage").textContent = errorMessage;
  document.getElementById("errorBtn").textContent =
    options.buttonLabel ||
    (options.action ? panelCopy("openSettings") : panelCopy("tryAgain"));

  // A failure with no way out is a dead end. The secondary action is only
  // shown when the user has somewhere else to go.
  const secondary = document.getElementById("errorSecondaryBtn");
  if (secondary) {
    secondary.hidden = !options.secondaryAction;
    secondary.textContent = options.secondaryLabel || panelCopy("chooseAnotherVideo");
    secondary.onclick = options.secondaryAction
      ? () => options.secondaryAction()
      : null;
  }

  // The error screen says this already, so a notice would say it twice.
  announceAlert(`${errorTitle}. ${errorMessage}`, { notice: false });
}

/**
 * Explains a failure of the extension itself (a dead service worker, a
 * broken storage area). It must never look like a missing API key.
 */
function showServiceError(message) {
  awaitingApiKey = false;
  showState("error");
  const errorTitle = panelCopy("serviceErrorTitle");
  const errorMessage = String(message || panelCopy("errorMessage"));
  document.getElementById("errorTitle").textContent = errorTitle;
  document.getElementById("errorMessage").textContent = errorMessage;
  document.getElementById("errorBtn").textContent = panelCopy("tryAgain");
  announceAlert(`${errorTitle}. ${errorMessage}`, { notice: false });
  errorAction = () => {
    void bootPanel();
  };
}

function openOptions() {
  try {
    chrome.runtime.sendMessage({ action: "openOptions" });
  } catch (error) {
    // The settings page is a best effort: the message can fail when the
    // extension context is invalidated.
  }
}

/**
 * Shows the missing transcript key and waits for the user to add it. The
 * settings watcher brings the panel back once the key shows up.
 */
function showConfigError(configStatus) {
  awaitingApiKey = true;
  showState("error");
  // Which key is named first depends on which one the product cannot work
  // without right now. Without an AI key there is no summary and no
  // translation; without a Supadata key the fallback is gone, but the
  // subtitles are read out of the page itself, so most videos still work.
  const errorTitle = panelCopy("apiKeysMissingTitle");
  const errorMessage = configStatus?.hasAiKey
    ? panelCopy("addSupadataKey")
    : panelCopy("addAiKey");
  document.getElementById("errorTitle").textContent = errorTitle;
  document.getElementById("errorMessage").textContent = errorMessage;
  document.getElementById("errorBtn").textContent = panelCopy("openSettings");
  announceAlert(`${errorTitle}. ${errorMessage}`, { notice: false });
  errorAction = openOptions;
}

/**
 * Asks for the transcript again.
 *
 * A failed lookup leaves the ledger, so the retry really buys a second
 * lookup. The user asked for it, so the credit is theirs.
 */
async function retryTranscript() {
  if (!currentVideoId) return;
  transcriptLedger.delete(currentVideoId);
  await startDigest(currentVideoId, currentVideoUrl);
}

/**
 * Goes back to the welcome page, so the user can pick another video.
 */
function goToWelcome() {
  errorAction = null;
  showState("welcome");
  void updateWelcomeCounts();
}

/**
 * Turns a transcript failure into a message the user can act on. Every
 * Supadata failure mode has its own title: "No transcript found" for an
 * invalid key or an exhausted balance sent people hunting for subtitles
 * that were never missing.
 */
function showTranscriptError(result) {
  const code = String(result?.error || "");
  switch (code) {
    case "NO_SUPADATA_KEY":
      // The subtitles are read out of the page itself when they can be. The
      // key is the fallback, so the panel says which half of the story
      // failed instead of pretending the product cannot work.
      showError(
        panelCopy("apiKeyMissingTitle"),
        panelCopy("noCaptionsNoKey"),
        {
          action: openOptions,
        },
      );
      return;
    case "INVALID_SUPADATA_KEY":
      showError(
        panelCopy("invalidApiKeyTitle"),
        result?.message || panelCopy("invalidSupadataKey"),
        { action: openOptions },
      );
      return;
    case "OUT_OF_CREDITS":
      showError(
        panelCopy("outOfCreditsTitle"),
        result?.message || panelCopy("outOfCreditsMessage"),
      );
      return;
    case "RATE_LIMITED":
      showError(
        panelCopy("rateLimitedTitle"),
        result?.message || panelCopy("rateLimitedMessage"),
      );
      return;
    case "NO_TRANSCRIPT":
      showError(
        panelCopy("noTranscriptTitle"),
        result?.message || panelCopy("noTranscriptMessage"),
        {
          // A video without subtitles is not a dead end: the user can ask
          // again, or go and pick a different video.
          buttonLabel: panelCopy("retry"),
          action: () => {
            void retryTranscript();
          },
          secondaryAction: goToWelcome,
        },
      );
      return;
    case "EMPTY_TRANSCRIPT":
      showError(
        panelCopy("emptyTranscriptTitle"),
        result?.message || panelCopy("emptyTranscriptMessage"),
      );
      return;
    case "TRANSCRIPT_REQUEST_TIMEOUT":
      // A timeout is not a missing subtitle. Telling the user this video has
      // no captions sends them looking for a problem that is not there.
      showError(
        panelCopy("transcriptTimeoutTitle"),
        panelCopy("errorCodeTranscriptRequestTimeout"),
        {
          buttonLabel: panelCopy("retry"),
          action: () => {
            void retryTranscript();
          },
          secondaryAction: goToWelcome,
        },
      );
      return;
    default:
      showError(
        panelCopy("noTranscriptTitle"),
        panelFailureMessage(result),
      );
  }
}

// ============================================================
// TAB SWITCHING
// ============================================================

/**
 * Marks the selected tab and keeps the roving tab stop in step with it.
 * Only the selected tab stays in the tab order, so a keyboard user reaches
 * the tab bar in one stop instead of three.
 */
function syncTabState(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const selected = tab.dataset.tab === tabName;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.setAttribute("tabindex", selected ? "0" : "-1");
  });
}

/**
 * Moves the roving tab stop to a tab the user arrowed onto. The stop follows
 * the focus, so Tab leaves the tab bar from where the user is looking.
 */
function moveTabFocus(nextTab) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.setAttribute("tabindex", tab === nextTab ? "0" : "-1");
  });
  nextTab.focus();
}

/**
 * Arrow keys move between the tabs, the way the ARIA tabs pattern asks for.
 * They move the focus only: the Overview and Notes tabs can start a paid AI
 * call, so the user activates a tab with Enter or Space, like any button.
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

function switchTab(tabName) {
  // Capture the transcript position before another tab reuses the same scroll
  // area. Scrolling Overview or Notes must not replace this value.
  if (tabName !== "transcript" && transcriptTabIsActive()) {
    captureCurrentTranscriptScrollTop();
    dismissSelectionActions(true);
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  // The tab bar now carries the ARIA tabs pattern: the selected tab says so
  // with aria-selected, and only it stays in the tab order.
  syncTabState(tabName);

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    // Notes always opens at the top, so restore the independent transcript
    // reading position when the user returns here.
    requestAnimationFrame(() => {
      const contentArea = document.getElementById("contentArea");
      if (!contentArea || !transcriptTabIsActive()) return;
      lastAutoScrollTime = Date.now();
      contentArea.scrollTop = lastTranscriptScrollTop;
    });
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  // Saved notes are stored newest first. Open Notes at the top so the note the
  // user just created is the first item they see.
  if (tabName === "notes") {
    requestAnimationFrame(() => {
      const contentArea = document.getElementById("contentArea");
      const notesPanelIsActive = document.querySelector(
        '.tab-panel[data-panel="notes"].active',
      );
      if (contentArea && notesPanelIsActive) contentArea.scrollTop = 0;
    });
  }

  // Translate only the visible tab. This prevents hidden surfaces from using
  // tokens or competing with the batch queue the user is waiting for.
  if (tabName === "overview") {
    if (!currentAnalysis && !isAnalysisInFlight()) {
      // The summary costs the user money, so it is not bought by opening the
      // tab. The gate states the price and waits for the click.
      renderSummaryGate();
    } else if (currentAnalysis) {
      // The summary is already here, so the invitation to pay for it stays
      // hidden. The gate is only for a summary that does not exist yet.
      hideSummaryGate();
      if (currentTranscriptMode !== "original") {
        void translateOverviewContent();
      }
    }
  } else if (
    tabName === "notes"
  ) {
    // The composer saves at the moment the video is at, so the panel shows
    // that moment next to the button.
    void refreshNotesCurrentTime();
    if (currentTranscriptMode !== "original") {
      void translateNotesContent();
    }
  } else if (
    tabName === "transcript" &&
    currentTranscriptMode !== "original" &&
    !transcriptScrollObserver
  ) {
    void translateTranscript();
  } else if (tabName === "words") {
    void loadVocabulary();
    void loadDueReviews();
  } else if (tabName === "library") {
    void loadLibrary();
  }
}

/**
 * Shows the summary card with its price.
 *
 * The summary costs the user money, so the panel never buys it on its own.
 * The card states what the call costs, and the button is the only thing that
 * starts it. The user knows the price at the moment they agree to pay it.
 */
function renderSummaryGate() {
  const gate = document.getElementById("summaryGate");
  if (!gate) return;

  const hasVideo = Boolean(currentVideoId);
  gate.hidden = false;

  const button = document.getElementById("summaryGenerateBtn");
  if (button) {
    button.disabled = !hasVideo || isAnalysisInFlight();
    button.textContent = panelCopy("generateSummary");
  }

  // The cost line sits right above the button, so the price is read at the
  // moment the user is about to spend it.
  let cost = gate.querySelector(".summary-gate-cost");
  if (!cost) {
    cost = document.createElement("p");
    cost.className = "summary-gate-cost";
    gate.appendChild(cost);
  }
  cost.textContent = panelCopy("summaryCostNote");
}

/**
 * Hides the summary card. A video that already has a summary does not need
 * the invitation to pay for it again.
 */
function hideSummaryGate() {
  const gate = document.getElementById("summaryGate");
  if (gate) gate.hidden = true;
}

/**
 * Shows that the Overview tab is being paid for. The cost is stated here, at
 * the moment the user asks for the analysis, and nowhere else.
 */
function renderAnalysisPending() {
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");

  // The work is paid for, so the card is gone while it runs.
  hideSummaryGate();

  if (chapterList)
    chapterList.innerHTML = `<li class="chapter-item" style="color: var(--text-muted); border: none;">${escapeHtml(panelCopy("generatingOverview"))}</li>`;
  if (quotesList)
    quotesList.innerHTML = `<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">${escapeHtml(panelCopy("loadingQuotes"))}</div>`;

  // The Overview tab loads in front of the user, so say that it is working.
  // The tab says it too, so it does not need a notice of its own.
  announceStatus(panelCopy("generatingOverview"), { notice: false });
}

/**
 * Puts a finished analysis on screen.
 *
 * The analysis belongs to the video it was requested for. A response for a
 * video the user already left must never be rendered for - or cached under -
 * the new one.
 */
async function applyAnalysisResult(videoId, ticket, analysisResult) {
  if (videoId !== currentVideoId || ticket !== videoTicket) return;

  try {
    if (!analysisResult?.success) {
      renderAnalysisFailure(analysisResult);
      return;
    }
    if (!analysisResult.analysis) {
      // The reason is the code the worker sent. The panel turns it into a
      // sentence, so it is passed on as it is.
      renderAnalysisFailure({
        error: analysisResult.error || "EMPTY_ANALYSIS",
      });
      return;
    }

    const analysis = analysisResult.analysis;
    if (currentAnalysis === analysis) return;

    currentAnalysis = analysis;
    renderAnalysisResults(currentAnalysis);

    // Save to cache now that we have analysis
    await saveToCache(videoId);
  } catch (error) {
    console.error("[YouTube Digest Panel] Analysis error:", error);
    if (videoId !== currentVideoId || ticket !== videoTicket) return;
    renderAnalysisFailure({ error: error.message });
  }
}

/**
 * Triggers the LLM analysis (lazy-loaded when user clicks Overview or Quotes tab).
 * This saves tokens by not running analysis until needed.
 */
async function triggerAnalysis() {
  if (!currentTranscriptTimestamped || currentAnalysis) return;

  // Bind this run to the video on screen. The analysis takes seconds, and the
  // user can open another video in the meantime. A response for the old
  // video must never be rendered for - or cached under - the new one.
  const videoId = currentVideoId;
  if (!videoId) return;
  // The ticket of the video on screen. It only changes when the video
  // changes, so a re-run for the same video never invalidates the work.
  const ticket = videoTicket;

  // An analysis for this video is already paid for. Wait for the request
  // that is on the wire - or reuse the result it produced - instead of
  // paying for a second one.
  const running = analysisLedger.get(videoId);
  if (running) {
    const analysisResult = await running.promise;
    await applyAnalysisResult(videoId, ticket, analysisResult);
    return;
  }

  // Show loading indicators in the Overview tab
  renderAnalysisPending();

  // An analysis costs the user's own provider balance. The ledger makes
  // sure the panel pays for it once, no matter how many times it is asked.
  const analysisRequest = startPaidRequest(analysisLedger, videoId, () =>
    chrome.runtime.sendMessage({
      action: "analyzeTranscript",
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentVideoDuration,
    }),
  );

  const analysisResult = await analysisRequest.promise;
  await applyAnalysisResult(videoId, ticket, analysisResult);
}

/**
 * Shows why the analysis failed. The provider already sends a readable
 * message, so the panel shows that instead of a raw error code, and offers
 * a way out when a key is missing.
 */
function renderAnalysisFailure(result) {
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");
  const code = String(result?.error || "");
  // A code is written for the developer. The user gets a sentence, unless
  // the provider sent a message of its own.
  const message = panelFailureMessage(result);

  // The card comes back, so a failed summary can be tried again.
  renderSummaryGate();

  if (chapterList) {
    chapterList.innerHTML = "";
    const item = document.createElement("li");
    item.className = "chapter-item";
    // A failure has to look like a failure, not like a highlighted result.
    item.style.color = "var(--danger)";
    item.style.border = "none";
    item.style.flexDirection = "column";
    item.style.alignItems = "flex-start";
    item.style.gap = "10px";

    const text = document.createElement("span");
    text.textContent = message;
    item.appendChild(text);

    if (code === "NO_AI_KEY") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "enhance-btn";
      button.textContent = panelCopy("openSettings");
      button.addEventListener("click", openOptions);
      item.appendChild(button);
    }

    // A failure the user cannot act on is a dead end. The retry is a real
    // button that asks for the analysis again.
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "enhance-btn";
    retry.id = "summaryRetryBtn";
    retry.textContent = panelCopy("retry");
    retry.addEventListener("click", () => {
      void triggerAnalysis();
    });
    item.appendChild(retry);

    chapterList.appendChild(item);
  }

  if (quotesList) {
    quotesList.innerHTML = "";
    const item = document.createElement("div");
    item.className = "quote-item";
    item.style.color = "var(--danger)";
    item.style.borderLeftColor = "var(--border)";
    item.textContent = message;
    quotesList.appendChild(item);
  }

  // The failure sits inside the Overview tab, which has no alert of its own.
  announceAlert(message);
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  debugLog("[YouTube Digest Panel] seekTo called with:", seconds);
  if (seconds === undefined || seconds === null) {
    debugLog("[YouTube Digest Panel] seekTo aborted - no seconds value");
    return;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    // Try direct messaging to the stored YouTube tab first (fastest/reliable)
    if (youtubeTabId) {
      try {
        await chrome.tabs.sendMessage(youtubeTabId, payload);
        debugLog("[YouTube Digest Panel] seekTo direct success");
        return;
      } catch (directErr) {
        debugLog(
          "[YouTube Digest Panel] Direct seekTo failed, falling back to relay:",
          directErr.message,
        );
      }
    }

    // Fallback: route through background script
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload,
    });
    debugLog("[YouTube Digest Panel] seekTo relay result:", result);
  } catch (error) {
    console.error("[YouTube Digest Panel] seekTo error:", error);
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
function playNote(note) {
  if (note.videoId && note.videoId === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = panelCopy("copied");
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION ACTIONS
// ============================================================

/**
 * Hides actions that belong only to a live transcript selection. Clearing the
 * browser range also prevents the toolbar from returning on another tab.
 */
function dismissSelectionActions(clearSelection = false) {
  const tooltip = document.getElementById("explainTooltip");
  if (tooltip) tooltip.style.display = "none";
  if (clearSelection) window.getSelection()?.removeAllRanges();
}

/**
 * Sets up text selection handling in the transcript.
 * When the user selects text, shows Explain and Note actions.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  // This setup can run again after a cached transcript render. Abort old
  // document listeners so one selection creates only one action toolbar.
  selectionActionsController?.abort();
  selectionActionsController = new AbortController();
  const selectionSignal = selectionActionsController.signal;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create one small toolbar for actions on the selected transcript text.
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.setAttribute("role", "toolbar");
  tooltip.setAttribute("aria-label", panelCopy("selectionActions"));

  // The three actions follow the interface language.
  tooltip.innerHTML = `
    <button class="explain-btn" type="button">${escapeHtml(panelCopy("explainTitle"))}</button>
    <button class="selection-note-btn" type="button">${escapeHtml(panelCopy("note"))}</button>
    <button class="selection-word-btn" type="button">${escapeHtml(panelCopy("extractWord"))}</button>
  `;
  const explainBtn = tooltip.querySelector(".explain-btn");
  const selectionNoteBtn = tooltip.querySelector(".selection-note-btn");
  const selectionWordBtn = tooltip.querySelector(".selection-word-btn");
  selectionWordBtn.title = panelCopy("extractWordTitle");
  selectionWordBtn.setAttribute("aria-label", panelCopy("extractWordTitle"));

  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  // The transcript is static text, so the browser has no caret to put in it
  // on its own. One tab stop on the list gives the region a focus target:
  // the keyboard can land there, and the toolbar can send the focus back to
  // the place the text was selected.
  transcriptList.setAttribute("tabindex", "0");

  let selectedText = "";
  let selectedTimestamp = 0;
  // The range the toolbar is acting on. The browser keeps a selection when
  // the focus moves, but the range is kept so the selection can be put back
  // if something clears it.
  let selectedRange = null;
  // Where the selection the toolbar was opened for starts. A selection that
  // starts in the same place is the user extending it, not a new one.
  let selectionAnchor = null;

  /**
   * Tells whether two ranges start at the same place.
   */
  function sameSelectionStart(anchor, range) {
    if (!anchor || !range) return false;
    return (
      anchor.container === range.startContainer &&
      anchor.offset === range.startOffset
    );
  }

  /**
   * Shows the toolbar on the current selection.
   *
   * The toolbar belongs to the selection, not to the device that made it, so
   * the mouse and the keyboard share this routine. Only the keyboard moves
   * the focus, because a mouse user is already pointing at the text.
   *
   * @param {boolean} moveFocus - true when the keyboard made the selection.
   * @returns {boolean} true when the toolbar is on the screen.
   */
  function showToolbarForSelection(moveFocus = false) {
    const selection = window.getSelection();
    const text = selection?.toString().trim() || "";
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;

    // Both ends must be inside the transcript. The first selected row
    // supplies the timestamp when the selection spans more than one row.
    const isInTranscript = Boolean(
      range &&
        transcriptList.contains(range.startContainer) &&
        transcriptList.contains(range.endContainer),
    );

    // Allow any selection length.
    if (text.length === 0 || !isInTranscript) {
      tooltip.style.display = "none";
      return false;
    }

    selectedText = text;
    selectedRange = range;
    const startElement =
      range.startContainer.nodeType === 1
        ? range.startContainer
        : range.startContainer.parentElement;
    const selectedRow = startElement?.closest(".transcript-entry");
    const rowSeconds = Number(selectedRow?.dataset.seconds);
    selectedTimestamp = Number.isFinite(rowSeconds) ? rowSeconds : 0;

    // Set the final coordinates while the toolbar is still hidden. If it
    // becomes visible first, Chrome paints it at its default left edge for
    // one frame before moving it to the selection center.
    const rect = range.getBoundingClientRect();
    tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
    // The toolbar is centred on the selection, so a selection near the
    // left edge pushed half of it out of the panel, where it could not be
    // reached. The centre is clamped between the two panel edges.
    const panelWidth =
      document.documentElement?.clientWidth || window.innerWidth || 0;
    tooltip.style.left = `${clampToolbarCenter(
      rect.left + rect.width / 2,
      selectionToolbarWidth,
      panelWidth,
    )}px`;
    tooltip.style.display = "flex";

    // Measure the toolbar now that it is on screen, so the next
    // placement can clamp it to its real width.
    const measuredWidth = tooltip.offsetWidth;
    if (measuredWidth && measuredWidth !== selectionToolbarWidth) {
      selectionToolbarWidth = measuredWidth;
      tooltip.style.left = `${clampToolbarCenter(
        rect.left + rect.width / 2,
        selectionToolbarWidth,
        panelWidth,
      )}px`;
    }

    // A selection that continues where the last one started is the user
    // refining it. Taking the focus now would cut the selection short.
    const isNewSelection = !sameSelectionStart(selectionAnchor, range);
    selectionAnchor = {
      container: range.startContainer,
      offset: range.startOffset,
    };
    if (moveFocus && isNewSelection) {
      explainBtn.focus();
    }
    return true;
  }

  /**
   * Closes the toolbar and hands the transcript back to the keyboard.
   *
   * The focus lands on the transcript and the selection is put back, so the
   * user continues from the words they had selected.
   */
  function closeToolbar() {
    tooltip.style.display = "none";
    const selection = window.getSelection();
    if (selection && selectedRange) {
      const current = selection.rangeCount ? selection.getRangeAt(0) : null;
      // The browser keeps a selection when the focus moves, so the range only
      // has to be put back when something cleared it.
      if (!current || selection.isCollapsed) {
        selection.removeAllRanges();
        selection.addRange(selectedRange);
      }
    }
    transcriptList.focus();
  }

  // Interacting with either action must preserve the transcript selection and
  // stay isolated from document and row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // A toolbar is a toolbar: the arrow keys move between the actions, and
  // Escape puts the selection back and sends the focus to the transcript.
  tooltip.addEventListener("keydown", (event) => {
    const actions = collectFocusableElements(tooltip);
    if (!actions.length) return;
    const index = actions.indexOf(event.target);

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeToolbar();
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      actions[(index + 1) % actions.length]?.focus();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      actions[(index - 1 + actions.length) % actions.length]?.focus();
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      actions[0].focus();
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      actions[actions.length - 1].focus();
    }
  });

  // Listen for text selection
  document.addEventListener(
    "mouseup",
    () => {
      showToolbarForSelection(false);
    },
    { signal: selectionSignal },
  );

  // A keyboard selection ends with a keyup: by then the browser has already
  // moved the caret, so the range is the one the user sees. The toolbar used
  // to wait for a mouseup, which meant the actions were gone for a user who
  // never touches a mouse.
  document.addEventListener(
    "keyup",
    (event) => {
      if (!event.shiftKey) return;
      if (!SELECTION_KEYS.has(event.key)) return;
      showToolbarForSelection(true);
    },
    { signal: selectionSignal },
  );

  // Hide tooltip when clicking elsewhere. The explanation dialog owns the
  // screen while it is open, so the toolbar stays where it is until the
  // dialog is closed and the focus comes back to it.
  document.addEventListener(
    "mousedown",
    (event) => {
      if (explainModalOpen) return;
      if (!tooltip.contains(event.target)) {
        tooltip.style.display = "none";
      }
    },
    { signal: selectionSignal },
  );

  // Handle explain button click
  explainBtn.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedText) return;

    // The toolbar stays on screen behind the dialog, so the focus can go
    // back to this button when the dialog closes.
    await showExplanation(selectedText, explainBtn);
  });

  // Save the exact selected words at the first selected transcript row. This
  // action does not move playback and does not ask the AI to rewrite the text.
  selectionNoteBtn.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedText || !currentVideoId) return;

    const button = event.currentTarget;
    const originalText = button.textContent;
    button.textContent = panelCopy("saving");
    button.disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({
        action: "saveNote",
        videoId: currentVideoId,
        timestamp: selectedTimestamp,
        videoTitle: currentVideoTitle,
        channelName: currentChannelName,
        selectedText,
      });

      if (!result?.success) {
        // The reason is kept: a note that did not save is a note the user
        // lost, and "Error" on a button is not a reason.
        announceAlert(noteSaveFailureMessage(result));
        throw new Error(result?.error || "Could not save note");
      }

      button.textContent = panelCopy("saved");
      loadNotes(currentVideoId);
      setTimeout(() => {
        tooltip.style.display = "none";
        button.textContent = originalText;
        button.disabled = false;
      }, 900);
    } catch (error) {
      console.error("[YouTube Digest] Save selected note error:", error);
      button.textContent = panelCopy("errorTitle");
      setTimeout(() => {
        button.textContent = originalText;
        button.disabled = false;
      }, 1500);
    }
  });

  // Find the words worth learning in the selected sentence. This asks the
  // AI provider, so the price is stated before the request goes out and the
  // user confirms the words before they are stored.
  selectionWordBtn.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedText) return;

    const button = event.currentTarget;
    const originalText = button.textContent;
    button.textContent = panelCopy("saving");
    button.disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({
        action: "extractVocabulary",
        sentence: selectedText,
      });

      if (!result?.success) {
        throw new Error(result?.error || panelCopy("extractWordFailed"));
      }

      const words = Array.isArray(result.words) ? result.words : [];
      if (!words.length) throw new Error(panelCopy("extractWordFailed"));

      // The dialog takes the screen over, so the toolbar stays where it is
      // until the dialog is closed and the focus comes back to this button.
      showWordConfirmation(words, selectedText, selectedTimestamp, button);
    } catch (error) {
      console.error("[YouTube Digest] Extract vocabulary error:", error);
      announceAlert(panelCopy("extractWordFailed"));
      // Nothing opened, so there is no focus to hand back.
      tooltip.style.display = "none";
    } finally {
      button.textContent = originalText;
      button.disabled = false;
    }
  });
}

/**
 * Asks the user to confirm the words the AI picked out.
 *
 * The AI is a suggestion, not an authority: the learner sees the words,
 * the sentence they came from and the price, and decides.
 *
 * The dialog is a real dialog: it names itself, takes the focus, keeps the
 * focus inside, closes on Escape, and gives the focus back to the control
 * that opened it.
 */
function showWordConfirmation(words, sentence, timestamp, trigger = null) {
  const returnFocusTo = trigger || document.activeElement;

  const modal = document.createElement("div");
  modal.id = "wordModal";
  modal.className = "explain-modal-overlay";

  const dialog = document.createElement("div");
  dialog.className = "explain-modal";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "word-modal-title");
  dialog.setAttribute("tabindex", "-1");

  const header = document.createElement("div");
  header.className = "explain-modal-header";

  const title = document.createElement("div");
  title.className = "explain-modal-title";
  title.id = "word-modal-title";
  title.textContent = panelCopy("extractWordResults");

  const closeButton = document.createElement("button");
  closeButton.className = "explain-modal-close";
  closeButton.type = "button";
  closeButton.textContent = panelCopy("close");

  header.append(title, closeButton);

  const selected = document.createElement("div");
  selected.className = "explain-selected-text";
  selected.textContent = `"${String(sentence).slice(0, 200)}"`;

  const content = document.createElement("div");
  content.className = "explain-modal-content";

  const cost = document.createElement("p");
  cost.className = "word-cost";
  cost.textContent = panelCopy("extractWordCost");
  content.appendChild(cost);

  const list = document.createElement("div");
  list.className = "word-confirm-list";
  words.forEach((word) => {
    const row = document.createElement("div");
    row.className = "word-confirm-item";
    row.innerHTML = `
      <div class="word-confirm-term">${escapeHtml(word.term || "")}</div>
      <div class="word-confirm-translation">${escapeHtml(word.translation || "")}</div>
      ${word.explanation ? `<div class="word-confirm-explanation">${escapeHtml(word.explanation)}</div>` : ""}
    `;
    list.appendChild(row);
  });
  content.appendChild(list);

  const actions = document.createElement("div");
  actions.className = "word-confirm-actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "enhance-btn";
  cancelButton.textContent = panelCopy("extractWordCancel");
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "primary-btn";
  saveButton.textContent = panelCopy("extractWordSave");
  actions.append(cancelButton, saveButton);
  content.appendChild(actions);

  dialog.append(header, selected, content);
  modal.appendChild(dialog);
  document.body.appendChild(modal);

  // Everything behind the dialog is out of reach while it is open. The
  // announcers stay live so a state change is still spoken.
  const releaseBackground = makeBackgroundInert(modal);

  const close = () => {
    document.removeEventListener("keydown", onKeydown, true);
    releaseBackground();
    modal.remove();
    // The focus goes back where it came from, so the keyboard user is not
    // dropped at the top of the panel.
    if (returnFocusTo && typeof returnFocusTo.focus === "function") {
      returnFocusTo.focus();
    }
  };

  // Escape closes the dialog, and Tab cycles inside it. The listener sits
  // on the document in the capture phase, so the dialog owns the keyboard
  // for as long as it is open.
  const onKeydown = createDialogKeyHandler(dialog, close);
  document.addEventListener("keydown", onKeydown, true);

  closeButton.addEventListener("click", close);
  cancelButton.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });

  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    const original = saveButton.textContent;
    saveButton.textContent = panelCopy("saving");
    try {
      for (const word of words) {
        await chrome.runtime.sendMessage({
          action: "saveVocabulary",
          entry: {
            term: word.term,
            translation: word.translation,
            explanation: word.explanation,
            sentence,
            videoId: currentVideoId || "",
            videoTitle: currentVideoTitle || "",
            timestampSeconds: timestamp,
          },
        });
      }
      close();
      announceStatus(panelCopy("extractWordSaved"));
      await loadVocabulary();
    } catch (error) {
      console.error("[YouTube Digest] Save vocabulary error:", error);
      saveButton.disabled = false;
      saveButton.textContent = original;
      announceAlert(panelCopy("couldNotSave"));
    }
  });

  dialog.focus();
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 *
 * The modal is a real dialog: it names itself, takes the focus, keeps the
 * focus inside, closes on Escape, and gives the focus back to the control
 * that opened it. A screen reader user is not left guessing what happened.
 */
async function showExplanation(selectedText, trigger = null) {
  const returnFocusTo = trigger || document.activeElement;

  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";

  const dialog = document.createElement("div");
  dialog.className = "explain-modal";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "explain-modal-title");
  dialog.setAttribute("aria-describedby", "explain-selected-text");
  dialog.setAttribute("tabindex", "-1");

  const header = document.createElement("div");
  header.className = "explain-modal-header";

  const title = document.createElement("div");
  title.className = "explain-modal-title";
  title.id = "explain-modal-title";
  title.textContent = panelCopy("explainTitle");

  const closeButton = document.createElement("button");
  closeButton.className = "explain-modal-close";
  closeButton.id = "closeExplain";
  closeButton.type = "button";
  closeButton.textContent = panelCopy("close");

  header.append(title, closeButton);

  const selected = document.createElement("div");
  selected.className = "explain-selected-text";
  selected.id = "explain-selected-text";
  selected.textContent = `"${selectedText.substring(0, 200)}${selectedText.length > 200 ? "..." : ""}"`;

  const content = document.createElement("div");
  content.className = "explain-modal-content";
  content.id = "explanationContent";
  content.setAttribute("aria-busy", "true");

  const loading = document.createElement("div");
  loading.className = "explain-loading";
  const loadingBar = document.createElement("div");
  loadingBar.className = "loading-bar";
  const loadingText = document.createElement("span");
  loadingText.textContent = panelCopy("analyzing");
  loading.append(loadingBar, loadingText);
  content.appendChild(loading);

  dialog.append(header, selected, content);
  modal.appendChild(dialog);
  document.body.appendChild(modal);

  // Everything behind the dialog is out of reach while it is open. The
  // announcers stay live so a state change is still spoken.
  const releaseBackground = makeBackgroundInert(modal);

  const close = () => {
    document.removeEventListener("keydown", onKeydown, true);
    explainModalOpen = false;
    releaseBackground();
    modal.remove();
    // The focus goes back where it came from, so the keyboard user is not
    // dropped at the top of the panel.
    if (returnFocusTo && typeof returnFocusTo.focus === "function") {
      returnFocusTo.focus();
    }
  };

  // Escape closes the dialog, and Tab cycles inside it. The listener sits
  // on the document in the capture phase, so the dialog owns the keyboard
  // for as long as it is open.
  const onKeydown = createDialogKeyHandler(dialog, close);

  document.addEventListener("keydown", onKeydown, true);
  explainModalOpen = true;

  closeButton.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });

  // The focus moves into the dialog, so a screen reader reads the title
  // before the user starts moving through it.
  dialog.focus();

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
    });

    const contentDiv = document.getElementById("explanationContent");
    if (!contentDiv) return;
    contentDiv.removeAttribute("aria-busy");
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">${escapeHtml(panelCopy("explainFailed"))} ${escapeHtml(result.error || "")}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    if (!contentDiv) return;
    contentDiv.removeAttribute("aria-busy");
    contentDiv.innerHTML = `<div class="explain-error">${escapeHtml(panelCopy("explainFailed"))} ${escapeHtml(error.message || "")}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// CACHING
// ============================================================

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || !currentTranscript) return;

  try {
    // Persist semantic-segment translations for this video.
    const paragraphCacheForVideo = {};
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        paragraphCacheForVideo[key] = value;
      }
    }
    const interfaceCacheForVideo = {};
    for (const [key, value] of interfaceTranslationCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        interfaceCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      analysis: currentAnalysis, // May be null if not yet analyzed
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      paragraphCache: paragraphCacheForVideo,
      interfaceCache: interfaceCacheForVideo,
      timestamp: Date.now(),
    };

    const stored = await writeDigestCache(videoId, cacheData);
    if (!stored) {
      // The video is not cached, so the next visit pays for the transcript
      // again. Saying so is cheaper than a user who wonders why.
      announceAlert(panelCopy("cacheNotSaved"));
      return;
    }
    debugLog(
      "Saved to cache:",
      videoId,
      currentAnalysis ? "(with analysis)" : "(transcript only)",
    );

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(LIBRARY_MAX_ENTRIES);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Writes a cached digest, making room when the device storage is full.
 *
 * A full storage used to be a silent failure: the write threw, the catch
 * logged it, and the user was told nothing while their video was not
 * cached. The cached digests go first, because they are the only thing in
 * the store that can be fetched again. Half of them are dropped first; if
 * that is not enough, all of them are.
 *
 * @param {string} videoId the video the digest belongs to
 * @param {Object} cacheData the digest to store
 * @returns {Promise<boolean>} whether the digest made it into the store
 */
async function writeDigestCache(videoId, cacheData) {
  const key = `digest_${videoId}`;
  const write = () => chrome.storage.local.set({ [key]: cacheData });

  try {
    await write();
    return true;
  } catch (error) {
    if (!isStorageQuotaError(error)) throw error;
  }

  for (const cap of [Math.floor(LIBRARY_MAX_ENTRIES / 2), 0]) {
    await evictOldCacheEntries(cap);
    try {
      await write();
      return true;
    } catch (error) {
      if (!isStorageQuotaError(error)) throw error;
    }
  }
  return false;
}

/**
 * Tells a full storage apart from every other failure.
 *
 * Only a full storage can be helped by freeing room; every other failure
 * has to be reported as it is.
 */
function isStorageQuotaError(error) {
  if (typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.isQuotaExceededError) {
    return YTD_SETTINGS.isQuotaExceededError(error);
  }
  return false;
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * The cleanup is recorded, because dropping the user's cached videos
 * without telling them is the one thing the library must never do.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) =>
      k.startsWith("digest_"),
    );
    const THIRTY_DAYS = LIBRARY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    let removed = 0;
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((key) => !expiredSet.has(key));
      removed += expired.length;
    }

    if (digestKeys.length > maxEntries) {
      // Sort by timestamp (oldest first) and remove excess
      const sorted = digestKeys
        .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
        .sort((a, b) => a.ts - b.ts);

      const toRemove = sorted
        .slice(0, sorted.length - maxEntries)
        .map((e) => e.key);
      if (toRemove.length > 0) {
        await chrome.storage.local.remove(toRemove);
        removed += toRemove.length;
        debugLog(`[YouTube Digest] Evicted ${toRemove.length} old cache entries`);
      }
    }

    if (removed > 0) await recordLibraryCleanup(removed);
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId) {
  if (!videoId) return null;

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];

    if (!cached) return null;

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// NOTES
// ============================================================

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
    });

    if (result.success) {
      currentNotes = result.notes || [];
      currentNotesFilterVideoId = videoId;
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error("[YouTube Digest Panel] Load notes error:", error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.textContent = filteredVideoId
      ? panelCopy("noNotesForVideo")
      : panelCopy("noNotesYet");
    renderNotesCount();
    void loadNotesDroppedNotice();
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note, index) => {
    const translationId = getNoteTranslationId(note, index);
    const starred = note.starred === true;
    const stamp = displayTimestamp(note);
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    noteEl.innerHTML = `
      <div class="note-header">
        <button class="note-timestamp" type="button" style="border: none;" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}" aria-label="${escapeHtml(panelCopyFormat("playFrom", { time: stamp }))}">${escapeHtml(stamp)}</button>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
        <button
          class="note-star${starred ? " note-star--on" : ""}"
          type="button"
          aria-pressed="${starred ? "true" : "false"}"
          aria-label="${escapeHtml(starred ? panelCopy("unstarNote") : panelCopy("starNote"))}"
          title="${escapeHtml(starred ? panelCopy("unstarNote") : panelCopy("starNote"))}"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"></path>
          </svg>
        </button>
      </div>
      <div class="note-text" role="button" tabindex="0" title="${escapeHtml(panelCopy("editNoteTitle"))}">${renderLocalizedContent(note.text, "notes", translationId)}</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-text" type="button">${escapeHtml(panelCopy("copyText"))}</button>
        <button class="note-action-btn note-copy-link" type="button" data-url="${escapeHtml(note.timestampedUrl)}">${escapeHtml(panelCopy("copyTimestamp"))}</button>
        <button class="note-action-btn note-play" type="button" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(panelCopy("play"))}</button>
        <button class="note-delete" data-id="${escapeHtml(note.id)}" type="button" aria-label="${escapeHtml(panelCopy("deleteNote"))}" title="${escapeHtml(panelCopy("deleteNote"))}">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 6h18"></path>
            <path d="M8 6V4h8v2"></path>
            <path d="m19 6-1 14H6L5 6"></path>
            <path d="M10 11v5"></path>
            <path d="M14 11v5"></path>
          </svg>
        </button>
      </div>
    `;

    // Timestamp click - play from this point (in this tab or a new one)
    const timestampButton = noteEl.querySelector(".note-timestamp");
    timestampButton.addEventListener("click", () => {
      playNote(note);
    });

    // Click the note text to edit it. The text is a div, so it carries the
    // button role itself and answers Enter and Space as well.
    const textEl = noteEl.querySelector(".note-text");
    textEl.addEventListener("click", (event) => {
      event.stopPropagation();
      startEditingNote(note, noteEl);
    });
    makeKeyboardActivatable(textEl, () => startEditingNote(note, noteEl));

    // Delete button
    const deleteBtn = noteEl.querySelector(".note-delete");
    deleteBtn.setAttribute("aria-label", panelCopy("deleteNote"));
    deleteBtn.title = panelCopy("deleteNote");
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteNote(note.id);
      loadNotes(filteredVideoId);
    });

    // Star button — the favorite the dashboard's Favorites tab promises.
    const starBtn = noteEl.querySelector(".note-star");
    starBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await toggleNoteStar(note, starBtn);
    });

    // Copy text button - copies just the note's text
    const copyTextBtn = noteEl.querySelector(".note-copy-text");
    copyTextBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(
          getLocalizedPlainText(note.text, "notes", translationId),
        );
        copyTextBtn.textContent = panelCopy("copied");
        setTimeout(() => {
          copyTextBtn.textContent = panelCopy("copyText");
        }, 2000);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    // Copy timestamp button - copies the timestamped YouTube link
    const copyLinkBtn = noteEl.querySelector(".note-copy-link");
    copyLinkBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(note.timestampedUrl);
        copyLinkBtn.textContent = panelCopy("copied");
        setTimeout(() => {
          copyLinkBtn.textContent = panelCopy("copyTimestamp");
        }, 2000);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    // Play button (in this tab if it is the current video, else a new tab)
    const playBtn = noteEl.querySelector(".note-play");
    playBtn.addEventListener("click", () => {
      playNote(note);
    });

    notesList.appendChild(noteEl);
  });

  renderNotesCount();
  void loadNotesDroppedNotice();

  if (currentTranscriptMode !== "original" && resultTabIsActive("notes")) {
    void translateNotesContent();
  }
}

/**
 * Swaps a note's text for a textarea with Save/Cancel so learners can fix
 * typos or reword a note. Persists locally and to the cloud when signed in.
 */
function startEditingNote(note, noteEl) {
  const textEl = noteEl.querySelector(".note-text");
  if (!textEl || textEl.dataset.editing === "true") return;
  textEl.dataset.editing = "true";

  const textarea = document.createElement("textarea");
  textarea.className = "note-edit-input";
  textarea.value = note.text || "";
  textarea.rows = 3;

  const actions = document.createElement("div");
  actions.className = "note-edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "note-action-btn";
  saveBtn.textContent = panelCopy("save");
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "note-action-btn";
  cancelBtn.textContent = panelCopy("cancel");
  actions.append(saveBtn, cancelBtn);

  textEl.replaceWith(textarea);
  textarea.after(actions);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  const restore = () => {
    const replacement = document.createElement("div");
    replacement.className = "note-text";
    replacement.title = panelCopy("editNoteTitle");
    replacement.textContent = '"' + (note.text || "") + '"';
    replacement.addEventListener("click", (event) => {
      event.stopPropagation();
      startEditingNote(note, noteEl);
    });
    // The restored text is a control again, so the keyboard can open it.
    makeKeyboardActivatable(replacement, () => startEditingNote(note, noteEl));
    textarea.replaceWith(replacement);
    actions.remove();
  };

  cancelBtn.addEventListener("click", () => {
    restore();
  });

  saveBtn.addEventListener("click", async () => {
    const next = textarea.value.trim();
    if (!next) {
      restore();
      return;
    }
    const result = await chrome.runtime.sendMessage({
      action: "updateNote",
      noteId: note.id,
      text: next,
    }).catch(() => null);
    if (result && result.success) {
      note.text = result.note.text;
      restore();
      const filterAll = document
        .getElementById("notesFilterAll")
        ?.classList.contains("active");
      loadNotes(filterAll ? null : currentVideoId);
    } else {
      const hint = document.createElement("span");
      hint.className = "word-sentence";
      hint.textContent = panelCopy("couldNotSave");
      actions.appendChild(hint);
    }
  });
}
/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[YouTube Digest Panel] Delete note error:", error);
  }
}

// ============================================================
// NOTES — composing, starring, counting and exporting
// ============================================================

/**
 * Reads the current playback time of the video on screen.
 *
 * The panel asks the content script for the time it is at right now, so a
 * note written in the panel lands on the moment the user is watching.
 *
 * The answer is null when the panel cannot know: no video in the tab, the
 * tab is not the one on screen, or the content script did not answer. A
 * panel that guesses says "0:00" as if the video were at its first second,
 * and the note lands in the wrong place. So the panel says "unknown"
 * instead of inventing a moment.
 */
async function getCurrentPlaybackSeconds() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: { action: "getCurrentTime" },
    });
    if (!result?.success || !result?.response) return null;
    const seconds = Number(result.response.currentTime);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return seconds;
  } catch (error) {
    return null;
  }
}

/**
 * The stamp a reader sees for a chapter, a quote or a note.
 *
 * The seconds are the truth, and the stamp is derived from them, so what a
 * reader reads and where the click lands can never disagree. The stored
 * string is only used when the seconds are missing: an analysis cached by
 * an older release still carries the old "90:00" for a ninety-minute
 * video, and that string is not what the reader is shown.
 */
function displayTimestamp(item) {
  const seconds = Number(item?.timestampSeconds);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return YTD_SETTINGS.formatTimestamp(seconds);
  }
  return typeof item?.timestamp === "string" ? item.timestamp : "";
}

/**
 * Shows the moment the video is at, so the note the user writes lands where
 * they expect it.
 *
 * When the panel cannot know the moment, it says so instead of printing a
 * fake "0:00". A wrong time is worse than no time: the user trusts it.
 */
async function refreshNotesCurrentTime() {
  const element = document.getElementById("notesCurrentTime");
  if (!element) return;
  if (!currentVideoId) {
    element.textContent = "";
    return;
  }
  // A saved copy is not the video in the tab, so the tab's playback
  // position belongs to another video. Reading it would put the note on
  // the wrong moment of the wrong video.
  if (showingCachedVideo) {
    element.textContent = panelCopy("noteAtCurrentMoment");
    return;
  }
  const seconds = await getCurrentPlaybackSeconds();
  if (seconds === null) {
    element.textContent = panelCopy("noteAtCurrentMoment");
    return;
  }
  element.textContent = panelCopyFormat("playFrom", {
    time: YTD_SETTINGS.formatTimestamp(seconds),
  });
}

/**
 * Saves a note the learner typed in the panel, at the current moment.
 */
async function saveQuickNote() {
  const input = document.getElementById("quickNoteInput");
  const button = document.getElementById("quickNoteSaveBtn");
  if (!input || !button) return;

  const text = String(input.value || "").trim();
  if (!text) {
    announceAlert(panelCopy("quickNoteEmpty"));
    input.focus();
    return;
  }
  if (!currentVideoId) {
    // The Notes tab shows this empty state on its own.
    announceAlert(panelCopy("emptyNoVideoNotes"), { notice: false });
    return;
  }

  const original = button.textContent;
  button.disabled = true;
  button.textContent = panelCopy("saving");

  let saved = false;
  let reason = null;
  const seconds = await getCurrentPlaybackSeconds();

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      // The moment the panel could not read is saved as the start of the
      // video, which is the truth: the note is at the beginning rather than
      // at a moment the panel made up.
      timestamp: seconds === null ? 0 : seconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      // The panel already holds the exact words, so the background stores
      // them as they are. Without this the background would fetch the
      // transcript again (a credit if the fallback has to run) and pay an
      // AI call to rewrite them.
      selectedText: text,
    });

    if (!result?.success) {
      // The reason is kept, because the catch below cannot tell a full
      // storage from anything else.
      reason = noteSaveFailureMessage(result);
      throw new Error(result?.error || "Could not save note");
    }

    saved = true;
    input.value = "";
    announceStatus(panelCopy("quickNoteSaved"));
    await loadNotes(currentNotesFilterVideoId);
  } catch (error) {
    console.error("[YouTube Digest] Quick note error:", error);
    // The note did save and the list refresh failed: saying "could not save"
    // then would be a lie, so the failure stays quiet.
    if (!saved) announceAlert(reason || panelCopy("couldNotSave"));
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/**
 * Shows the note count against the limit that really applies, and warns
 * before the oldest notes start disappearing.
 */
function renderNotesCount() {
  const countEl = document.getElementById("notesCount");
  const warningEl = document.getElementById("notesLimitWarning");
  const count = currentNotes.length;

  if (countEl) {
    countEl.textContent = panelCopyFormat("notesCount", {
      count: String(count),
      limit: String(LOCAL_NOTE_LIMIT),
    });
  }
  if (warningEl) {
    const nearLimit = count >= LOCAL_NOTE_LIMIT - 10;
    warningEl.hidden = !nearLimit;
    if (nearLimit) warningEl.textContent = panelCopy("notesNearLimit");
  }
}

/**
 * Says out loud that the store dropped old notes.
 *
 * The local store keeps a capped number of notes. When the cap is hit, the
 * oldest note goes away - that is fine, but doing it silently is not: the
 * user wrote something, it was on screen yesterday, and today it is gone
 * with no explanation. The store records the drop; this reads that record
 * and puts it in front of the user.
 *
 * The record is namespaced per account, the same way the notes are, so a
 * drop that happened under one account is never shown under another.
 */
async function loadNotesDroppedNotice() {
  const notice = document.getElementById("notesDroppedNotice");
  if (!notice) return;

  try {
    let githubId = "";
    const sessionKey =
      typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.GITHUB_SESSION_KEY
        ? YTD_SETTINGS.GITHUB_SESSION_KEY
        : "ytd_github_session";
    const stored = await chrome.storage.local.get(sessionKey);
    const session = stored?.[sessionKey];
    if (session && session.githubId) githubId = session.githubId;

    const droppedKey =
      typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.notesDroppedKey
        ? YTD_SETTINGS.notesDroppedKey(githubId)
        : githubId
          ? `ytd_notes_dropped_${githubId}`
          : "ytd_notes_dropped";

    const dropped = await chrome.storage.local.get(droppedKey);
    const record = dropped?.[droppedKey];
    const count = Number(record?.lastCount) || 0;

    if (!count) {
      notice.hidden = true;
      notice.textContent = "";
      return;
    }
    notice.hidden = false;
    notice.textContent = panelCopyFormat("notesDropped", {
      count: String(count),
      limit: String(LOCAL_NOTE_LIMIT),
    });
  } catch (error) {
    notice.hidden = true;
  }
}

/**
 * Shows the word count against the limit that really applies, and warns
 * before the oldest words start disappearing.
 */
function renderWordsCount() {
  const countEl = document.getElementById("wordsCount");
  const warningEl = document.getElementById("wordsLimitWarning");
  const count = vocabularyItems.length;

  if (countEl) {
    countEl.textContent = panelCopyFormat("wordsCount", {
      count: String(count),
      limit: String(LOCAL_VOCAB_LIMIT),
    });
  }
  if (warningEl) {
    const nearLimit = count >= LOCAL_VOCAB_LIMIT - 10;
    warningEl.hidden = !nearLimit;
    if (nearLimit) warningEl.textContent = panelCopy("wordsNearLimit");
  }
}

/**
 * Says out loud that the store dropped old words.
 *
 * The same rule as the notes: the store records the drop, and this reads
 * that record and puts it in front of the user. A word that disappears
 * without a word is a word the user lost, and a word is exactly what a
 * learner cannot afford to lose.
 *
 * The record is namespaced per account, the same way the words are, so a
 * drop that happened under one account is never shown under another.
 */
async function loadWordsDroppedNotice() {
  const notice = document.getElementById("wordsDroppedNotice");
  if (!notice) return;

  try {
    let githubId = "";
    const sessionKey =
      typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.GITHUB_SESSION_KEY
        ? YTD_SETTINGS.GITHUB_SESSION_KEY
        : "ytd_github_session";
    const stored = await chrome.storage.local.get(sessionKey);
    const session = stored?.[sessionKey];
    if (session && session.githubId) githubId = session.githubId;

    const droppedKey =
      typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.vocabularyDroppedKey
        ? YTD_SETTINGS.vocabularyDroppedKey(githubId)
        : githubId
          ? `ytd_vocabulary_dropped_${githubId}`
          : "ytd_vocabulary_dropped";

    const dropped = await chrome.storage.local.get(droppedKey);
    const record = dropped?.[droppedKey];
    const count = Number(record?.lastCount) || 0;

    if (!count) {
      notice.hidden = true;
      notice.textContent = "";
      return;
    }
    notice.hidden = false;
    notice.textContent = panelCopyFormat("wordsDropped", {
      count: String(count),
      limit: String(LOCAL_VOCAB_LIMIT),
    });
  } catch (error) {
    notice.hidden = true;
  }
}

/**
 * Stars or unstars a note. The star is the promise the dashboard's Favorites
 * tab makes, so the panel has to be able to set it.
 */
async function toggleNoteStar(note, button) {
  const next = !(note.starred === true);
  const original = button.getAttribute("aria-pressed");
  button.setAttribute("aria-pressed", String(next));

  try {
    const result = await chrome.runtime.sendMessage({
      action: "setNoteStarred",
      noteId: note.id,
      starred: next,
    });
    if (!result?.success) {
      throw new Error(result?.error || "Could not star the note");
    }
    note.starred = result.note?.starred === true;
    button.setAttribute("aria-pressed", String(note.starred));
    button.setAttribute(
      "aria-label",
      note.starred ? panelCopy("unstarNote") : panelCopy("starNote"),
    );
    button.title = note.starred ? panelCopy("unstarNote") : panelCopy("starNote");
    announceStatus(note.starred ? panelCopy("saved") : panelCopy("copied"));
  } catch (error) {
    console.error("[YouTube Digest] Star note error:", error);
    button.setAttribute("aria-pressed", original || "false");
    announceAlert(panelCopy("couldNotSave"));
  }
}

/**
 * Builds the Markdown the user pastes into Obsidian or Notion.
 *
 * Every note carries the video, the channel, a timestamp and the time it
 * was written, so the notes still make sense a month later.
 */
function buildNotesMarkdown(notes) {
  const lines = ["# YouTube Digest notes", ""];

  notes.forEach((note) => {
    const title = note.videoTitle || panelCopy("untitledVideo");
    const channel = note.channelName || "";
    const stamp = displayTimestamp(note);
    const written = note.createdAt
      ? new Date(note.createdAt).toISOString().slice(0, 16).replace("T", " ")
      : "";

    lines.push(`## ${title}`);
    if (channel) lines.push(`Channel: ${channel}`);
    lines.push(`- [${stamp}](${note.timestampedUrl})`);
    if (written) lines.push(`- Saved: ${written}`);
    lines.push("");
    lines.push(String(note.text || "").trim());
    lines.push("");
  });

  return lines.join("\n");
}

/**
 * Exports the notes the user is looking at as Markdown and copies them to
 * the clipboard.
 */
async function exportNotesAsMarkdown() {
  const button = document.getElementById("exportNotesBtn");
  const notes = currentNotes;
  if (!notes.length) {
    announceAlert(panelCopy("noNotesYet"));
    return;
  }

  const original = button?.textContent;
  const markdown = buildNotesMarkdown(notes);
  const copied = await copyToClipboard(markdown);

  if (button) {
    button.textContent = copied
      ? panelCopy("exportNotesCopied")
      : panelCopy("exportNotesFailed");
    setTimeout(() => {
      button.textContent = original;
    }, 2000);
  }
  if (copied) announceStatus(panelCopy("exportNotesCopied"));
  else announceAlert(panelCopy("exportNotesFailed"));
}

// ============================================================
// WORDS — the vocabulary the learner built
// ============================================================

/**
 * The three states a saved word can be in, in the words the user reads.
 * The database values never reach the screen.
 */
const WORD_STATUS_LABELS = Object.freeze({
  learning: "wordStatusLearning",
  reviewing: "wordStatusReviewing",
  mastered: "wordStatusMastered",
});

/**
 * Loads the vocabulary. It is local-first, so it works without a sign-in.
 */
async function loadVocabulary() {
  const list = document.getElementById("wordsList");
  if (!list) return;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "getVocabulary",
    });
    if (!result?.success) {
      vocabularyItems = [];
      renderVocabulary();
      return;
    }
    vocabularyItems = Array.isArray(result.items) ? result.items : [];
    renderVocabulary();
    updateWelcomeCounts();
  } catch (error) {
    console.error("[YouTube Digest Panel] Load vocabulary error:", error);
    vocabularyItems = [];
    renderVocabulary();
  }
}

/**
 * Draws the vocabulary list.
 */
function renderVocabulary() {
  const list = document.getElementById("wordsList");
  if (!list) return;

  list.innerHTML = "";
  renderWordsCount();
  void loadWordsDroppedNotice();

  if (!vocabularyItems.length) {
    const empty = document.createElement("p");
    empty.className = "panel-hint";
    empty.textContent = panelCopy("wordsEmpty");
    list.appendChild(empty);
    return;
  }

  vocabularyItems.forEach((item) => {
    const card = document.createElement("div");
    card.className = "word-item";

    const statusKey = WORD_STATUS_LABELS[item.status] || "wordStatusLearning";
    const source = item.videoId
      ? `<button class="word-source" type="button" data-video-id="${escapeHtml(item.videoId)}" data-seconds="${Number(item.timestampSeconds) || 0}">${escapeHtml(item.videoTitle || panelCopy("untitledVideo"))} · ${escapeHtml(YTD_SETTINGS.formatTimestamp(item.timestampSeconds))}</button>`
      : "";

    card.innerHTML = `
      <div class="word-header">
        <span class="word-term">${escapeHtml(item.term)}</span>
        <span class="word-status word-status--${escapeHtml(item.status || "learning")}">${escapeHtml(panelCopy(statusKey))}</span>
        <button class="word-delete" type="button" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(panelCopy("deleteWord"))}" title="${escapeHtml(panelCopy("deleteWord"))}">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 6h18"></path>
            <path d="M8 6V4h8v2"></path>
            <path d="m19 6-1 14H6L5 6"></path>
            <path d="M10 11v5"></path>
            <path d="M14 11v5"></path>
          </svg>
        </button>
      </div>
      <div class="word-definition">${escapeHtml(item.translation || "")}</div>
      ${item.explanation ? `<div class="word-explanation">${escapeHtml(item.explanation)}</div>` : ""}
      ${item.sentence ? `<div class="word-sentence">${escapeHtml(item.sentence)}</div>` : ""}
      ${source ? `<div class="word-footer">${source}</div>` : ""}
    `;

    const sourceButton = card.querySelector(".word-source");
    sourceButton?.addEventListener("click", () => {
      const videoId = sourceButton.dataset.videoId;
      const seconds = Number(sourceButton.dataset.seconds) || 0;
      openVideoAt(videoId, seconds);
    });

    const deleteButton = card.querySelector(".word-delete");
    deleteButton?.addEventListener("click", async () => {
      deleteButton.disabled = true;
      const result = await chrome.runtime
        .sendMessage({
          action: "deleteVocabulary",
          vocabId: item.id,
        })
        .catch(() => null);
      if (result?.success) {
        vocabularyItems = vocabularyItems.filter(
          (candidate) => candidate.id !== item.id,
        );
        renderVocabulary();
        updateWelcomeCounts();
        announceStatus(panelCopy("copied"));
      } else {
        deleteButton.disabled = false;
        announceAlert(panelCopy("couldNotSave"));
      }
    });

    list.appendChild(card);
  });
}

/**
 * Opens a video at a moment. A video that is already on screen is seeked
 * in place; any other video is opened in a new tab.
 */
function openVideoAt(videoId, seconds) {
  if (!videoId) return;
  if (videoId === currentVideoId) {
    seekTo(seconds);
    switchTab("transcript");
    return;
  }
  chrome.tabs.create({
    url: `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(Number(seconds) || 0))}s`,
  });
}

// ============================================================
// REVIEW — the spaced repetition queue
// ============================================================

/**
 * Reads the review queue. Reviews are scheduled on the server, so this
 * needs a sign-in; without one the panel says so instead of showing an
 * error.
 */
async function loadDueReviews() {
  const area = document.getElementById("reviewArea");
  if (!area) return;

  const signedOut = document.getElementById("reviewSignedOut");
  const empty = document.getElementById("reviewEmpty");
  const card = document.getElementById("reviewCard");
  const actions = document.getElementById("reviewActions");

  try {
    const result = await chrome.runtime.sendMessage({
      action: "getDueReviews",
    });

    if (!result?.success) {
      reviewQueue = [];
      reviewIndex = 0;
      const signedOutState = result?.error === "NO_SESSION";
      if (signedOut) signedOut.hidden = !signedOutState;
      if (empty) empty.hidden = true;
      if (card) card.hidden = true;
      if (actions) actions.hidden = true;
      const progress = document.getElementById("reviewProgress");
      if (progress) progress.textContent = "";
      // Being signed out is a state, not a failure, and the review area
      // says so. A real failure has to be told, or it is only in the log.
      if (!signedOutState) {
        announceAlert(panelFailureMessage(result));
      }
      return;
    }

    if (signedOut) signedOut.hidden = true;
    reviewQueue = Array.isArray(result.reviews) ? result.reviews : [];
    reviewIndex = 0;
    reviewRevealed = false;

    if (empty) empty.hidden = reviewQueue.length > 0;
    if (card) card.hidden = reviewQueue.length === 0;
    if (actions) actions.hidden = reviewQueue.length === 0;
    if (reviewQueue.length) renderReviewCard();
    else {
      const progress = document.getElementById("reviewProgress");
      if (progress) progress.textContent = "";
    }
  } catch (error) {
    console.error("[YouTube Digest Panel] Load reviews error:", error);
  }
}

/**
 * Draws the review card. The card is the only way to see the answer, so it
 * is a real button that a keyboard can reach.
 */
function renderReviewCard() {
  const review = reviewQueue[reviewIndex];
  const card = document.getElementById("reviewCard");
  if (!card) return;

  if (!review) {
    void loadDueReviews();
    return;
  }

  const vocabulary = review.vocabulary || {};
  reviewRevealed = false;

  const term = document.getElementById("reviewTerm");
  const sentence = document.getElementById("reviewSentence");
  const translation = document.getElementById("reviewTranslation");
  const explanation = document.getElementById("reviewExplanation");
  const hint = document.getElementById("reviewHint");

  if (term) term.textContent = vocabulary.term || "";
  if (sentence) sentence.textContent = vocabulary.sentence || "";
  if (translation) {
    translation.textContent = vocabulary.translation || "";
    translation.hidden = true;
  }
  if (explanation) {
    explanation.textContent = vocabulary.sentenceTranslation || "";
    explanation.hidden = true;
  }
  if (hint) {
    hint.hidden = false;
    hint.textContent = panelCopy("reviewShowAnswer");
  }
  card.setAttribute("aria-expanded", "false");

  const progress = document.getElementById("reviewProgress");
  if (progress) {
    progress.textContent = panelCopyFormat("reviewProgress", {
      index: String(reviewIndex + 1),
      total: String(reviewQueue.length),
    });
  }
}

/**
 * Shows the answer on the review card.
 */
function revealReviewAnswer() {
  if (reviewRevealed) return;
  reviewRevealed = true;
  const translation = document.getElementById("reviewTranslation");
  const explanation = document.getElementById("reviewExplanation");
  const hint = document.getElementById("reviewHint");
  const card = document.getElementById("reviewCard");
  if (translation) translation.hidden = false;
  if (explanation) explanation.hidden = false;
  if (hint) {
    hint.hidden = true;
    hint.textContent = panelCopy("reviewHideAnswer");
  }
  card?.setAttribute("aria-expanded", "true");
}

/**
 * Grades a card. The grades are the ones the dashboard uses, so a learner
 * who reviews in both places gets the same schedule.
 */
async function submitReviewGrade(grade) {
  const review = reviewQueue[reviewIndex];
  if (!review?.vocabulary?.id) return;

  const result = await chrome.runtime
    .sendMessage({
      action: "submitReview",
      vocabId: review.vocabulary.id,
      grade: Number(grade),
    })
    .catch(() => null);

  if (!result?.success) {
    announceAlert(panelFailureMessage(result));
    return;
  }

  reviewIndex += 1;
  if (reviewIndex >= reviewQueue.length) {
    reviewQueue = [];
    const card = document.getElementById("reviewCard");
    const actions = document.getElementById("reviewActions");
    const empty = document.getElementById("reviewEmpty");
    if (card) card.hidden = true;
    if (actions) actions.hidden = true;
    if (empty) empty.hidden = false;
    const progress = document.getElementById("reviewProgress");
    if (progress) progress.textContent = "";
    // The review area says this on its own.
    announceStatus(panelCopy("reviewEmptyState"), { notice: false });
    void loadVocabulary();
    return;
  }
  renderReviewCard();
}

// ============================================================
// LIBRARY — the videos that were read already
// ============================================================

/**
 * Reads the cached digests and puts them in the library.
 *
 * Opening one of them must never cost anything, so the panel reads the
 * cached transcript and summary instead of asking for them again.
 */
async function loadLibrary() {
  const list = document.getElementById("libraryList");
  if (!list) return;

  await loadLibraryCleanupNotice();

  try {
    const all = await chrome.storage.local.get(null);
    libraryEntries = Object.keys(all)
      .filter((key) => key.startsWith("digest_"))
      .map((key) => {
        const entry = all[key] || {};
        return {
          videoId: key.slice("digest_".length),
          title: entry.videoTitle || "",
          channelName: entry.channelName || "",
          timestamp: Number(entry.timestamp) || 0,
          hasSummary: Boolean(entry.analysis),
          transcript: entry.transcript || null,
          transcriptText: entry.transcriptText || null,
          transcriptTimestamped: entry.transcriptTimestamped || null,
          transcriptLanguage: entry.transcriptLanguage || null,
          analysis: entry.analysis || null,
          paragraphCache: entry.paragraphCache || null,
          interfaceCache: entry.interfaceCache || null,
        };
      })
      // The video the user is looking at right now is not a library entry.
      // It is "you are here", not "you read this before", and opening it
      // would change nothing.
      .filter((entry) => entry.videoId !== currentVideoId)
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch (error) {
    console.error("[YouTube Digest Panel] Load library error:", error);
    libraryEntries = [];
  }

  renderLibrary();
  updateWelcomeCounts();
}

/**
 * Renders the library, newest first, filtered by the search box.
 */
function renderLibrary() {
  const list = document.getElementById("libraryList");
  if (!list) return;

  list.innerHTML = "";

  const query = librarySearchQuery.trim().toLowerCase();
  const visible = query
    ? libraryEntries.filter(
        (entry) =>
          entry.title.toLowerCase().includes(query) ||
          entry.channelName.toLowerCase().includes(query),
      )
    : libraryEntries;

  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "panel-hint";
    // Two different situations, two different sentences: an empty library
    // and a search that found nothing.
    empty.textContent = query
      ? panelCopy("libraryNoResults")
      : panelCopy("libraryEmpty");
    list.appendChild(empty);
    return;
  }

  visible.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "library-item";
    const relative = formatRelativeTime(entry.timestamp);
    card.innerHTML = `
      <div class="library-title">${escapeHtml(entry.title || panelCopy("untitledVideo"))}</div>
      <div class="library-meta">
        <span class="library-channel">${escapeHtml(entry.channelName || "")}</span>
        <span class="library-time">${escapeHtml(relative)}</span>
        <span class="library-badge">${escapeHtml(entry.hasSummary ? panelCopy("libraryHasSummary") : panelCopy("libraryTranscriptOnly"))}</span>
      </div>
    `;

    const openButton = document.createElement("button");
    openButton.className = "library-open";
    openButton.type = "button";
    openButton.textContent = panelCopy("libraryOpenVideo");
    openButton.setAttribute(
      "aria-label",
      `${panelCopy("libraryOpenVideo")}: ${entry.title || ""}`,
    );
    openButton.addEventListener("click", () => {
      openVideoOnYouTube(entry.videoId);
    });

    // Two different intentions, two different words. "Read in the panel"
    // shows the saved copy here; "Open on YouTube" goes to the video. A
    // button that says one thing and does another is worse than no button.
    const readButton = document.createElement("button");
    readButton.className = "library-open library-read";
    readButton.type = "button";
    readButton.textContent = panelCopy("libraryOpenInPanel");
    readButton.setAttribute(
      "aria-label",
      `${panelCopy("libraryOpenInPanel")}: ${entry.title || ""}`,
    );
    readButton.addEventListener("click", () => {
      openLibraryEntry(entry);
    });

    const actions = document.createElement("div");
    actions.className = "library-actions";
    actions.append(readButton, openButton);
    card.appendChild(actions);

    list.appendChild(card);
  });
}

/**
 * Opens a video on YouTube in a new tab.
 */
function openVideoOnYouTube(videoId) {
  if (!videoId) return;
  chrome.tabs.create({
    url: `https://www.youtube.com/watch?v=${videoId}`,
  });
}

/**
 * Opens a library entry in the panel, from the cache.
 *
 * The transcript and the summary are already on this device, so nothing is
 * fetched and nothing is paid for.
 */
function openLibraryEntry(entry) {
  if (!entry?.videoId) return;

  currentVideoId = entry.videoId;
  currentVideoUrl = `https://www.youtube.com/watch?v=${entry.videoId}`;
  currentAnalysis = entry.analysis || null;
  currentTranscript = entry.transcript || null;
  currentTranscriptText = entry.transcriptText || null;
  currentTranscriptTimestamped = entry.transcriptTimestamped || null;
  currentTranscriptLanguage = entry.transcriptLanguage || null;
  currentVideoTitle = entry.title || "";
  currentChannelName = entry.channelName || "";
  // The panel now shows a saved copy, not the video in the front tab. The
  // header has to say so, because a note written here belongs to this
  // saved video and not to what the tab is playing.
  showingCachedVideo = true;
  renderCachedViewNote();

  if (entry.paragraphCache) {
    for (const [key, value] of Object.entries(entry.paragraphCache)) {
      transcriptParagraphCache.set(key, value);
    }
  }
  if (entry.interfaceCache) {
    for (const [key, value] of Object.entries(entry.interfaceCache)) {
      interfaceTranslationCache.set(key, value);
    }
  }

  const videoInfo = document.getElementById("videoInfo");
  const titleEl = document.getElementById("videoTitle");
  const channelEl = document.getElementById("videoChannel");
  if (titleEl) titleEl.textContent = currentVideoTitle;
  if (channelEl) channelEl.textContent = currentChannelName;
  if (videoInfo) videoInfo.style.display = "block";

  showState("results");
  renderTranscript();

  if (currentAnalysis) {
    renderAnalysisResults(currentAnalysis);
    hideSummaryGate();
  } else {
    renderSummaryGate();
  }

  setupExplainFeature();
  loadNotes(currentNotesFilterVideoId);
  switchTab(currentAnalysis ? "overview" : "transcript");
}

/**
 * Says that the panel is showing a saved copy, not the video in the tab.
 *
 * Without this the user would write a note about the video they are watching
 * and find it filed under a different video.
 */
function renderCachedViewNote() {
  const note = document.getElementById("cachedViewNote");
  if (!note) return;
  note.hidden = !showingCachedVideo;
  note.textContent = showingCachedVideo ? panelCopy("libraryCachedView") : "";
}

/**
 * Says how long ago a cached video was read, in the words a person would
 * use. The timestamp is the moment the video was saved, not a moment inside
 * the video, so a video read a minute ago reads as "just now".
 */
function formatRelativeTime(timestamp) {
  const elapsed = Date.now() - (Number(timestamp) || 0);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return panelCopy("libraryJustNow");
  if (minutes < 60) {
    return panelCopyFormat("libraryMinutesAgo", { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return panelCopyFormat("libraryHoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return panelCopyFormat("libraryDaysAgo", { count: days });
  const months = Math.floor(days / 30);
  return panelCopyFormat("libraryMonthsAgo", { count: months });
}

/**
 * Records that entries were removed, so the cleanup stops being invisible.
 */
async function recordLibraryCleanup(count) {
  if (!count) return;
  try {
    await chrome.storage.local.set({
      [LIBRARY_CLEANUP_KEY]: { count, at: Date.now() },
    });
  } catch (error) {
    // The notice is a courtesy, so a failed write must not break anything.
  }
}

/**
 * Shows the last cleanup, once.
 */
async function loadLibraryCleanupNotice() {
  const notice = document.getElementById("libraryCleanup");
  if (!notice) return;
  try {
    const stored = await chrome.storage.local.get(LIBRARY_CLEANUP_KEY);
    const record = stored?.[LIBRARY_CLEANUP_KEY];
    if (!record?.count) {
      notice.hidden = true;
      libraryCleanup = null;
      return;
    }
    libraryCleanup = record;
    notice.hidden = false;
    notice.textContent = panelCopyFormat("libraryCleaned", {
      count: String(record.count),
      days: String(LIBRARY_MAX_AGE_DAYS),
    });
  } catch (error) {
    notice.hidden = true;
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  const willRestoreReadingPosition =
    pendingTranscriptViewState?.videoId === currentVideoId;
  autoScrollEnabled = !willRestoreReadingPosition;
  document.getElementById("followPlaybackBtn").style.display =
    willRestoreReadingPosition ? "block" : "none";

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById("contentArea");
  contentArea.removeEventListener("scroll", onContentAreaScroll);
  contentArea.addEventListener("scroll", onContentAreaScroll);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 *
 * The YouTube tab the panel already knows about is asked first. The relay
 * behind `relayToContent` has to search the browser's tabs to find the
 * YouTube page, and that search is far too heavy to run twice a second.
 */
async function playbackTrackingTick() {
  try {
    if (youtubeTabId) {
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

    // The tab is gone, or it never answered. The relay finds the YouTube
    // page again, so the tracker keeps following the video.
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: { action: "getCurrentTime" },
    });

    if (!result.success || !result.response) return;

    const currentTime = result.response.currentTime || 0;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? parseInt(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  scheduleTranscriptViewStateSave();

  // Ignore scroll events within 1 second of a programmatic scroll
  // (smooth scroll animations can last longer than a simple boolean flag)
  if (Date.now() - lastAutoScrollTime < 1000) return;

  // User scrolled manually — disable auto-scroll and show the button
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
}

/**
 * Uses session storage when it is available. Local storage is a safe fallback
 * for older test or browser environments that do not expose session storage.
 */
function getTranscriptViewStateStorage() {
  return chrome.storage.session || chrome.storage.local;
}

/**
 * Reads one video's last visible transcript position.
 */
async function loadTranscriptViewState(videoId) {
  if (!videoId) return null;
  try {
    const result = await getTranscriptViewStateStorage().get(
      TRANSCRIPT_VIEW_STATE_KEY,
    );
    const state = result?.[TRANSCRIPT_VIEW_STATE_KEY]?.[videoId];
    const scrollTop = Number(state?.scrollTop);
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return null;
    return { videoId, scrollTop };
  } catch (error) {
    console.error("[YouTube Digest] Reading position load error:", error);
    return null;
  }
}

/**
 * Stores positions for a small recent set of videos. This prevents one value
 * from growing without a limit during a long Chrome session.
 */
async function saveTranscriptViewState(videoId, scrollTop) {
  if (!videoId || !Number.isFinite(scrollTop) || scrollTop < 0) return;
  try {
    const storage = getTranscriptViewStateStorage();
    const result = await storage.get(TRANSCRIPT_VIEW_STATE_KEY);
    const states = result?.[TRANSCRIPT_VIEW_STATE_KEY] || {};
    states[videoId] = { scrollTop, updatedAt: Date.now() };

    const recentStates = Object.fromEntries(
      Object.entries(states)
        .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 20),
    );
    await storage.set({ [TRANSCRIPT_VIEW_STATE_KEY]: recentStates });
  } catch (error) {
    console.error("[YouTube Digest] Reading position save error:", error);
  }
}

/**
 * Saves the visible position after scrolling stops. Capturing the video ID and
 * position now prevents a later video change from writing the wrong state.
 */
function scheduleTranscriptViewStateSave() {
  if (
    isRestoringTranscriptView ||
    !currentVideoId ||
    !transcriptTabIsActive()
  ) {
    return;
  }
  const contentArea = document.getElementById("contentArea");
  if (!contentArea) return;

  const videoId = currentVideoId;
  const scrollTop = contentArea.scrollTop;
  lastTranscriptScrollTop = scrollTop;
  clearTimeout(transcriptViewStateSaveTimer);
  transcriptViewStateSaveTimer = setTimeout(() => {
    void saveTranscriptViewState(videoId, scrollTop);
  }, 150);
}

/**
 * Saves immediately before the panel closes.
 */
function saveCurrentTranscriptViewState() {
  clearTimeout(transcriptViewStateSaveTimer);
  const contentArea = document.getElementById("contentArea");
  if (!currentVideoId || !contentArea) return Promise.resolve();
  if (transcriptTabIsActive()) captureCurrentTranscriptScrollTop();
  return saveTranscriptViewState(currentVideoId, lastTranscriptScrollTop);
}

/**
 * Returns true only while the Transcript tab is the visible results panel.
 */
function transcriptTabIsActive() {
  return resultTabIsActive("transcript");
}

function resultTabIsActive(tabName) {
  return Boolean(
    document.querySelector(
      `.tab-panel[data-panel="${CSS.escape(tabName)}"].active`,
    ),
  );
}

/**
 * Copies the shared scroll area's current value into transcript-only state.
 */
function captureCurrentTranscriptScrollTop() {
  const contentArea = document.getElementById("contentArea");
  if (contentArea) lastTranscriptScrollTop = contentArea.scrollTop;
}

/**
 * Restores the saved position after the transcript becomes visible. Follow
 * Playback stays paused, so the next timer tick cannot move the panel again.
 */
function restorePendingTranscriptViewState(videoId) {
  const state = pendingTranscriptViewState;
  pendingTranscriptViewState = null;
  const contentArea = document.getElementById("contentArea");
  if (!state || state.videoId !== videoId) {
    contentArea?.classList.remove("restoring-transcript-view");
    return;
  }

  requestAnimationFrame(() => {
    if (currentVideoId !== videoId || !contentArea) {
      contentArea?.classList.remove("restoring-transcript-view");
      return;
    }

    isRestoringTranscriptView = true;
    lastAutoScrollTime = Date.now();
    autoScrollEnabled = false;
    contentArea.scrollTop = state.scrollTop;
    lastTranscriptScrollTop = state.scrollTop;
    document.getElementById("followPlaybackBtn").style.display = "block";
    contentArea.classList.remove("restoring-transcript-view");
    requestAnimationFrame(() => {
      isRestoringTranscriptView = false;
    });
  });
}

// ============================================================
// UNIVERSAL DISPLAY LANGUAGE — Original / Chinese / aligned bilingual
// ============================================================

async function loadDisplayLanguageMode(videoId) {
  if (!videoId) {
    setTranscriptModeButtons("original");
    return "original";
  }
  try {
    const stored = await chrome.storage.local.get(DISPLAY_LANGUAGE_MODE_KEY);
    const mode = stored?.[DISPLAY_LANGUAGE_MODE_KEY]?.[videoId]?.mode;
    currentTranscriptMode = DISPLAY_LANGUAGE_MODES.has(mode)
      ? mode
      : "original";
  } catch (error) {
    currentTranscriptMode = "original";
  }
  setTranscriptModeButtons(currentTranscriptMode);
  return currentTranscriptMode;
}

async function saveDisplayLanguageMode(videoId, mode) {
  if (!videoId || !DISPLAY_LANGUAGE_MODES.has(mode)) return;
  const stored = await chrome.storage.local.get(DISPLAY_LANGUAGE_MODE_KEY);
  const modes = stored?.[DISPLAY_LANGUAGE_MODE_KEY] || {};
  modes[videoId] = { mode, updatedAt: Date.now() };
  const recentModes = Object.fromEntries(
    Object.entries(modes)
      .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 50),
  );
  await chrome.storage.local.set({
    [DISPLAY_LANGUAGE_MODE_KEY]: recentModes,
  });
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCacheKey(segment, videoId = currentVideoId) {
  return `${videoId}:zh:semantic:${segment.id}`;
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleDisplayLanguageModeChange(mode) {
  if (!DISPLAY_LANGUAGE_MODES.has(mode)) return;
  if (mode === currentTranscriptMode) return;

  currentTranscriptMode = mode;
  // Invalidate the in-flight translations BEFORE the first await. The old
  // order let a response for the previous mode land after the await and be
  // accepted as if it belonged to the new one.
  translationGeneration += 1;
  if (mode !== "original") {
    // A failure recorded for the old mode must not block the new one.
    interfaceTranslationFailures.clear();
    interfaceTranslationInFlight.clear();
  }
  await saveDisplayLanguageMode(currentVideoId, mode);
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);
  const activeTabName =
    document.querySelector(".tab.active")?.dataset.tab || "transcript";

  if (mode === "original") {
    renderTranscript();
    if (currentAnalysis) renderAnalysisResults(currentAnalysis);
    if (currentNotes.length) renderNotes(currentNotes, currentNotesFilterVideoId);
    return;
  }

  if (currentAnalysis) {
    renderAnalysisResults(currentAnalysis);
  }
  if (currentNotes.length) {
    renderNotes(currentNotes, currentNotesFilterVideoId);
  }
  if (activeTabName === "overview" && currentAnalysis) {
    await translateOverviewContent();
  } else if (activeTabName === "notes" && currentNotes.length) {
    await translateNotesContent();
  } else if (activeTabName === "transcript") {
    await translateTranscript();
  }
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">${escapeHtml(panelCopy("retry"))}</button>`;
  } else {
    translationHtml = escapeHtml(panelCopy("translationWaiting"));
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(segment),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    const timestamp = YTD_SETTINGS.formatTimestamp(segment.start);

    // The timestamp is a real button here too, so a translated transcript
    // is no less reachable with the keyboard than the original one.
    div.innerHTML = `
      <button class="transcript-time" type="button" style="border: none; background: none; text-align: left; align-self: flex-start; cursor: pointer;" aria-label="${escapeHtml(panelCopyFormat("jumpTo", { time: timestamp }))}">${timestamp}</button>
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    const timeButton = div.querySelector(".transcript-time");
    timeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      seekTo(segment.start);
    });

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    transcriptList.appendChild(div);
    rows.push(div);
  });

  // Bilingual mode can find source text before each translation arrives.
  refreshTranscriptSearch({ preserveIndex: false, scroll: false });

  startPlaybackTracking();
  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function alignTranslatedSegmentBatch(sourceSegments, responseSegments) {
  const translatedById = new Map();
  if (Array.isArray(responseSegments)) {
    responseSegments.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string")
        return;
      const text = item.text.trim();
      if (text && !translatedById.has(item.id)) {
        translatedById.set(item.id, text);
      }
    });
  }

  return sourceSegments.map((segment) => ({
    id: segment.id,
    text: translatedById.get(segment.id) || "",
    error: translatedById.has(segment.id) ? "" : "Translation unavailable.",
  }));
}

function updateTranslatedRow(segment, index, alignedItem, generation) {
  if (generation !== translationGeneration) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  if (alignedItem.text) {
    transcriptParagraphCache.set(
      transcriptTranslationCacheKey(segment),
      alignedItem.text,
    );
  }

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);

  const retry = row.querySelector(".translation-retry-btn");
  if (retry) {
    ["mousedown", "mouseup"].forEach((eventName) => {
      retry.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      retryTranslationSegment(index, generation);
    });
  }
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
  mode,
) {
  const sourceBatch = indices.map((index) => segments[index]);
  // The batch belongs to the video, the mode and the generation it was
  // started for. Once one of them changes, the answer is worth nothing to
  // the user, so the retries stop as well.
  const isStaleBatch = () =>
    generation !== translationGeneration ||
    videoId !== currentVideoId ||
    mode !== currentTranscriptMode;
  setTranslatingSpinner(true);
  try {
    // The payload is built once and never changes between the attempts, so
    // every attempt asks for the very same thing and the cache key of the
    // batch stays correct.
    const result = await sendTranslationWithRetry(
      {
        action: "translateContent",
        content: {
          segments: sourceBatch.map(({ id, text }) => ({ id, text })),
        },
        contentType: "transcriptBatch",
        targetLanguage: "zh",
        videoTitle: currentVideoTitle,
      },
      isStaleBatch,
    );

    const isStale = isStaleBatch();

    const responseSegments = result?.success
      ? result.translatedContent?.segments
      : [];
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);

    if (isStale) {
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
    }

    aligned.forEach((item, batchIndex) => {
      if (!result?.success) {
        item.error = result?.error || panelCopy("translationFailed");
      }
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
      );
    });
    refreshTranscriptSearch({ preserveIndex: true, scroll: false });
    await updateCache();
  } catch (error) {
    if (generation !== translationGeneration) return;
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        {
          id: segment.id,
          text: "",
          error: error.message || panelCopy("translationFailed"),
        },
        generation,
      );
    });
    refreshTranscriptSearch({ preserveIndex: true, scroll: false });
  } finally {
    setTranslatingSpinner(false);
  }
}

function retryTranslationSegment(index, generation) {
  if (generation !== translationGeneration || !activeTranslationQueue) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = panelCopy("retrying");
    }
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript() {
  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  const generation = translationGeneration;
  const videoId = currentVideoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  let processing = false;

  const processNext = async () => {
    if (processing || queue.length === 0 || generation !== translationGeneration)
      return;
    processing = true;
    const indices = queue.splice(0, TRANSLATION_BATCH_SIZE);
    indices.forEach((index) => queued.delete(index));
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
        mode,
      );
    } finally {
      processing = false;
      if (queue.length && generation === translationGeneration) processNext();
    }
  };

  const enqueue = (index, force = false) => {
    if (!Number.isInteger(index) || !segments[index]) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(segments[index]),
    );
    if ((!force && cached) || queued.has(index)) return;
    queue.push(index);
    queued.add(index);
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  activeTranslationQueue = { enqueue };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => enqueue(Number(entry.target.dataset.segmentIndex)));
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row, index) => {
    if (!row.classList.contains("translated")) transcriptScrollObserver.observe(row);
    if (index < TRANSLATION_BATCH_SIZE) enqueue(index);
  });
}

function setTranslatingSpinner(show) {
  if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  sendTranslationMessage,
  sendTranslationWithRetry,
  isRetryableTranslationError,
  groupTranscriptEntries,
  splitOversizedThought,
  alignTranslatedSegmentBatch,
  findLiteralTranscriptMatches,
  loadTranscriptViewState,
  saveTranscriptViewState,
  loadDisplayLanguageMode,
  saveDisplayLanguageMode,
  getNavigationUrl,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
  refreshGithubSyncStatus,
  loadSyncHeaderCopy,
  applySyncSessionSignal,
};

// The panel is the product's main surface, so the tests drive the real file
// through a DOM stub. These hooks expose the stateful parts the tests need
// to observe; the extension never reads this object at runtime.
globalThis.__YTD_PANEL_TESTING__ = {
  startDigest,
  triggerAnalysis,
  checkCurrentTab,
  scheduleDigestRefresh,
  bootPanel,
  handleSettingsChanged,
  loadPanelContent,
  setNotesFilter,
  loadNotesFilter,
  showError,
  showTranscriptError,
  showConfigError,
  showServiceError,
  renderAnalysisFailure,
  renderLocalizedContent,
  retryInterfaceTranslation,
  handleInterfaceRetryClick,
  handleDisplayLanguageModeChange,
  panelCopy,
  loadPanelLanguage,
  applyPanelCopy,
  showExplanation,
  switchTab,
  updateLoading,
  renderAnalysisResults,
  renderTranscript,
  renderNotes,
  setupExplainFeature,
  clampToolbarCenter,
  announceStatus,
  announceAlert,
  showToast,
  hideToast,
  panelFailureMessage,
  noteSaveFailureMessage,
  saveQuoteAsNote,
  writeDigestCache,
  saveToCache,
  formatRelativeTime,
  renderSummaryGate,
  hideSummaryGate,
  renderAnalysisResults,
  renderNotes,
  renderVocabulary,
  loadVocabulary,
  loadDueReviews,
  loadLibrary,
  renderLibrary,
  saveQuickNote,
  exportNotesAsMarkdown,
  buildNotesMarkdown,
  toggleNoteStar,
  submitReviewGrade,
  revealReviewAnswer,
  updateWelcomeCounts,
  updateEmptyStates,
  openLibraryEntry,
  showWordConfirmation,
  displayTimestamp,
  formatTimestamp: (seconds) => YTD_SETTINGS.formatTimestamp(seconds),
  extractVideoId,
  loadNotesDroppedNotice,
  showState,
  loadNotes,
  refreshNotesCurrentTime,
  setCurrentVideo: (videoId, videoUrl) => {
    onVideoChanged(videoId);
    currentVideoUrl = videoUrl || "";
    return currentVideoId;
  },
  setTranscriptMode: (mode) => {
    currentTranscriptMode = DISPLAY_LANGUAGE_MODES.has(mode)
      ? mode
      : "original";
    return currentTranscriptMode;
  },
  getState: () => ({
    currentVideoId,
    currentVideoUrl,
    currentAnalysis,
    currentTranscript,
    currentTranscriptText,
    currentTranscriptTimestamped,
    currentTranscriptMode,
    isAnalysisLoading: isAnalysisInFlight(),
    notesFilterShowAll,
    videoTicket,
    digestRunCount,
    interfaceTranslationFailures,
    interfaceTranslationInFlight,
    interfaceTranslationCache,
    transcriptParagraphCache,
  }),
};

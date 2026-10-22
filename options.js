const YTD_OPTIONS = (() => {
  const LANGUAGE_STORAGE_KEY = "ytd_options_language";
  const PREVIEW_STORAGE_PREFIX = "youtubeDigestPreview:";
  const SUPPORTED_LANGUAGES = new Set(["en", "zh-CN"]);

  const COPY = {
    en: {
      pageTitle: "YouTube Digest Settings",
      languageGroupLabel: "Interface language",
      heading: "Bring your own API keys",
      lede:
        "Keys stay in this Chrome profile and are sent only to Supadata and your chosen AI provider. There is no analytics or telemetry. If you sign in with GitHub below, your saved notes are mirrored to this project's own sync service at ytd.panbo.space; without signing in, nothing leaves this device.",
      transcriptProvider: "Transcript provider",
      supadataApiKeyLabel: "Supadata API key",
      supadataKeyPlaceholder: "Paste your Supadata key",
      supadataHelp:
        "Optional. Subtitles are read out of the YouTube page itself; this key is only a fallback for when that fails. ",
      supadataLink: "Create a Supadata account and key",
      supadataHelpSuffix:
        ". Supadata generates the key during onboarding.",
      aiProvider: "AI provider",
      deepseekApiKeyLabel: "DeepSeek API key",
      deepseekKeyPlaceholder: "Paste your DeepSeek key",
      deepseekHelp:
        "YouTube Digest uses DeepSeek V4 Flash for overviews, explanations, translation, and tidying up the notes you save from the video page. ",
      deepseekLink: "Create a DeepSeek API key",
      deepseekHelpSuffix: ".",
      deepseekPrivacyNote:
        "When you use AI features, DeepSeek receives the video transcript and relevant video context. Review DeepSeek's terms and pricing before saving.",
      minimaxApiKeyLabel: "MiniMax API key",
      minimaxKeyPlaceholder: "Paste your MiniMax key",
      minimaxHelp:
        "YouTube Digest uses MiniMax M3 for overviews, explanations, translation, and tidying up the notes you save from the video page. ",
      minimaxLink: "Create a MiniMax API key",
      minimaxHelpSuffix: ".",
      minimaxPrivacyNote:
        "When you use AI features, MiniMax receives the video transcript and relevant video context. Review MiniMax's terms and pricing before saving.",
      opencodeGoApiKeyLabel: "OpenCode Go API key",
      opencodeGoKeyPlaceholder: "Paste your OpenCode Go key",
      opencodeGoHelp:
        "OpenCode Go is a low-cost subscription that includes DeepSeek V4 Flash. YouTube Digest uses it for overviews, explanations, translation, and tidying up the notes you save from the video page. ",
      opencodeGoLink: "Create an OpenCode Go API key",
      opencodeGoHelpSuffix: ".",
      opencodeGoPrivacyNote:
        "When you use AI features, the OpenCode Go service receives the video transcript and relevant video context. Review its terms and pricing before saving.",
      saveSettings: "Save settings",
      setupGuideTitle: "You are all set. Next steps:",
      setupGuideStep1: "Open any YouTube video with captions.",
      setupGuideStep2: "Click the YouTube Digest icon to open the side panel.",
      setupGuideStep3:
        'Read the bilingual transcript, open {tabSummary} for the AI summary, and press "n" on the video to save a note.',
      tabTranscript: "Transcript",
      tabSummary: "Summary",
      tabNotes: "Notes",
      tabWords: "Words",
      tabLibrary: "Library",
      githubSync: "GitHub sync",
      githubSyncIntro:
        "Sign in with GitHub to back up your saved notes to this project's sync service at ytd.panbo.space. Every GitHub account has its own isolated data. Sign in with a different account to switch learner profiles.",
      githubLogin: "Sign in with GitHub",
      githubLogout: "Sign out",
      githubLoginFailed: "GitHub sign-in failed. Please try again.",
      githubSessionExpired: "Your session expired. Sign in again.",
      githubSignedOut:
        "Signed out. There is no account data on this device to remove.",
      githubSignedOutWithAccount:
        "Signed out. The notes and words of your account were removed from this device. Your account still holds them on the sync service.",
      logoutUnsyncedConfirm: ({ notes, words }) => {
        const parts = [];
        if (notes > 0) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
        if (words > 0) parts.push(`${words} word${words === 1 ? "" : "s"}`);
        const one = notes + words === 1;
        return `This device holds ${parts.join(" and ")} that your account has never received. Signing out deletes ${one ? "it" : "them"} from this browser for good. Sign out anyway?`;
      },
      githubDeleteAccount: "Delete my account",
      githubDeleteAccountConfirm:
        "Delete your account and ALL notes, words, and review progress? This cannot be undone.",
      githubDeleteAccountReally:
        "Really delete everything, on the server and on this device? This is permanent.",
      githubDeleteAccountDeleted:
        "Account deleted. Your notes and words were removed from this device too.",
      githubDeleteAccountNotSignedIn:
        "You are not signed in, so there is no account to delete.",
      githubDeleteAccountFailed: "Could not delete the account: {message}",
      localRemix: "Local remix",
      customizationTitle: "Want to use another AI model?",
      customizationPurpose: "Edit and copy a safe prompt for your coding agent",
      agentBadge: "Coding agent ready",
      customizationIntro:
        "You can edit the prompt directly. Complete these three steps before copying:",
      customizationStepFolder:
        "Open the extracted YouTube Digest project folder in your coding agent.",
      customizationStepReplace:
        "Replace [PROVIDER] and [MODEL] with the service and model you want to use.",
      customizationStepKeys:
        "Never include API keys in the prompt or chat. Enter them yourself after the code is ready.",
      customizationPromptLabel: "Editable customization prompt",
      customizationReminderLabel: "Prompt reminder",
      customizationReminder:
        "Before copying, replace [PROVIDER] and [MODEL] with the provider and model you want to use.",
      customizationPrompt:
        "Customize this local YouTube Digest workspace to use [PROVIDER] with [MODEL]. Work only in the current workspace. Before editing, verify that it contains manifest.json and that the manifest name is YouTube Digest. If verification fails, stop and ask me to open the extracted YouTube Digest project folder in my coding agent. Do not search other folders, edit a guessed copy, assume an installation path, or claim Chrome can reveal the absolute OS source path. Update the provider's API endpoint, request format, and minimum Chrome host permissions. Preserve bring-your-own-key and local Chrome storage. Never put API keys in source code, commits, logs, screenshots, this prompt, or chat; after the code is ready, tell me where to enter the key myself. Keep DeepSeek-only request fields and retry behavior isolated to DeepSeek. Handle provider-specific rules separately so one provider does not affect another. Update README.md, README.zh-CN.md, PRIVACY.md, SECURITY.md, and tests. Run npm test, npm run check, and npm run package. Then explain how to reload the unpacked extension and test it on a real YouTube video.",
      copyCustomizationPrompt: "Copy edited prompt",
      localData: "Local data",
      localDataHelp:
        "Digests and translations are stored only in this Chrome profile. Notes are stored here too, and are mirrored to the sync service while you are signed in. A note you write in the panel is saved exactly as you wrote it; the Note button on the video page tidies the line that was being spoken up with the AI. You can remove them at any time.",
      clearCache: "Clear cached digests",
      deleteNotes: "Delete all notes",
      resetData: "Reset extension data",
      footer:
        'Read the <a href="https://ytd.panbo.space/privacy" target="_blank" rel="noopener">privacy policy</a> for the complete data-flow description.',
      migrationWarning:
        "Custom provider settings were removed safely. Your Supadata key was kept, but the AI key was cleared. Enter the API key of your chosen AI provider to continue.",
      saving: "Saving…",
      addSupadataKey: "Add a Supadata API key.",
      addAiKey: "Add the API key of your chosen AI provider.",
      saved: "Saved. Reopen YouTube Digest to use these settings.",
      savedWithoutAiKey:
        "Saved. Add the API key of your chosen AI provider to use the AI features.",
      saveFailed: "Could not save settings. Please try again.",
      storageIsolationFailed:
        "This browser could not lock the extension's storage, so the YouTube page may be able to read your API keys.",
      importedToAccount: ({ notes, words }) => {
        const parts = [];
        if (notes > 0) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
        if (words > 0) parts.push(`${words} word${words === 1 ? "" : "s"}`);
        return `Moved ${parts.join(" and ")} saved while signed out into your account.`;
      },
      copying: "Copying…",
      promptCopied: "Edited prompt copied.",
      copyFailed:
        "Could not copy the prompt. Select the prompt text and copy it manually.",
      clearedDigests: ({ count }) =>
        `Cleared ${count} cached digest${count === 1 ? "" : "s"}.`,
      notesDeletedSignedIn: ({ count }) =>
        `Deleted ${count} note${count === 1 ? "" : "s"} in your account, and the notes on this device.`,
      notesDeletedSignedOut: ({ count }) =>
        `Deleted ${count} note${count === 1 ? "" : "s"} on this device.`,
      notesDeleteFailed: ({ message }) =>
        `Could not delete the notes in your account: ${message}. Nothing was deleted.`,
      resetConfirm:
        "Delete API keys, cached digests, translations, and saved notes from this Chrome profile?",
      allDataDeleted: "All YouTube Digest data was deleted.",
      settingsLoadFailed:
        "Could not load saved settings. You can still preview this page.",
    },
    "zh-CN": {
      pageTitle: "YouTube Digest 设置",
      languageGroupLabel: "界面语言",
      heading: "使用你自己的 API 密钥",
      lede:
        "密钥仅保存在当前 Chrome 个人资料中，只会发送给 Supadata 和你选择的 AI 服务。本扩展不使用分析统计或行为追踪。如果你在下方使用 GitHub 登录，已保存的笔记会镜像到本项目自建的同步服务 ytd.panbo.space；不登录时不会有任何数据离开这台设备。",
      transcriptProvider: "字幕服务",
      supadataApiKeyLabel: "Supadata API 密钥",
      supadataKeyPlaceholder: "粘贴你的 Supadata 密钥",
      supadataHelp:
        "可选。字幕直接从 YouTube 页面里读；只有读不到的时候，才需要这个密钥作为兜底。",
      supadataLink: "创建 Supadata 账号并获取密钥",
      supadataHelpSuffix: "。Supadata 会在引导流程中生成密钥。",
      aiProvider: "AI 服务",
      deepseekApiKeyLabel: "DeepSeek API 密钥",
      deepseekKeyPlaceholder: "粘贴你的 DeepSeek 密钥",
      deepseekHelp:
        "YouTube Digest 使用 DeepSeek V4 Flash 生成概览、解释内容、翻译字幕，以及整理从视频页面保存的笔记。",
      deepseekLink: "创建 DeepSeek API 密钥",
      deepseekHelpSuffix: "。",
      deepseekPrivacyNote:
        "使用 AI 功能时，DeepSeek 会收到视频字幕及相关视频上下文。保存前请查看 DeepSeek 的服务条款和价格。",
      minimaxApiKeyLabel: "MiniMax API 密钥",
      minimaxKeyPlaceholder: "粘贴你的 MiniMax 密钥",
      minimaxHelp:
        "YouTube Digest 使用 MiniMax M3 生成概览、解释内容、翻译字幕，以及整理从视频页面保存的笔记。",
      minimaxLink: "创建 MiniMax API 密钥",
      minimaxHelpSuffix: "。",
      minimaxPrivacyNote:
        "使用 AI 功能时，MiniMax 会收到视频字幕及相关视频上下文。保存前请查看 MiniMax 的服务条款和价格。",
      opencodeGoApiKeyLabel: "OpenCode Go API 密钥",
      opencodeGoKeyPlaceholder: "粘贴你的 OpenCode Go 密钥",
      opencodeGoHelp:
        "OpenCode Go 是包含 DeepSeek V4 Flash 的低价订阅服务。YouTube Digest 用它生成概览、解释内容、翻译字幕，以及整理从视频页面保存的笔记。",
      opencodeGoLink: "创建 OpenCode Go API 密钥",
      opencodeGoHelpSuffix: "。",
      opencodeGoPrivacyNote:
        "使用 AI 功能时，OpenCode Go 服务会收到视频字幕及相关视频上下文。保存前请查看其服务条款和价格。",
      saveSettings: "保存设置",
      setupGuideTitle: "配置完成！接下来：",
      setupGuideStep1: "打开任意一个有字幕的 YouTube 视频。",
      setupGuideStep2: "点击 YouTube Digest 扩展图标，打开侧边栏。",
      setupGuideStep3: "阅读双语字幕；点 {tabSummary} 查看 AI 摘要；在视频上按 n 键保存笔记。",
      tabTranscript: "字幕",
      tabSummary: "摘要",
      tabNotes: "笔记",
      tabWords: "词汇",
      tabLibrary: "资料库",
      githubSync: "GitHub 同步",
      githubSyncIntro:
        "使用 GitHub 登录，把你的笔记备份到本项目自建的同步服务 ytd.panbo.space。每个 GitHub 账户的数据相互隔离，换一个账户登录即可切换学习者档案。",
      githubLogin: "使用 GitHub 登录",
      githubLogout: "退出登录",
      githubLoginFailed: "GitHub 登录失败，请重试。",
      githubSessionExpired: "登录已过期，请重新登录。",
      githubSignedOut: "已退出登录。这台设备上没有需要清除的账号数据。",
      githubSignedOutWithAccount:
        "已退出登录。这台设备上属于你账号的笔记和单词已清除；同步服务上的账号数据仍然保留。",
      logoutUnsyncedConfirm: ({ notes, words }) => {
        const parts = [];
        if (notes > 0) parts.push(`${notes} 条笔记`);
        if (words > 0) parts.push(`${words} 个单词`);
        return `这台设备上有 ${parts.join("和")}还没有到达你的账号。退出登录会把它们从浏览器中永久删除。确定要退出登录吗？`;
      },
      githubDeleteAccount: "删除我的账号",
      githubDeleteAccountConfirm:
        "确定删除你的账号以及全部笔记、单词和复习进度吗？此操作无法撤销。",
      githubDeleteAccountReally:
        "真的要删除所有数据吗？服务器上和这台设备上的都会删掉，此操作是永久的。",
      githubDeleteAccountDeleted:
        "账号已删除。这台设备上的笔记和单词也一并清除了。",
      githubDeleteAccountNotSignedIn: "你当前没有登录，没有可删除的账号。",
      githubDeleteAccountFailed: "无法删除账号：{message}",
      localRemix: "本地改造",
      customizationTitle: "想使用其他 AI 模型？",
      customizationPurpose: "编辑并复制一段可安全交给编程 Agent 的提示词",
      agentBadge: "可交给编程 Agent",
      customizationIntro: "你可以直接编辑提示词。复制前完成以下三步：",
      customizationStepFolder:
        "在编程 Agent 中打开 YouTube Digest 解压后的项目文件夹。",
      customizationStepReplace:
        "把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationStepKeys:
        "不要在提示词或聊天中加入 API 密钥。代码准备好后，请自行填写。",
      customizationPromptLabel: "可编辑的自定义提示词",
      customizationReminderLabel: "提示词提醒",
      customizationReminder:
        "复制前，请先把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationPrompt:
        "请把当前本地 YouTube Digest 工作区改为使用 [PROVIDER] 提供的 [MODEL]。只在当前工作区中操作。编辑前，先确认其中包含 manifest.json，且 manifest 中的 name 是 YouTube Digest。如果验证失败，请停止，并让我在编程 Agent 中打开 YouTube Digest 解压后的项目文件夹。不要搜索其他文件夹，不要编辑猜测的副本，不要假设安装路径，也不要声称 Chrome 可以显示操作系统中的绝对源码路径。更新该服务的 API endpoint、请求格式和最少的 Chrome host permissions。保留用户自带密钥模式和 Chrome 本地存储。不要把 API 密钥写入源代码、提交记录、日志、截图、这段提示词或聊天；代码准备好后，请告诉我应该在哪里自行填写密钥。DeepSeek 专用的请求参数和重试逻辑继续只用于 DeepSeek。新服务的专属规则请单独处理，避免相互影响。更新 README.md、README.zh-CN.md、PRIVACY.md、SECURITY.md 和测试。运行 npm test、npm run check 和 npm run package。最后，说明如何重新加载已解压的扩展，并在真实 YouTube 视频上测试。",
      copyCustomizationPrompt: "复制编辑后的提示词",
      localData: "本地数据",
      localDataHelp:
        "摘要和翻译仅保存在当前 Chrome 个人资料中。笔记也保存在这里，登录状态下会同时镜像到同步服务。你在面板里写的笔记会原样保存；视频页面上的「笔记」按钮会用 AI 整理当时正在说的那句话。你可以随时删除。",
      clearCache: "清除缓存的摘要",
      deleteNotes: "删除全部笔记",
      resetData: "重置扩展数据",
      footer:
        '完整数据流说明请参阅 <a href="https://ytd.panbo.space/privacy?lang=zh-CN" target="_blank" rel="noopener">隐私政策</a>。',
      migrationWarning:
        "已安全移除自定义服务设置。Supadata 密钥已保留，AI 密钥已清除。请输入你所选 AI 服务的 API 密钥以继续使用。",
      saving: "正在保存…",
      addSupadataKey: "请添加 Supadata API 密钥。",
      addAiKey: "请添加你所选 AI 服务的 API 密钥。",
      saved: "已保存。请重新打开 YouTube Digest 以使用这些设置。",
      savedWithoutAiKey: "已保存。请添加你所选 AI 服务的 API 密钥以使用 AI 功能。",
      saveFailed: "无法保存设置，请重试。",
      storageIsolationFailed:
        "这个浏览器没能锁住扩展的存储，YouTube 页面可能读得到你的 API 密钥。",
      importedToAccount: ({ notes, words }) => {
        const parts = [];
        if (notes > 0) parts.push(`${notes} 条笔记`);
        if (words > 0) parts.push(`${words} 个单词`);
        return `已将退出登录时保存的 ${parts.join("和")} 移入你的账号。`;
      },
      copying: "正在复制…",
      promptCopied: "已复制编辑后的提示词。",
      copyFailed: "无法复制提示词。请选中提示词文本并手动复制。",
      clearedDigests: ({ count }) => `已清除 ${count} 条缓存摘要。`,
      notesDeletedSignedIn: ({ count }) =>
        `已删除账号中的 ${count} 条笔记，以及这台设备上的笔记。`,
      notesDeletedSignedOut: ({ count }) => `已删除这台设备上的 ${count} 条笔记。`,
      notesDeleteFailed: ({ message }) => `无法删除账号中的笔记：${message}。没有删除任何笔记。`,
      resetConfirm:
        "要从当前 Chrome 个人资料中删除 API 密钥、缓存摘要、翻译和已保存的笔记吗？",
      allDataDeleted: "已删除全部 YouTube Digest 数据。",
      settingsLoadFailed: "无法加载已保存的设置，但你仍可预览此页面。",
    },
  };

  function normalizeLanguage(language) {
    return SUPPORTED_LANGUAGES.has(language) ? language : "en";
  }

  function translate(language, key, params = {}) {
    const normalizedLanguage = normalizeLanguage(language);
    const value = COPY[normalizedLanguage][key] ?? COPY.en[key] ?? "";
    if (typeof value === "function") return value(params);
    // Copy that names another part of the interface writes it as {tabSummary}
    // and gets the name the user actually sees. A Chinese instruction that
    // says "click Overview" while the panel calls the tab 概览 points at
    // nothing.
    return String(value).replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name)
        ? String(params[name])
        : match,
    );
  }

  /**
   * The names the side panel gives its tabs. Copy in this page refers to
   * those tabs, so it has to use the same words the panel shows. The values
   * are duplicated from the panel on purpose — the two pages are separate
   * bundles with no shared module — so a test keeps them in step.
   */
  function i18nParams(language) {
    return {
      tabTranscript: translate(language, "tabTranscript"),
      tabSummary: translate(language, "tabSummary"),
      tabNotes: translate(language, "tabNotes"),
      tabWords: translate(language, "tabWords"),
      tabLibrary: translate(language, "tabLibrary"),
    };
  }

  function createStorageAdapter(chromeApi, fallbackStorage) {
    const chromeStorage = chromeApi?.storage?.local;
    const memoryStorage = new Map();

    function fallbackKeys() {
      const keys = [];
      if (!fallbackStorage) return keys;
      try {
        for (let index = 0; index < fallbackStorage.length; index += 1) {
          const key = fallbackStorage.key(index);
          if (key?.startsWith(PREVIEW_STORAGE_PREFIX)) keys.push(key);
        }
      } catch (_error) {
        return [];
      }
      return keys;
    }

    function readFallbackValue(key) {
      try {
        const rawValue = fallbackStorage?.getItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
        );
        if (rawValue !== null && rawValue !== undefined) {
          return JSON.parse(rawValue);
        }
      } catch (_error) {
        // Fall through to memory when localStorage is unavailable or malformed.
      }
      return memoryStorage.get(key);
    }

    function writeFallbackValue(key, value) {
      memoryStorage.set(key, value);
      try {
        fallbackStorage?.setItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
          JSON.stringify(value),
        );
      } catch (_error) {
        // The in-memory copy keeps a restricted preview functional.
      }
    }

    return {
      async get(keys) {
        if (chromeStorage) return chromeStorage.get(keys);

        const requestedKeys =
          keys === null
            ? [
                ...new Set([
                  ...memoryStorage.keys(),
                  ...fallbackKeys().map((key) =>
                    key.slice(PREVIEW_STORAGE_PREFIX.length),
                  ),
                ]),
              ]
            : Array.isArray(keys)
              ? keys
              : [keys];

        return Object.fromEntries(
          requestedKeys
            .map((key) => [key, readFallbackValue(key)])
            .filter(([, value]) => value !== undefined),
        );
      },

      async set(items) {
        if (chromeStorage) return chromeStorage.set(items);
        for (const [key, value] of Object.entries(items)) {
          writeFallbackValue(key, value);
        }
      },

      async remove(keys) {
        if (chromeStorage) return chromeStorage.remove(keys);
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          memoryStorage.delete(key);
          try {
            fallbackStorage?.removeItem(`${PREVIEW_STORAGE_PREFIX}${key}`);
          } catch (_error) {
            // Memory removal is sufficient for this preview session.
          }
        }
      },

      async clear() {
        if (chromeStorage) return chromeStorage.clear();
        memoryStorage.clear();
        for (const key of fallbackKeys()) {
          try {
            fallbackStorage.removeItem(key);
          } catch (_error) {
            // Continue clearing any remaining preview keys.
          }
        }
      },
    };
  }

  async function readPreferredLanguage(storage) {
    const stored = await storage.get(LANGUAGE_STORAGE_KEY);
    return normalizeLanguage(stored[LANGUAGE_STORAGE_KEY]);
  }

  async function persistPreferredLanguage(storage, language) {
    const normalizedLanguage = normalizeLanguage(language);
    await storage.set({ [LANGUAGE_STORAGE_KEY]: normalizedLanguage });
    return normalizedLanguage;
  }

  function updateLanguageButtonState(buttons, language) {
    const normalizedLanguage = normalizeLanguage(language);
    for (const button of buttons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.language === normalizedLanguage),
      );
    }
  }

  function updateLocalizedPrompt(textarea, prompt) {
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const selectionDirection = textarea.selectionDirection;
    const scrollTop = textarea.scrollTop;
    const scrollLeft = textarea.scrollLeft;

    textarea.value = prompt;

    if (
      Number.isInteger(selectionStart) &&
      Number.isInteger(selectionEnd) &&
      typeof textarea.setSelectionRange === "function"
    ) {
      textarea.setSelectionRange(
        Math.min(selectionStart, prompt.length),
        Math.min(selectionEnd, prompt.length),
        selectionDirection || "none",
      );
    }
    textarea.scrollTop = scrollTop;
    textarea.scrollLeft = scrollLeft;
  }

  function createPromptDrafts() {
    return {
      en: translate("en", "customizationPrompt"),
      "zh-CN": translate("zh-CN", "customizationPrompt"),
    };
  }

  function switchPromptDraft(
    drafts,
    currentLanguage,
    nextLanguage,
    currentValue,
  ) {
    const normalizedCurrentLanguage = normalizeLanguage(currentLanguage);
    const normalizedNextLanguage = normalizeLanguage(nextLanguage);
    drafts[normalizedCurrentLanguage] = String(currentValue ?? "");
    if (typeof drafts[normalizedNextLanguage] !== "string") {
      drafts[normalizedNextLanguage] = translate(
        normalizedNextLanguage,
        "customizationPrompt",
      );
    }
    return {
      language: normalizedNextLanguage,
      prompt: drafts[normalizedNextLanguage],
    };
  }

  async function copyPromptValue(clipboard, value) {
    await clipboard.writeText(value);
  }

  function getSafeLocalStorage(root) {
    try {
      return root.localStorage;
    } catch (_error) {
      return null;
    }
  }

  function initialize(root = globalThis) {
    const doc = root.document;
    const settingsApi = root.YTD_SETTINGS;
    if (!doc || !settingsApi) return;

    const storage = createStorageAdapter(
      root.chrome,
      getSafeLocalStorage(root),
    );
    const form = doc.getElementById("settingsForm");
    const providerRadios = [
      ...doc.querySelectorAll('input[name="aiProviderChoice"]'),
    ];
    const providerFields = [
      ...doc.querySelectorAll("[data-provider-field]"),
    ];
    const aiApiKeyInput = doc.getElementById("aiApiKey");
    const minimaxApiKeyInput = doc.getElementById("minimaxApiKey");
    const opencodeGoApiKeyInput = doc.getElementById("opencodeGoApiKey");
    const supadataApiKeyInput = doc.getElementById("supadataApiKey");
    const customizationPrompt = doc.getElementById("customizationPrompt");
    const copyCustomizationPromptBtn = doc.getElementById(
      "copyCustomizationPromptBtn",
    );
    const copyStatus = doc.getElementById("copyStatus");
    const saveStatus = doc.getElementById("saveStatus");
    const dataStatus = doc.getElementById("dataStatus");
    const githubAccount = doc.getElementById("githubAccount");
    const githubLoginName = doc.getElementById("githubLoginName");
    const githubLoginBtn = doc.getElementById("githubLoginBtn");
    const githubLogoutBtn = doc.getElementById("githubLogoutBtn");
    const githubDeleteAccountBtn = doc.getElementById("githubDeleteAccountBtn");
    const githubStatus = doc.getElementById("githubStatus");
    const languageButtons = [...doc.querySelectorAll("[data-language]")];
    const statusStates = new Map();
    const promptDrafts = createPromptDrafts();
    let currentLanguage = "en";
    // True when the browser could not lock the extension's storage away
    // from the YouTube page. The user did not cause it, so the page says it
    // in one calm sentence and keeps it on screen while the page is open.
    let storageIsolationFailed = false;

    function selectedProviderId() {
      const checked = providerRadios.find((radio) => radio.checked);
      return checked ? checked.value : "deepseek";
    }

    function selectedProviderKey(settings) {
      return settings[settingsApi.getProvider(selectedProviderId()).apiKeyField];
    }

    function syncProviderFields() {
      const providerId = selectedProviderId();
      for (const field of providerFields) {
        field.hidden = field.dataset.providerField !== providerId;
      }
    }

    /**
     * Asks who the reader is, through the background.
     *
     * The page cannot answer this itself any more. A session belongs to the
     * browser that started the sign-in, and only the background knows this
     * browser's id and puts it on the request. A token sent from here would
     * be refused for a session that is perfectly good.
     *
     * The answer has three shapes, and confusing two of them signs people
     * out of a working account:
     *  - a session: the reader is signed in, here is who they are;
     *  - expired: the service said the token is no good, so sign them out;
     *  - not success: the service did not answer, so nothing is known.
     */
    async function fetchGithubProfile() {
      const result = await root.chrome.runtime.sendMessage({
        action: "verifyGithubSession",
      });
      if (result?.session) return result.session;
      if (result?.expired === true) return null;
      throw new Error(result?.error || "The sync service did not answer.");
    }

    function renderGithubSignedIn(login) {
      githubAccount.hidden = false;
      githubLoginBtn.hidden = true;
      githubLoginName.textContent = login;
    }

    function renderGithubSignedOut() {
      githubAccount.hidden = true;
      githubLoginBtn.hidden = false;
      githubLoginName.textContent = "";
    }

    /**
     * One writer at a time for the session.
     *
     * The page asks the server who the reader is and writes the answer
     * back. A sign-out or an account deletion removes the session. If the
     * two happen at the same time, the answer must not be written back
     * after the removal: that would sign the reader in again to an account
     * that no longer exists.
     */
    let sessionWrite = Promise.resolve();
    function withSessionLock(action) {
      const next = sessionWrite.then(action, action);
      sessionWrite = next.then(
        () => {},
        () => {},
      );
      return next;
    }

    async function loadGithubAccount() {
      const stored = await storage.get(settingsApi.GITHUB_SESSION_KEY);
      const session = stored[settingsApi.GITHUB_SESSION_KEY];
      if (!session || !session.token) {
        renderGithubSignedOut();
        await showImportReport();
        return;
      }
      renderGithubSignedIn(session.login || "GitHub");
      try {
        const profile = await fetchGithubProfile();
        if (profile) {
          await withSessionLock(async () => {
            // The session may be gone by now: the reader may have deleted
            // the account while the server was being asked who they are.
            // Writing the session back would sign them in again to an
            // account that no longer exists.
            const current = await storage.get(settingsApi.GITHUB_SESSION_KEY);
            if (!current[settingsApi.GITHUB_SESSION_KEY]) {
              renderGithubSignedOut();
              return;
            }
            await storage.set({
              [settingsApi.GITHUB_SESSION_KEY]: {
                ...session,
                login: profile.login,
                githubId: profile.githubId,
              },
            });
            renderGithubSignedIn(profile.login);
          });
        } else {
          // The server rejected the token: treat the session as expired.
          await storage.remove(settingsApi.GITHUB_SESSION_KEY);
          renderGithubSignedOut();
          setStatus(githubStatus, "githubSessionExpired");
        }
      } catch (_error) {
        // Server unreachable: keep the cached identity and stay signed in.
      }
      await showImportReport();
    }

    /**
     * Tells the user what the first sign-in moved into the account.
     *
     * The import carries the notes and words that were saved while signed
     * out into the account, and the privacy policy promises that nothing
     * leaves the device while signed out. So the move has to be said out
     * loud, with the numbers.
     *
     * The counts are read from the device rather than from the message
     * that announced the sign-in, because the settings page may not have
     * been open when the sign-in finished. The report is read once: a
     * number the user has seen does not need to be said again.
     */
    async function showImportReport() {
      let stored;
      try {
        stored = await storage.get(settingsApi.IMPORT_REPORT_STORAGE_KEY);
      } catch (_error) {
        return;
      }
      const report = stored[settingsApi.IMPORT_REPORT_STORAGE_KEY];
      if (!report) return;
      const notes = Number(report.notes) || 0;
      const words = Number(report.words) || 0;
      await storage.remove(settingsApi.IMPORT_REPORT_STORAGE_KEY);
      // Nothing moved, so there is nothing to say.
      if (notes <= 0 && words <= 0) return;
      setStatus(githubStatus, "importedToAccount", { notes, words });
    }

    async function startGithubLogin() {
      // The background builds the sign-in link, because the link has to
      // name this browser: the session it creates is bound to the browser
      // that asked for it, and only the background knows that id. A link
      // built here would create a session nobody can use.
      //
      // It also owns the nonce that ties the sign-in to this browser, and
      // the language the sign-in page speaks. The panel has always done it
      // this way; this page is catching up.
      await root.chrome.runtime.sendMessage({ action: "startGithubLogin" });
      // The background finishes the sign-in and says so; this page only
      // shows the result.
    }

    /**
     * Counts the items of the account that have never reached it.
     *
     * A note or a word with no cloud id is one the account has never seen.
     * It exists only on this device, so a sign-out deletes its last copy.
     */
    async function unsyncedAccountItems(githubId) {
      if (!githubId) return { notes: 0, words: 0 };
      const noteKey = settingsApi.notesStorageKey(githubId);
      const wordKey = settingsApi.vocabularyStorageKey(githubId);
      let stored;
      try {
        stored = await storage.get([noteKey, wordKey]);
      } catch (_error) {
        return { notes: 0, words: 0 };
      }
      const unsynced = (key) => {
        const items = stored[key];
        if (!Array.isArray(items)) return 0;
        return items.filter((item) => item && !item.cloudId).length;
      };
      return { notes: unsynced(noteKey), words: unsynced(wordKey) };
    }

    /**
     * Signs out of the account.
     *
     * The sign-out is not only the end of the session: the account's notes
     * and words leave this device with it. A shared browser is the reason.
     * The next person who opens the panel would otherwise read the notes
     * of the person who was here before, without ever signing in.
     *
     * One case needs a word first: an item that never reached the account
     * exists only on this device, so signing out deletes its last copy.
     * That is the right thing to do on a shared browser, but the user has
     * to be asked before it happens, because it cannot be undone.
     *
     * The background does the work, because the registry that knows which
     * keys hold the account's data lives with it. The page checks that the
     * session is really gone and finishes the job itself when it is not.
     */
    async function logoutGithub() {
      const stored = await storage.get(settingsApi.GITHUB_SESSION_KEY);
      const session = stored[settingsApi.GITHUB_SESSION_KEY];
      const wasSignedIn = !!(session && session.token);
      const githubId = session && session.githubId;

      const unsynced = await unsyncedAccountItems(githubId);
      if (unsynced.notes + unsynced.words > 0) {
        const confirmed = root.confirm(
          translate(currentLanguage, "logoutUnsyncedConfirm", unsynced),
        );
        if (!confirmed) return;
      }

      try {
        await root.chrome.runtime.sendMessage({ action: "logoutGithub" });
      } catch (_error) {
        // The background could not be reached. The page does the same work.
      }
      const after = await storage.get(settingsApi.GITHUB_SESSION_KEY);
      if (after[settingsApi.GITHUB_SESSION_KEY]) {
        // The session is still here, so the sign-out did not happen.
        if (githubId) {
          await settingsApi.clearAccountScopedStorage(githubId, storage);
        }
        await withSessionLock(() =>
          storage.remove(settingsApi.GITHUB_SESSION_KEY),
        );
      }
      renderGithubSignedOut();
      setStatus(
        githubStatus,
        wasSignedIn ? "githubSignedOutWithAccount" : "githubSignedOut",
      );
    }

    /**
     * Deletes the signed-in account, on the server and on this device.
     *
     * The account lives on the sync service, so the account has to be
     * deleted there: the extension cannot pretend it is gone. The notes and
     * words that belong to it live in this browser profile under a
     * namespace named after the account, and they go with it - a namespace
     * nobody owns any more is data the user cannot reach and cannot
     * delete.
     *
     * Two questions are asked, because the first one is easy to click
     * through by accident and the second one is not.
     */
    async function deleteGithubAccount() {
      const stored = await storage.get(settingsApi.GITHUB_SESSION_KEY);
      const session = stored[settingsApi.GITHUB_SESSION_KEY];
      if (!session || !session.token) {
        renderGithubSignedOut();
        setStatus(githubStatus, "githubDeleteAccountNotSignedIn");
        return;
      }
      const confirmed = root.confirm(
        translate(currentLanguage, "githubDeleteAccountConfirm"),
      );
      if (!confirmed) return;
      const really = root.confirm(
        translate(currentLanguage, "githubDeleteAccountReally"),
      );
      if (!really) return;

      // The background sends the request, because the session is bound to
      // this browser and only the background knows its id. A request from
      // this page would be refused, and the account would look undeletable.
      let result;
      try {
        result = await root.chrome.runtime.sendMessage({
          action: "deleteGithubAccount",
        });
      } catch (error) {
        setStatus(githubStatus, "githubDeleteAccountFailed", {
          message: error.message,
        });
        return;
      }
      if (!result?.success) {
        const message =
          result?.error || "HTTP " + (result?.status || "unknown");
        setStatus(githubStatus, "githubDeleteAccountFailed", { message });
        return;
      }

      // The account is gone from the server, so the local copy of its data
      // goes too. The registry knows every key the account left on this
      // device: its notes, its words, the two drop notices and the two
      // queues of deletes that had not reached the server yet. The queue of
      // word deletes carries the user's own sentences, so a queue left
      // behind is a sentence the user can still read after the account is
      // gone.
      //
      // The buckets that hold what was written while signed out are on the
      // disk as well, and they are not named after the account. They are
      // the user's notes and words too, so "delete my account" has to take
      // them with it: the button promises that everything on this device
      // goes, and a sentence left behind is a sentence the user can still
      // read.
      const githubId = session.githubId;
      await withSessionLock(async () => {
        if (githubId) {
          await settingsApi.clearAccountScopedStorage(githubId, storage);
        }
        await storage.remove([
          settingsApi.NOTES_STORAGE_KEY,
          settingsApi.VOCABULARY_STORAGE_KEY,
          // The report of what the first sign-in moved into the account
          // describes an account that no longer exists.
          settingsApi.IMPORT_REPORT_STORAGE_KEY,
        ]);
        await storage.remove(settingsApi.GITHUB_SESSION_KEY);
      });
      renderGithubSignedOut();
      setStatus(githubStatus, "githubDeleteAccountDeleted");
    }

    function renderStatus(element) {
      if (element === saveStatus) {
        renderSaveStatus();
        return;
      }
      const state = statusStates.get(element);
      element.textContent = state
        ? translate(currentLanguage, state.key, state.params)
        : "";
    }

    /**
     * Draws the status of the save area.
     *
     * The storage notice lives here as well, because it is a condition of
     * the page and not of one action: a save that says "Saved" must not
     * hide the fact that the keys on this device are not locked away from
     * the YouTube page.
     */
    function renderSaveStatus() {
      const state = statusStates.get(saveStatus);
      const saved = state
        ? translate(currentLanguage, state.key, state.params)
        : "";
      const notice = storageIsolationFailed
        ? translate(currentLanguage, "storageIsolationFailed")
        : "";
      saveStatus.textContent = [saved, notice].filter(Boolean).join(" ");
    }

    function setStatus(element, key, params = {}) {
      statusStates.set(element, { key, params });
      renderStatus(element);
    }

    function applyLanguage(language) {
      const nextDraft = switchPromptDraft(
        promptDrafts,
        currentLanguage,
        language,
        customizationPrompt.value,
      );
      currentLanguage = nextDraft.language;
      doc.documentElement.lang = currentLanguage;
      doc.title = translate(currentLanguage, "pageTitle");

      for (const element of doc.querySelectorAll("[data-i18n]")) {
        element.textContent = translate(
          currentLanguage,
          element.dataset.i18n,
          i18nParams(currentLanguage),
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-html]")) {
        element.innerHTML = translate(
          currentLanguage,
          element.dataset.i18nHtml,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-aria-label]")) {
        element.setAttribute(
          "aria-label",
          translate(currentLanguage, element.dataset.i18nAriaLabel),
        );
      }
      // A placeholder is a label too. The four key fields carried English
      // placeholders on a Chinese page, and a Chinese user was told to
      // paste a key in a language they were not reading.
      for (const element of doc.querySelectorAll("[data-i18n-placeholder]")) {
        element.setAttribute(
          "placeholder",
          translate(currentLanguage, element.dataset.i18nPlaceholder),
        );
      }

      updateLocalizedPrompt(
        customizationPrompt,
        nextDraft.prompt,
      );
      updateLanguageButtonState(languageButtons, currentLanguage);
      for (const element of statusStates.keys()) renderStatus(element);
    }

    async function loadSettings() {
      try {
        const stored = await storage.get(settingsApi.STORAGE_KEY);
        const migration = settingsApi.migrateLegacyCustom(
          stored[settingsApi.STORAGE_KEY],
        );
        const settings = migration.settings;

        aiApiKeyInput.value = settings.aiApiKey;
        minimaxApiKeyInput.value = settings.minimaxApiKey;
        opencodeGoApiKeyInput.value = settings.opencodeGoApiKey;
        supadataApiKeyInput.value = settings.supadataApiKey;
        for (const radio of providerRadios) {
          radio.checked = radio.value === settings.provider;
        }
        syncProviderFields();
        if (migration.migrated) {
          await storage.set({ [settingsApi.STORAGE_KEY]: settings });
          setStatus(saveStatus, "migrationWarning");
        }
      } catch (_error) {
        setStatus(saveStatus, "settingsLoadFailed");
      }
    }

    async function loadOptions() {
      void loadGithubAccount();
      // The background completes the sign-in and announces it. Without this
      // the page would sit on "sign in" while the sign-in had already
      // succeeded.
      root.chrome?.runtime?.onMessage?.addListener?.((message) => {
        if (!message || typeof message !== "object") return;
        if (message.action === "githubLoginChanged") {
          void loadGithubAccount();
        } else if (message.action === "githubLoginFailed") {
          setStatus(githubStatus, "githubLoginFailed");
        }
      });
      try {
        applyLanguage(await readPreferredLanguage(storage));
      } catch (_error) {
        applyLanguage("en");
      }
      await loadSettings();
      // The next steps are shown whenever the page is showing. A user who
      // has no AI key yet never saved anything, and the guide is what
      // tells them that pressing "n" on a video saves a note - a shortcut
      // that works without any key at all.
      showSetupGuide();
      await checkStorageIsolation();
    }

    /**
     * Shows the next steps.
     */
    function showSetupGuide() {
      const guide = doc.getElementById("setupGuide");
      if (guide) guide.hidden = false;
    }

    /**
     * Asks the background whether the storage is locked away from the
     * YouTube page.
     *
     * The call that locks it can fail, and a failure that only reaches the
     * console is a failure the user never hears about. The page says it in
     * one sentence: the user did not cause it, so it is not an alarm, just
     * a fact about this browser.
     */
    async function checkStorageIsolation() {
      let result;
      try {
        result = await root.chrome.runtime.sendMessage({
          action: "getStorageIsolation",
        });
      } catch (_error) {
        // The background could not be asked, so nothing is known and
        // nothing is claimed.
        return;
      }
      if (result && result.restricted === false) {
        storageIsolationFailed = true;
        renderSaveStatus();
      }
    }

    async function saveSettings(event) {
      event.preventDefault();
      setStatus(saveStatus, "saving");

      const settings = settingsApi.normalize({
        provider: selectedProviderId(),
        aiApiKey: aiApiKeyInput.value,
        minimaxApiKey: minimaxApiKeyInput.value,
        opencodeGoApiKey: opencodeGoApiKeyInput.value,
        supadataApiKey: supadataApiKeyInput.value,
      });

      try {
        // Everything the user typed is saved. The Supadata key is a
        // fallback, the provider is a choice and the language is a
        // preference: none of them needs an AI key. The AI key is what the
        // summary and the translation need, so a missing one is reported
        // after the save - not instead of it. Refusing the whole save
        // threw away the key the user had just pasted, and with it the
        // language they had chosen.
        await storage.set({ [settingsApi.STORAGE_KEY]: settings });
      } catch (_error) {
        setStatus(saveStatus, "saveFailed");
        return;
      }
      if (selectedProviderKey(settings)) {
        setStatus(saveStatus, "saved");
      } else {
        setStatus(saveStatus, "savedWithoutAiKey");
      }
    }

    async function copyCustomizationPrompt() {
      setStatus(copyStatus, "copying");
      try {
        await copyPromptValue(
          root.navigator.clipboard,
          customizationPrompt.value,
        );
        setStatus(copyStatus, "promptCopied");
      } catch (_error) {
        setStatus(copyStatus, "copyFailed");
      }
    }

    async function clearCachedDigests() {
      const all = await storage.get(null);
      const keys = Object.keys(all).filter((key) => key.startsWith("digest_"));
      if (keys.length) await storage.remove(keys);
      // The list of what is cached goes with the cache. The panel reads
      // that list to count the cached digests and to know how much room
      // they take, so a list that outlives the cache makes the panel
      // believe in videos the device no longer has.
      await storage.remove(settingsApi.DIGEST_CACHE_INDEX_KEY);
      setStatus(dataStatus, "clearedDigests", { count: keys.length });
    }

    async function clearNotes() {
      // Notes live in a namespace that depends on the signed-in account:
      // "ytd_notes" while signed out, "ytd_notes_<githubId>" while signed in
      // (see YTD_SETTINGS.notesStorageKey). Removing only the signed-out
      // key left every note of a signed-in user in place while the UI
      // reported that they were gone.
      //
      // The notes of a signed-in user are also in the account, and a note
      // that is only removed here comes back with the next sync. So the
      // account is asked to delete its notes first, and the device is
      // cleaned afterwards. If the account cannot do it, nothing is
      // deleted and the user is told: a note that comes back is worse than
      // a note that stays with a clear message.
      const stored = await storage.get(settingsApi.GITHUB_SESSION_KEY);
      const session = stored[settingsApi.GITHUB_SESSION_KEY];
      const signedIn = !!(session && session.token);
      let deletedInAccount = 0;
      if (signedIn) {
        let result;
        try {
          result = await root.chrome.runtime.sendMessage({
            action: "deleteAllNotes",
          });
        } catch (error) {
          setStatus(dataStatus, "notesDeleteFailed", {
            message: error.message,
          });
          return;
        }
        if (!result || result.success !== true) {
          setStatus(dataStatus, "notesDeleteFailed", {
            message:
              (result && result.error) ||
              "HTTP " + ((result && result.status) || "unknown"),
          });
          return;
        }
        deletedInAccount = Number(result.deleted) || 0;
      }
      const all = await storage.get(null);
      const keys = Object.keys(all).filter((key) =>
        settingsApi.isNotesStorageKey(key),
      );
      const count = keys.reduce((sum, key) => {
        const value = all[key];
        return sum + (Array.isArray(value) ? value.length : 0);
      }, 0);
      if (keys.length) await storage.remove(keys);
      if (signedIn) {
        setStatus(dataStatus, "notesDeletedSignedIn", {
          count: deletedInAccount,
        });
        return;
      }
      setStatus(dataStatus, "notesDeletedSignedOut", { count });
    }

    async function resetAllData() {
      const confirmed = root.confirm(
        translate(currentLanguage, "resetConfirm"),
      );
      if (!confirmed) return;

      await storage.clear();
      await persistPreferredLanguage(storage, currentLanguage);
      await loadSettings();
      setStatus(dataStatus, "allDataDeleted");
    }

    githubLoginBtn.addEventListener("click", startGithubLogin);
    githubLogoutBtn.addEventListener("click", logoutGithub);
    githubDeleteAccountBtn.addEventListener("click", deleteGithubAccount);

    form.addEventListener("submit", saveSettings);
    for (const radio of providerRadios) {
      radio.addEventListener("change", syncProviderFields);
    }
    copyCustomizationPromptBtn.addEventListener(
      "click",
      copyCustomizationPrompt,
    );
    doc
      .getElementById("clearCacheBtn")
      .addEventListener("click", clearCachedDigests);
    doc.getElementById("clearNotesBtn").addEventListener("click", clearNotes);
    doc.getElementById("resetBtn").addEventListener("click", resetAllData);
    for (const button of languageButtons) {
      button.addEventListener("click", async () => {
        const language = button.dataset.language;
        applyLanguage(language);
        await persistPreferredLanguage(storage, language);
      });
    }

    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", loadOptions, { once: true });
    } else {
      void loadOptions();
    }

    // The data actions are handed back so the tests can drive the real
    // functions. They used to be reachable only through a click handler,
    // which made it impossible to prove that "Delete all notes" actually
    // removed the notes of a signed-in account.
    return {
      clearNotes,
      clearCachedDigests,
      resetAllData,
      loadOptions,
      startGithubLogin,
      logoutGithub,
      saveSettings,
      deleteGithubAccount,
    };
  }

  return {
    COPY,
    LANGUAGE_STORAGE_KEY,
    copyPromptValue,
    createPromptDrafts,
    createStorageAdapter,
    i18nParams,
    normalizeLanguage,
    persistPreferredLanguage,
    readPreferredLanguage,
    translate,
    updateLanguageButtonState,
    updateLocalizedPrompt,
    switchPromptDraft,
    initialize,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_OPTIONS;
}

if (typeof document !== "undefined") {
  YTD_OPTIONS.initialize();
}

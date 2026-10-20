# YouTube Digest

[English](README.md) | [简体中文](README.zh-CN.md)

Turn every YouTube video into a resource for deep learning. YouTube Digest brings transcripts, bilingual translation, AI summaries, explanations, timestamped notes, and a vocabulary notebook into one Chrome side panel, so you can study ideas and language without losing your place.

- Turn captions into a readable, searchable learning resource.
- Learn languages with the original transcript, a Simplified Chinese translation, or an aligned bilingual view.
- Build understanding with an AI summary, chapters, key quotes, and selected-text explanations.
- Navigate long videos by clicking timestamps in the transcript, summary, or notes.
- Save polished timestamped notes for later study.
- Build a vocabulary notebook from the transcript, with spaced review built in.
- Keep the videos you have read in a 30-day library, so opening one again costs nothing.
- Read your notes, favorites and vocabulary on any device through the web dashboard that comes with the sync service.
- Keep control of your data with your own API keys, local Chrome storage, and no analytics or telemetry.

YouTube Digest is a bring-your-own-key project installed locally from GitHub. It is not available through the Chrome Web Store and does not include API credits. The extension has no analytics and no telemetry. If you sign in with GitHub, the optional sync feature mirrors your saved notes and words to this project's own sync service at `https://ytd.panbo.space`; without signing in, no note or word data leaves your device.

![YouTube Digest demo](YouTube%20Digest%20demo.jpg)

The absolute address of the image above, for use outside this repository. The file name contains a space, so it is written as `%20`: `https://raw.githubusercontent.com/hibernate-pano/youtube-digest/main/YouTube%20Digest%20demo.jpg`

## New in v1.7.0

- The transcript is read out of the page you are already watching, so most videos cost nothing. The Supadata key is now optional, and it is only used when the page cannot be read.
- A video longer than an hour shows the real time. A chapter 90 minutes in used to read "90:00", the same as 150 minutes; it now reads "1:30:00", and clicking it takes you to the right place.
- A translation that fails is retried by itself. A dropped connection no longer leaves a paragraph of subtitles in the original language for good.
- A video with no subtitles costs one credit instead of one per visit. The extension remembers for a day, and "Try again" always performs a real new lookup.
- Long videos scroll more smoothly, because the extension stopped asking the browser the same question twice a second.

## New in v1.6.0

- Failures are visible now. When something does not work, the panel says so in a sentence on screen, not only to a screen reader. Saving a note that could not be saved says why, instead of the button quietly going back to normal.
- The panel works with the keyboard alone. Select transcript text with Shift and the arrow keys, and the Explain, Note and Word buttons appear.
- Dialogs keep the focus inside them, and give it back to the button that opened them when they close.
- "Reduce motion" is respected in the panel and in Settings.
- Requests have a deadline. A transcript or sync service that stops answering no longer leaves the panel spinning forever, and a slow service is no longer mistaken for an expired session.
- A full device storage no longer loses notes quietly. The extension asks for unlimited storage, makes room by dropping the cached copies that can be fetched again, and tells you what it dropped.
- "Delete my account" is in the extension's Settings page. It removes the account, its notes, its words and its review progress from the sync service, and this device's copy of them.
- Signing in is bound to the browser that started it. A token copied out of another browser is refused, so a stray link cannot switch the panel to somebody else's account.
- The review section now sits above the word list in the Words tab, because that is the part that is waiting for you.
- The library says "just now" and "3 minutes ago" in your own language.


- The side panel is now five tabs: **Transcript**, **Summary**, **Notes**, **Words**, and **Library**. The old Overview tab is now Summary, and it carries a written summary of the video, not only a list of chapters.
- Capture words from the transcript into a vocabulary notebook: select a word and save it, or let your AI provider pick the words worth learning out of a sentence. Each word keeps its meaning, its sentence, and the moment it came from.
- Review your words on a schedule, with the same four grades the web dashboard uses.
- The library keeps the videos you have read for 30 days, so opening one again costs nothing.
- Search inside the transcript for words or phrases and move through every match.
- Use one Original, Chinese, or bilingual setting across Transcript, Summary, and Notes. New videos stay in Original by default.
- Translate visible Summary and Notes content progressively in small cached batches.
- Explain selected transcript text or save it directly as a timestamped note.
- Keep your transcript position across navigation, with the panel closing automatically outside YouTube video pages.
- Sign in with GitHub to back up your notes and words to the project's sync service, and sign in again on any other device to pick them up.
- Click a note's text to correct it; the edit is saved locally and synced.
- See a clear "Sync expired" chip when the GitHub session ends, and sign in again to resume the backup.

## Install with your coding agent

You do not need to understand the code or use the command line. Send this message to your coding agent:

> Download or clone this project into a permanent folder I choose, tell me its exact full path, and use that same folder for Chrome's Load unpacked step. If I need a suggestion during this first installation, offer `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows, but do not assume either path. Walk me through installation and setup in simple terms. https://github.com/hibernate-pano/youtube-digest

Your agent should:

1. Ask where you want to keep the project, download or clone it there, and tell you the exact full path. If you want a suggestion, it can offer `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows.
2. Open the official Supadata page below and the pages of your chosen AI provider below, and help create accounts.
3. Walk you through selecting the exact project folder you chose in Chrome with **Load unpacked**.
4. Show you where to enter your API keys in the extension's **Settings** page.
5. Open a YouTube video with captions and confirm the transcript and translation work.

Keep this folder in the same place after installation. If you move or delete it, Chrome's unpacked extension stops working until you load the extension again from its new permanent folder.

Never paste an API key into an AI chat, source file, screenshot, or public message. Enter keys yourself, directly in the YouTube Digest Settings page. Your coding agent can point to the correct field without seeing the key.

## Install manually

If you prefer to do it yourself:

1. Open [github.com/hibernate-pano/youtube-digest](https://github.com/hibernate-pano/youtube-digest).
2. Choose **Code**, then **Download ZIP**.
3. Choose a permanent folder and unzip the project there. Optional suggestions are `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows. You may use a different folder.
4. In Chrome, open `chrome://extensions`.
5. Turn on **Developer mode**.
6. Click **Load unpacked**.
7. Select the exact project folder you chose, which must contain `manifest.json`.
8. Pin YouTube Digest from Chrome's Extensions menu if you want quick access.

Because this is an unpacked extension, it does not update automatically. After downloading an update or changing local files, click **Reload** on the YouTube Digest card at `chrome://extensions`, then refresh open YouTube tabs. Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location.

## Set up your API keys

YouTube Digest needs one API key from your chosen AI provider, and optionally a Supadata key:

1. An **AI provider key** from DeepSeek, MiniMax (China), or OpenCode Go, for summaries, explanations, translation, and automatic note polishing. This one is required.
2. A **Supadata API key**, used only as a fallback. Transcripts are read out of the YouTube page you already have open, so most videos work without it and no Supadata credit is spent. Add it if you want the fallback for videos whose captions cannot be read locally.

### Get a Supadata API key (optional)

1. Open the official [Supadata sign-up page](https://dash.supadata.ai/auth/sign-up).
2. Create an account and complete the short onboarding flow.
3. Supadata generates an API key automatically during onboarding.
4. Open the [Supadata dashboard](https://dash.supadata.ai/) whenever you need to find or manage the key.
5. Copy the key and paste it into **Supadata API key** in YouTube Digest Settings.

See the [official Supadata documentation](https://docs.supadata.ai/) if the dashboard flow changes.

### Get a DeepSeek API key

1. Open the official [DeepSeek API Keys page](https://platform.deepseek.com/api_keys).
2. Sign in or create a DeepSeek Platform account when prompted.
3. Choose **Create new API key**, give it a recognizable name such as `YouTube Digest`, and create it.
4. Copy the key immediately. The full key may only be shown once.
5. Paste it into **DeepSeek API key** in YouTube Digest Settings.
6. If DeepSeek reports insufficient balance, add credit in your DeepSeek Platform account and try again.

See the [official DeepSeek API documentation](https://api-docs.deepseek.com/) for current account and API details.

### Get a MiniMax API key (China)

1. Open the [MiniMax platform](https://platform.minimaxi.com) and sign in or create an account.
2. Create an API key in your account settings.
3. Copy the key and paste it into **MiniMax API key** in YouTube Digest Settings.

YouTube Digest uses the MiniMax M3 model through MiniMax's OpenAI-compatible endpoint.

### Get an OpenCode Go API key

1. Open [opencode.ai/auth](https://opencode.ai/auth) and sign in.
2. Subscribe to OpenCode Go and copy your API key.
3. Paste it into **OpenCode Go API key** in YouTube Digest Settings.

OpenCode Go is a low-cost subscription that includes DeepSeek V4 Flash and other open coding models. YouTube Digest uses its DeepSeek V4 Flash model.

Open **Settings** from the side panel. You can also open the YouTube Digest **Options** page from its card at `chrome://extensions` or by right-clicking its toolbar icon. Paste keys only into these Settings fields. Never paste a key into an AI chat, repository file, screenshot, or public message.

The published version supports three AI providers, fixed in Settings so you never configure endpoints by hand:

```text
DeepSeek:    Base URL https://api.deepseek.com          Model deepseek-v4-flash
MiniMax:     Base URL https://api.minimaxi.com/v1       Model MiniMax-M3
OpenCode Go: Base URL https://opencode.ai/zen/go/v1     Model deepseek-v4-flash
```

Keys for all three providers can be saved at once and you switch providers from Settings at any time. Only the selected provider receives requests. DeepSeek requests use non-thinking mode for responsive, predictable interactions; the other providers have their own request behavior. To use a provider or model outside this list, copy the safe customization prompt in Settings and give it to a coding agent for your local copy. Never add an API key to that prompt or chat.

Keys and settings are stored in Chrome's local extension storage on your device. Release builds do not include or use `config.js`.

## Optional GitHub sync

Sign in with GitHub from Settings (or the **Sign in** button in the side panel) to back up your notes and words. Your notes and words are stored in this project's own database on `https://ytd.panbo.space`, a Cloudflare Worker backed by a Neon PostgreSQL database, and are linked to your GitHub account id. They are not written to your GitHub account, and no GitHub repository or gist is created. Every account's data is isolated server-side: the extension stores notes and words under an account-specific namespace, the server scopes every query by the verified token, and signing in with a different account shows that account's data only. Sync is optional: without signing in, everything stays on this device exactly as before, and AI/transcript requests never involve the sync service. When signed in, saved notes and words mirror to the cloud automatically (idempotent, newest edit wins) and appear on any device where you sign in with the same GitHub account.

### The web dashboard

The same service also serves a small web app at `https://ytd.panbo.space`. Sign in with GitHub there and you get the same data in a browser tab, on any device, without installing the extension:

- **Notes** - every note you saved, with the video it came from and a link back to it.
- **Favorites** - the notes you starred in the side panel.
- **Vocabulary** - the words you captured, with their meaning and the sentence they came from.
- **Review** - the spaced-repetition queue for those words, scheduled server-side.
- **Export my data** - a copy of everything the service holds for your account.

The dashboard is read-mostly on purpose: it is the place to *read* and *review* what you collected while watching, and the side panel is where you collect it. Both talk to the same database, and the same per-account isolation applies.

## Use YouTube Digest

1. Open a standard YouTube watch page with captions.
2. Click the YouTube Digest extension icon to open the side panel.
3. Read the timestamped transcript, or choose **Original**, **中文**, or **双语**.
4. Search inside the transcript to find a word or phrase, and step through the matches.
5. Open **Summary** when you want the AI-written summary, chapters, and key quotes. The tab says what the call costs before you spend anything.
6. Select transcript text when you want an AI explanation, or save it as a note.
7. Save a note from the player or a key quote, then revisit it from **Notes**. Click a note's text to correct it.
8. Select a word in the transcript and choose **Word** to add it to your **Words** notebook, or open **Words** and let your AI provider pick the words worth learning out of a selected sentence.

## What works today

- Google Chrome 116 or newer, using the Side Panel API.
- Standard `youtube.com/watch` video pages.
- Native subtitle tracks. YouTube Digest reads them out of the YouTube page you already have open, so no transcript credit is spent. Supadata is used only as a fallback for videos whose captions cannot be read that way. YouTube Digest prefers English when available, but may show another native language.
- Original, Simplified Chinese, and aligned bilingual transcript views, with one content-language setting shared across Transcript, Summary, and Notes.
- Transcript search for words or phrases, with previous and next buttons for every match.
- AI summaries, chapters, key quotes, selected-text explanations, translation, and automatic note polishing.
- Timestamped notes saved from the player, a key quote, or selected transcript text, with click-to-edit correction and buttons to copy the note text or its timestamped link.
- A vocabulary notebook: capture a word from the transcript, keep its meaning, its sentence, and the moment it came from, and review it later on a schedule.
- A library of the videos you have read, kept for 30 days so that opening one again costs no transcript credit.
- Local notes, words, and a local cache for recent transcript and digest results.
- Optional GitHub sync of your saved notes and words to the project's sync service, with one isolated data set per GitHub account.
- DeepSeek V4 Flash, MiniMax M3, and OpenCode Go's DeepSeek V4 Flash for all published AI features. Other providers require a local code adaptation and are not supported by this published version.

Shorts, live streams, private or access-restricted videos, and videos without an available native transcript may not work. Firefox, Safari, mobile browsers, and other Chromium browsers are not currently tested or supported.

YouTube Digest forces Supadata's `mode=native`. It does not request AI-generated transcripts or perform local audio transcription when native captions are unavailable.

## Transcript costs

**Most videos cost nothing.** The transcript is read out of the YouTube page you already have open, using the caption track the page itself carries. No API key is involved, no credit is spent, and the subtitle text does not leave your browser.

**Supadata is the fallback.** It is used when the page cannot be read: YouTube changed how the player exposes its captions, the tab is gone, or the video has no caption track at all.

Current as of October 20, 2026, the [Supadata pricing page](https://supadata.ai/pricing) lists a free tier with **100 credits per month**, no credit card required. Unused credits do not roll over. Supadata pricing can change, so check the current page before relying on these numbers.

The [Supadata transcript documentation](https://docs.supadata.ai/get-transcript) describes the transcript request modes and credit behavior:

- A native transcript request uses **1 credit**, regardless of video duration.
- A generated transcript costs **2 credits per video minute**. YouTube Digest does not use this path because it forces `mode=native`.
- An unavailable native lookup returned as HTTP `206` still uses **1 credit**. YouTube Digest shows this as "No native subtitle track is available for this video.", but the credit is already spent.

With the current native-only behavior, the free tier can cover roughly 100 fallback lookups per month when each request succeeds once. Retries and unavailable-caption lookups also consume credits, so actual successful-video coverage can be lower.

DeepSeek usage is separate from Supadata. YouTube Digest does not collect payments or resell access. Set spending limits and monitor both accounts.

## DeepSeek V4 Flash pricing

As of October 20, 2026, DeepSeek lists these USD prices per 1 million tokens on its official [pricing page](https://api-docs.deepseek.com/quick_start/pricing/):

| Token type | Off-peak | Peak |
| --- | ---: | ---: |
| Cache-hit input | $0.003 | $0.006 |
| Cache-miss input | $0.15 | $0.30 |
| Output | $0.60 | $1.20 |

Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday, excluding Chinese public holidays. All other hours use off-peak rates, including weekends and Chinese public holidays.

The extension sends the model name `deepseek-v4-flash`. DeepSeek's page notes that this older name is still accepted, that the model behind it has been retired, and that its requests are served by the newer Flash model and billed at the Flash prices shown above.

A measured 20-minute English talk used about **32,600 input tokens** and an estimated **3,500 to 4,500 output tokens** across 43 small translation batches. At current prices, translating the full video costs approximately:

- **Off-peak: $0.002 to $0.008 USD**.
- **Peak: $0.004 to $0.015 USD**.

The lower end assumes most repeated input hits DeepSeek's cache. The upper end assumes cache misses. Translation is lazy and cached, so translating only part of a video costs less. Check the official page before relying on these prices.

## Remix it with your coding agent

This is a personal remix of the upstream project at [github.com/zarazhangrui/youtube-digest](https://github.com/zarazhangrui/youtube-digest), which does not include the GitHub sync or the web dashboard. Upstream issues and pull requests are not accepted. If something breaks or you want a new feature, download or fork your own copy and ask your coding agent to fix, remix, or personalize it for you.

YouTube Digest uses plain HTML, CSS, and JavaScript with no build step, so it is a friendly starting point for agent-assisted projects. Ideas to try:

- Add more translation languages and let each person choose a learning language.
- Create customized summary templates for lectures, interviews, tutorials, reviews, or research talks.
- Let the words notebook export to Markdown, CSV, Anki, or another study tool.
- Add personal topic filters that highlight the chapters most relevant to a goal.
- Add optional local-model support for a different privacy and cost tradeoff.
- Improve accessibility with keyboard navigation, font controls, and higher-contrast themes.

Ask your agent to preserve the bring-your-own-key model, keep secrets out of source files, run the checks below, and test the remix on real videos.

If you want another AI provider or model, first open the exact YouTube Digest project folder that Chrome loaded through **Load unpacked** in your coding agent. Then open YouTube Digest Settings and use **Copy customization prompt**. Replace the `[PROVIDER]` and `[MODEL]` placeholders before sending it. Do not include any API key in the prompt or chat. After the agent updates your local copy, enter the key yourself in the Settings field it identifies.

## Privacy and data flow

YouTube Digest makes provider requests directly from the extension:

1. It reads the transcript out of the YouTube page you already have open. Nothing leaves your browser on this path.
2. Only when that read fails, it sends a canonical YouTube watch URL to Supadata to request the native transcript.
3. It sends the transcript and relevant video metadata to your chosen AI provider when you request AI features.
4. Focused features send only the content they need, such as selected text with context or small transcript batches for translation.
5. It stores keys, settings, notes, and recent cache entries locally in Chrome.

The one exception is the optional GitHub sync described above. If you sign in, your saved notes are also mirrored to this project's own sync service at `https://ytd.panbo.space`, which runs on Cloudflare Workers with a Neon PostgreSQL database. Sign-in uses GitHub's OAuth flow, and the service only ever serves the rows belonging to the account you signed in with. If you never sign in, no note data leaves your device.

There is no YouTube Digest account system, advertising, analytics, or telemetry. Supadata and your chosen AI provider still receive data under their own terms and privacy policies. [PRIVACY.md](PRIVACY.md) is the authoritative description of every data flow, including the sync service. A convenience translation is available in [PRIVACY.zh-CN.md](PRIVACY.zh-CN.md).

## Troubleshooting

### The Digest button is missing on a YouTube video

- At `chrome://extensions`, find YouTube Digest and click **Reload**, then refresh the YouTube tab.
- Confirm that you are on a standard `https://www.youtube.com/watch?...` page, not a Short, embed, or live page.
- The button is labeled **Digest** and sits next to YouTube's Share and Save buttons. The current version automatically follows YouTube when its responsive action bar changes, so wait a moment after the page finishes loading.
- If you have an older downloaded copy, resizing the YouTube window horizontally once may reveal the button. Then download the latest version so resizing is no longer required.
- If it is still missing, ask your coding agent to inspect the content script on that exact video page.

### The side panel does not open

- Confirm that you are on a `https://www.youtube.com/...` page. The panel is enabled on YouTube tabs only, and the current version closes it automatically when you switch to another site.
- At `chrome://extensions`, confirm YouTube Digest is enabled and click **Reload**.
- Refresh the YouTube tab after reloading the extension.
- The panel opens with a **Settings** button in its header. Clicking the extension icon on a YouTube tab also opens the panel.
- Ask your coding agent to inspect the extension if the problem continues.

### YouTube Digest asks for setup

- The panel shows the title **API Keys Missing** and a button labeled **Open Settings** when a key is missing. Click that button, or open **Settings** from the panel header, from the YouTube Digest card at `chrome://extensions`, or by right-clicking the toolbar icon.
- Save the API key of your chosen AI provider. The Supadata key is optional. The extension also opens Settings by itself the first time it is installed.
- Choose one of the supported providers: DeepSeek V4 Flash, MiniMax M3, or OpenCode Go. Endpoints and models are fixed, so there are no Base URL or Model fields to configure.
- If Settings says a legacy custom provider was removed, enter the API key of your chosen provider. The old AI key was cleared so it could not be reused with the wrong service.

### No transcript is found

- Confirm the video is public and has native captions.
- Make sure the YouTube tab is still open and playing: the transcript is read out of that page. If the page cannot be read, YouTube Digest falls back to Supadata, and then it needs a Supadata key.
- Check your Supadata key, remaining credits, rate limit, and account status.
- Remember that unavailable native lookups and manual retries may still consume credits.

YouTube Digest will not fall back to generated transcription.

### AI requests fail

- A `401` or `403` usually means the selected provider's key or account access is invalid.
- A `429` usually means the selected provider reached a rate or spending limit. OpenCode Go subscription plans also have usage limits.
- Confirm the key was created in the account linked to the provider selected in Settings, and that the account has available credit.
- If you adapted a local copy for another model, use the Settings customization prompt again and ask your coding agent to inspect that local implementation.

### The sync chip says "Sync expired"

- Your notes are still saved on this device, but the cloud backup stopped because the GitHub session ended.
- Click the chip and sign in with GitHub again to resume syncing.

Never share API keys, private transcripts, or personal notes in chats, screenshots, or logs.

## Checks for coding agents

Ask your coding agent to run these commands after changing the project:

```bash
npm test
npm run check
npm run package
```

`npm run check` validates the public release file list and scans for credentials; `npm run package` builds the release ZIP. If the change touches the sync backend, also run the server's own suite:

```bash
cd server && npm test
```

These are the same commands the CI workflow runs. The agent should also reload the unpacked extension in Chrome and test several real YouTube videos. Automated checks do not prove that live provider requests and YouTube interactions work.

## License

MIT. See [LICENSE](LICENSE).

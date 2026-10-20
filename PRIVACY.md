# Privacy

Effective: October 20, 2026

> A convenience translation is available in [PRIVACY.zh-CN.md](PRIVACY.zh-CN.md). The English file below is the authoritative version.

YouTube Digest is a GitHub-only, bring-your-own-key Chrome extension. It has no YouTube Digest account, analytics, advertising, or telemetry. It does run an optional sync service, described in "GitHub sync (optional)" below, that stores your saved notes, vocabulary, and review progress when you choose to sign in.

Two kinds of data leave your device, and it is worth naming them up front. The transcript is read out of the YouTube page you already have open, so most of the time no subtitle data leaves your device at all; when that read does not work and a Supadata key is set, the canonical video URL goes to Supadata to fetch the transcript. The transcript text you ask to be translated, explained, summarized, or polished goes to the AI provider you selected in Settings. Both requests carry your own API key and go straight from your browser to those services. YouTube Digest's developer does not proxy, receive, or store them.

## Data the extension handles

Depending on the feature you use, YouTube Digest handles:

- the canonical URL and video ID of the active YouTube video;
- transcript text and timestamps;
- video metadata such as title, channel, description, and duration;
- text you select in the transcript and nearby transcript context;
- transcript context around a timestamped note;
- content you ask to translate;
- notes you save;
- vocabulary entries you capture, and the review schedule attached to them;
- Supadata and AI provider configuration, including API keys; and
- cached transcript, digest, and translation results.

The Supadata key is optional. It is only needed for the fallback path, and the panel tells you when a video needs it.

## Where data goes

### GitHub sync (optional)

If you sign in with GitHub, your saved notes, vocabulary, and review progress
are mirrored to the YouTube Digest sync
service at `https://ytd.panbo.space` (a Cloudflare
Worker backed by a Neon PostgreSQL database). Sign-in uses the GitHub OAuth web
flow: GitHub sends the OAuth code only to that Worker, which exchanges it with
GitHub using the client secret and then issues a short-lived token the extension
stores locally. That token is valid for 30 days and there is no refresh token,
so an expired session asks you to sign in again. The service refuses every
token it issued for an account that no longer exists.

The service stores the following per account:

- **Account**: your GitHub numeric id, login name, and avatar URL.
- **Notes**: the video id, video title, channel name, timestamp, the quote or
  note text you saved, and whether you marked it as a favorite.
- **Vocabulary**: the term, its translation, the sentence it was captured from and
  that sentence's translation, the video and the moment it came from, and its
  learning status.
- **Review progress**: when each vocabulary item is next due, its repetition
  count, its current interval, and a difficulty score.

- Notes are stored under your GitHub account id and only your account's rows are
  ever served: the server scopes every query by the verified token, and the
  extension keeps separate local namespaces per account.
- Signing out keeps the token local until you remove it; your data remains on the
  server under your account until deleted from the extension or with the account.
- This sync service is optional and separate from AI and transcript processing:
  when you are not signed in, no note data leaves the device at all.

The service also publishes a short privacy page of its own at
`https://ytd.panbo.space/privacy` (Simplified Chinese:
`https://ytd.panbo.space/privacy?lang=zh-CN`). It describes the sync
service only. This file is the complete description for the extension.

### Deleting your account

"Delete my account" is a deletion, not a sign-out. The Options page of the
extension and the dashboard at `https://ytd.panbo.space` both offer it, and
both ask for confirmation twice. Deleting the account does all of the following:

- it removes every note, vocabulary entry, and review item stored for your
  account from the Neon database;
- it removes the account row itself, so the GitHub identity the account was
  created from is no longer registered with the service;
- it revokes every session token the account issued, so a token still saved on
  an old device stops working; and
- in the extension, it removes the notes and words stored under that account on
  this device and ends the local session. Notes and words belonging to a
  different account on the same device are left alone, and your API keys and
  settings are not touched.

The deletion is permanent. There is no restore and the extension cannot undo it.

What it does not do is reach outside this service. Data that Supadata or your AI
provider already processed stays on their servers, and their own controls apply
to it.

### The network in between

The sync service runs on Cloudflare Workers, so every request to it is handled by
Cloudflare's network before it reaches the code in this repository. Cloudflare
processes the request's IP address and user agent for routing, abuse prevention
and bot management, and may serve a challenge page instead of the application.
That is Cloudflare's own processing under its terms and privacy policy, not
YouTube Digest's.

The dashboard at `https://ytd.panbo.space` is served from the same
service. It loads only its own scripts and styles, sends no analytics or
telemetry, and sets a Content-Security-Policy that blocks third-party scripts.

### YouTube's own caption tracks

The transcript is read out of the YouTube page that is already open in your tab.
The page's own player requests the video's caption track with a signed URL,
and the extension fetches that same YouTube URL directly from your browser.
**No subtitle text is sent to YouTube Digest's developer or to any third party
on this path, and no Supadata credit is spent.**

This is the default path. It is tried first on every video.

### Supadata (fallback)

When the page cannot be read — YouTube changed how the player exposes its
captions, the tab is gone, or the video has no caption track at all — the
extension falls back to Supadata, and only then does the canonical YouTube
video URL leave your device.

YouTube Digest sends the canonical YouTube video URL to `https://api.supadata.ai` with your Supadata API key. Supadata returns the transcript and timestamps. **A Supadata key is optional**: without one, videos whose captions can be read locally still work, and the panel tells you plainly when a video needs the fallback and a key is not set. The request asks for native caption tracks only: no audio, no video, and no other file from the watch page is uploaded.

A video with no caption track is remembered as having none, so reopening it does not spend a credit on the same answer again.

### AI providers

The published version supports three fixed AI providers. Only the provider selected in Settings receives AI feature content, and the request is authenticated with the key you entered for that provider, so the content is processed under your own account with that provider:

- **DeepSeek** at `https://api.deepseek.com` with the `deepseek-v4-flash` model.
- **MiniMax** (China) at `https://api.minimaxi.com/v1` with the `MiniMax-M3` model.
- **OpenCode Go** at `https://opencode.ai/zen/go/v1` with the `deepseek-v4-flash` model.

Each provider receives:

- transcript plus relevant title, channel, description, or duration for an overview;
- selected text plus nearby transcript context for an explanation;
- small semantic transcript batches currently needed for progressive Chinese
  translation, or requested overview or explanation content;
- nearby transcript context and video metadata when polishing a saved note.

OpenCode Go routes and caches on a session id, so a request to that provider also
carries one: a random value your browser generates once and keeps. It says
nothing about you, it is never sent to any other service, and no one else using
the extension has it.

Endpoints and models are fixed in the published Settings page. Keys for all three providers can be saved side by side, and only the selected provider is used. To use a provider or model outside this list, you must adapt your own local source copy and its permissions. The Settings page provides a coding-agent prompt for that purpose and warns you never to include an API key in the prompt or chat.

Requests go directly from the extension to Supadata or the selected AI provider. They are authenticated with the keys you supply. YouTube Digest's developer does not proxy or receive these requests. The local caption path described above involves no third party at all.

Those services process data under their own terms, privacy policies, retention practices, and account settings. Do not send confidential, personal, or regulated content unless their terms and your obligations permit it.

## Local storage and retention

YouTube Digest uses Chrome's local extension storage for its own data. The only
data that also leaves the device is the notes, vocabulary, and review progress
you choose to sync, as described under "GitHub sync (optional)" above.

- Supadata and AI provider settings and API keys remain on the device in Chrome's extension storage. They are never sent to the sync service.
- Keys for all supported AI providers are kept side by side so you can switch
  providers without re-entering keys. Only the selected provider ever receives
  requests; keys for providers you have not selected stay on the device until
  you clear those fields in Settings or reset extension data.
- Saved notes remain until you delete them or remove/clear the extension's data. The extension keeps the 100 most recent notes on the device; older local notes are dropped to keep storage bounded, and the synced copy is unaffected. When you are signed in, your notes are also stored on the sync service until you delete them there or delete your account.
- Saved words follow the same rule. The extension keeps the 500 most recent words on the device, older local words are dropped to keep storage bounded, and the panel tells you when that happened. The synced copy is unaffected.
- Recent transcript, digest, and per-segment translation cache entries are stored
  locally and are never synced. The cache is limited to 20 videos, and entries older than 30 days are
  removed when the side panel opens.

Chrome extension storage is not a password vault. Anyone with sufficient access to your browser profile or device may be able to recover locally stored keys or content. Use scoped keys where providers support them, set spending limits, and rotate or revoke a key if the device or browser profile is compromised.

To remove data:

- delete individual saved notes in YouTube Digest;
- use the Options page to clear cached digests, delete all notes, or reset all extension data. "Delete all notes" removes the saved notes of every account on this device; it does not remove saved words or API keys. "Reset extension data" clears the extension's entire local storage, which includes the keys, the notes, the words, the session, and the cached results;
- export your data first if you want a copy of it: the dashboard's "Export my data" button downloads everything the service holds for your account as a JSON file;
- use "Delete my account" in the Options page, or in the dashboard at `https://ytd.panbo.space`, to remove the account and all of its data from the sync service, as described under "Deleting your account" above;
- remove the extension or clear its stored data from Chrome to delete all local settings, keys, notes, and cache entries; and
- revoke keys in the Supadata or selected AI provider's dashboard to stop their future use.

Clearing local data does not delete information already processed or retained by Supadata or your AI provider. Use each service's controls for service-side requests.

## Permissions

YouTube Digest uses Chrome permissions for these purposes:

- `sidePanel`: display the YouTube Digest interface beside YouTube.
- `storage`: store settings, keys, notes, and cached results locally.
- `unlimitedStorage`: raise the local storage limit from Chrome's default 10 MB
  to unlimited, so the cached transcripts, translations, and summaries of long
  videos fit on the device. It sends nothing anywhere: everything stored under
  it stays in your Chrome profile.
- `tabs`: identify and interact with the active YouTube tab.
- `scripting`: coordinate the extension's YouTube page controls, and read the page's own caption tracks so the transcript can be fetched without a third party.
- YouTube host access: read the active video's URL and metadata, provide timestamp controls, and fetch the caption track the page already carries.
- Supadata host access: retrieve transcripts when the page's own captions cannot be read.
- DeepSeek, MiniMax, and OpenCode Go host access: provide AI overviews, explanations, translation, and note polishing through the selected provider.
- Sync service host access (`https://ytd.panbo.space`): sign in with GitHub, and sync the saved notes you choose to back up. This permission is only used for the optional sync; it is not used while you are signed out.

YouTube Digest does not use these permissions to monitor general browsing activity.

## No sale or advertising use

YouTube Digest does not sell personal information, build advertising profiles, or share data with data brokers. It does not include analytics SDKs.

## Changes

Privacy-relevant changes will be documented in this file and in the repository history. Review updates before installing a new version.

## Questions

This repository does not provide a public support or issue channel. Review this policy, the source code, and each provider's documentation before using the extension. For a vulnerability or accidental secret exposure, follow the private process in [SECURITY.md](SECURITY.md).

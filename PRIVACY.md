# Privacy

Effective: July 28, 2026

YouTube Digest is a GitHub-only, bring-your-own-key Chrome extension. It has no YouTube Digest account, developer-operated backend, analytics, advertising, or telemetry.

## Data the extension handles

Depending on the feature you use, YouTube Digest handles:

- the canonical URL and video ID of the active YouTube video;
- transcript text and timestamps;
- video metadata such as title, channel, description, and duration;
- text you select in the transcript and nearby transcript context;
- transcript context around a timestamped note;
- content you ask to translate;
- notes you save;
- Supadata and AI provider configuration, including API keys; and
- cached transcript, digest, and translation results.

## Where data goes

### GitHub sync (optional)

If you sign in with GitHub, your saved notes are mirrored to the YouTube Digest sync
service at `https://ytd.panbo.space` (a Cloudflare
Worker backed by a Neon PostgreSQL database). Sign-in uses the GitHub OAuth web
flow: GitHub sends the OAuth code only to that Worker, which exchanges it with
GitHub using the client secret and then issues a short-lived token the extension
stores locally.

- Notes are stored under your GitHub account id and only your account's rows are
  ever served: the server scopes every query by the verified token, and the
  extension keeps separate local namespaces per account.
- Signing out keeps the token local until you remove it; notes remain on the
  server under your account until deleted from the extension or with the account.
- This sync service is optional and separate from AI and transcript processing:
  when you are not signed in, no note data leaves the device at all.

### Supadata

YouTube Digest sends the canonical YouTube video URL to `https://api.supadata.ai` with your Supadata API key. Supadata returns the transcript and timestamps. A Supadata key is required for transcript retrieval.

### AI providers

The published version supports three fixed AI providers. Only the provider selected in Settings receives AI feature content:

- **DeepSeek** at `https://api.deepseek.com` with the `deepseek-v4-flash` model.
- **MiniMax** (China) at `https://api.minimaxi.com/v1` with the `MiniMax-M3` model.
- **OpenCode Go** at `https://opencode.ai/zen/go/v1` with the `deepseek-v4-flash` model.

Each provider receives:

- transcript plus relevant title, channel, description, or duration for an overview;
- selected text plus nearby transcript context for an explanation;
- small semantic transcript batches currently needed for progressive Chinese
  translation, or requested overview or explanation content;
- nearby transcript context and video metadata when polishing a saved note.

Endpoints and models are fixed in the published Settings page. Keys for all three providers can be saved side by side, and only the selected provider is used. To use a provider or model outside this list, you must adapt your own local source copy and its permissions. The Settings page provides a coding-agent prompt for that purpose and warns you never to include an API key in the prompt or chat.

Requests go directly from the extension to Supadata or the selected AI provider. They are authenticated with the keys you supply. YouTube Digest's developer does not proxy or receive these requests.

Those services process data under their own terms, privacy policies, retention practices, and account settings. Do not send confidential, personal, or regulated content unless their terms and your obligations permit it.

## Local storage and retention

YouTube Digest uses Chrome's local extension storage, not a YouTube Digest cloud service.

- Supadata and AI provider settings and API keys remain on the device in Chrome's extension storage.
- Keys for all supported AI providers are kept side by side so you can switch
  providers without re-entering keys. Only the selected provider ever receives
  requests; keys for providers you have not selected stay on the device until
  you clear those fields in Settings or reset extension data.
- Saved notes remain until you delete them or remove/clear the extension's data. The extension keeps up to 100 notes.
- Recent transcript, digest, and per-segment translation cache entries are stored
  locally. The cache is limited to 20 videos, and entries older than 30 days are
  removed when the side panel opens.

Chrome extension storage is not a password vault. Anyone with sufficient access to your browser profile or device may be able to recover locally stored keys or content. Use scoped keys where providers support them, set spending limits, and rotate or revoke a key if the device or browser profile is compromised.

To remove data:

- delete individual saved notes in YouTube Digest;
- use the Options page to clear cached digests, delete all notes, or reset all extension data;
- remove the extension or clear its stored data from Chrome to delete all local settings, keys, notes, and cache entries; and
- revoke keys in the Supadata or selected AI provider's dashboard to stop their future use.

Clearing local data does not delete information already processed or retained by Supadata or your AI provider. Use each service's controls for service-side requests.

## Permissions

YouTube Digest uses Chrome permissions for these purposes:

- `sidePanel`: display the YouTube Digest interface beside YouTube.
- `storage`: store settings, keys, notes, and cached results locally.
- `tabs`: identify and interact with the active YouTube tab.
- `scripting`: coordinate the extension's YouTube page controls.
- YouTube host access: read the active video's URL and metadata and provide timestamp controls.
- Supadata host access: retrieve transcripts.
- DeepSeek, MiniMax, and OpenCode Go host access: provide AI overviews, explanations, translation, and note polishing through the selected provider.

YouTube Digest does not use these permissions to monitor general browsing activity.

## No sale or advertising use

YouTube Digest does not sell personal information, build advertising profiles, or share data with data brokers. It does not include analytics SDKs.

## Changes

Privacy-relevant changes will be documented in this file and in the repository history. Review updates before installing a new version.

## Questions

This repository does not provide a public support or issue channel. Review this policy, the source code, and each provider's documentation before using the extension. For a vulnerability or accidental secret exposure, follow the private process in [SECURITY.md](SECURITY.md).

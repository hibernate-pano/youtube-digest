# Security Policy

## Supported versions

YouTube Digest is a small GitHub-only project. Security fixes are made on the latest code on `main` and, when releases are published, the latest GitHub release. Older snapshots are not supported.

## Report a vulnerability privately

Do not publish vulnerability details, exposed credentials, private video information, or transcript data through a public issue or pull request. This repository does not accept public security reports.

Use GitHub's private vulnerability reporting flow from this repository's **Security** tab when it is available. If the private reporting link is not visible, contact the repository owner through their GitHub profile and ask for a private reporting channel without including vulnerability details in the public message. Include the following only in the private report:

- the affected version or commit;
- the minimum steps needed to reproduce the problem;
- the expected and observed behavior;
- the security and privacy impact; and
- a suggested fix, if you have one.

Remove real API keys, access tokens, private URLs, transcripts, notes, and personal information. Use redacted values and public test content.

There is no guaranteed response time or bug-bounty program. Please allow a reasonable period for investigation and remediation before public disclosure.

## High-priority issues

Examples include:

- API keys or private content included in source, logs, screenshots, or release ZIPs;
- requests to network origins outside the documented YouTube, Supadata, and AI provider hosts;
- script or HTML injection through transcript, metadata, service errors, or model output;
- access to browsing data outside the documented YouTube scope;
- unintended transmission of notes, transcripts, or credentials;
- a dependency or release-workflow compromise; and
- bypasses of local data deletion or AI provider configuration controls.

## User security guidance

- Install only from a GitHub source or release you trust.
- Review changes and the packaged file list before loading an update.
- Use dedicated, scoped API keys where possible and set provider spending limits.
- Do not reuse keys from production systems.
- Revoke keys immediately if a device, browser profile, ZIP, log, or screenshot exposes them.
- Remember that Chrome local extension storage is not an encrypted password vault.

The release tooling scans every file in the repository for common credential patterns, but automated checks cannot detect every secret.

Know where that scan is blind, so you do not rely on it:

- It reads every file the repository tracks, whatever the extension, and every new file that is not ignored. A file that has never been in the repository is not read, and a file whose bytes are not text (a picture, a ZIP, a PDF) is not read either.
- It reports a value only when the value is at least 16 characters long and has no spaces in it. A short key, a passphrase with spaces in it, and a sentence are not reported.
- An assignment is reported when its name says it holds a secret (`API_KEY`, `JWT_SECRET`, `DATABASE_URL`, `TOKEN`, and the like), whether the value is quoted or not. A secret stored under a name that does not say what it is, in a shape the patterns do not know, is not reported.
- A value that looks like an example (`YOUR_KEY_HERE`, `changeme`, `{{DATABASE_URL}}`, or a pattern written out twice, such as `0123456789abcdef0123456789abcdef`) is skipped on purpose, so that an example file does not block a release.

The scan is a net, not a guarantee. Read the diff before you publish, and revoke a key the moment it shows up in a commit, a log, a screenshot, or a chat.

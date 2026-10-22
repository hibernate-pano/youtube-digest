# YouTube Digest Sync Server Setup

This Cloudflare Worker provides optional GitHub-account sync for YouTube
Digest: notes, vocabulary, and review progress. Each GitHub account's data
is isolated server-side; the extension only stores the bearer token the
server issues after login.

## Architecture

```text
Chrome extension (options page)                          Cloudflare Worker
  |  opens /api/auth/login  (new tab)  ----------------> 302 to github.com
  |                                                      user authorizes
  |  <---------- 302 /auth/complete#access_token=... <-- code exchange + JWT
  |                                                      upsert users table
  |  GET /api/me, /api/notes, ... with Bearer token  ->  scoped by user id
  |                                                     Neon (PostgreSQL)
```

- The Worker holds the GitHub OAuth client secret. The extension never sees
  it.
- All data routes require `Authorization: Bearer <jwt>`; the user id always
  comes from the verified token, never from request bodies.
- The JWT is an HS256 token signed with `JWT_SECRET`, valid 30 days.
- A sign-in can be bound to the browser that started it: a client that sends
  `?device=<random id>` to `/api/auth/login` gets a token that carries that
  id, and every later request has to send it back in `X-Device-Id`. The
  dashboard does this; a token copied out of the browser it was issued to is
  then refused. A client that does not name a device gets an unbound token,
  which is why the extension itself is not bound yet.

## 1. Register a GitHub OAuth App

1. Open https://github.com/settings/developers and choose **New OAuth App**.
2. Application name: `YouTube Digest`.
3. Homepage URL: any reachable URL (your repo or the Worker URL).
4. Authorization callback URL:
   - Production: `https://ytd-api.panbo.workers.dev/api/auth/callback`
     (or whatever subdomain you deploy to).
   - Local dev: temporarily `http://localhost:8787/api/auth/callback`.
   GitHub allows only one callback URL at a time, so switch it between dev
   and production.
5. Copy the **Client ID** and generate a **Client secret**.

## 2. Create the Neon database

1. Create a project at https://neon.tech (free tier is fine).
2. Copy the pooled connection string from the dashboard.
3. Put it in the repo root `.env` as `NEON_URL=...` (already gitignored).
   Important: Neon URLs contain `&` (e.g. `?sslmode=require&channel_binding=require`).
   In a shell, `&` is a command separator, so a bare `source .env` would not
   set the variable. Either quote the value in `.env`
   (`NEON_URL="postgresql://...&channel_binding=require"`) or export it with:
   `export NEON_URL=$(grep '^NEON_URL=' .env | cut -d= -f2- | tr -d '"')`.
4. Apply the schema (from this directory):

```bash
cd server
npm install
export NEON_URL=$(grep '^NEON_URL=' ../.env | cut -d= -f2- | tr -d '"')
npm run db:migrate
```

## 3. Configure and run locally

```bash
cd server
cp .dev.vars.example .dev.vars   # fill in Client ID/secret, JWT_SECRET, DATABASE_URL
npm install
npm run dev                      # http://localhost:8787
```

Then in the extension source set `SERVER_BASE_URL` in `settings.js` to
`http://localhost:8787` **and add the local backend to the extension's host
permissions** in `manifest.json`:

```json
"host_permissions": [
  ...
  "http://localhost:8787/*"
]
```

and reload the unpacked extension.

> The released manifest does **not** ship the `http://localhost:8787/*` host
> permission. A published extension that can reach a port on the user's own
> machine is a liability: any process listening there could be handed the
> user's notes and their GitHub session token. Add the line back only while
> you are developing against a local backend, and take it out again before
> you package a release.

Without `DATABASE_URL` the Worker refuses to serve (`503`, "the database is
not configured") instead of falling back to a store that lives in one
instance of the Worker - a store like that makes every account look empty and
loses every note at the next deploy. To run the OAuth flow locally without a
database, ask for the in-memory store by name:

```bash
# .dev.vars
ALLOW_MEMORY_STORE=1
```

Restarts lose data; never set it in production.

## 4. Deploy

Secrets first, deploy second. A Worker deployed without its secrets answers
every request with a 500, including the sign-in route, so a deploy that runs
before the secrets land is a deploy that does not work.

```bash
cd server
npm install
npx wrangler login
# The three secrets, before the code that needs them.
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put JWT_SECRET
npx wrangler secret put DATABASE_URL
# Then the Worker itself.
npx wrangler deploy
```

`wrangler.toml` deliberately has no `[vars]` block: the OAuth client id is a
secret, not a build-time constant, and it is set by the `wrangler secret put
GITHUB_CLIENT_ID` above. Everything the Worker reads from `env` comes from
those four secrets (or from `.dev.vars` locally).

Point the GitHub OAuth App callback URL at the deployed Worker, and set
`SERVER_BASE_URL` in `settings.js` to the deployed origin. Rebuild the
extension (`npm run package`) and reload it in Chrome.

## User dashboard

The same Worker also serves a personal dashboard at
`https://ytd.panbo.space/` (static assets
from `server/dashboard/` via the Workers Assets binding, same origin as the
API). Any extension user can sign in with GitHub there and see their own
notes, favorites (starred notes), and vocabulary. Login uses
`/api/auth/login?redirect=/` so the OAuth callback returns to the dashboard
with the token in the URL fragment.

## What Cloudflare's edge adds to the response

The dashboard is served through Cloudflare, so the HTML that reaches the
browser is not byte-for-byte the file in `server/dashboard/`. The edge injects
its bot-detection script and, if zone Web Analytics is on, its beacon. The
dashboard's Content-Security-Policy blocks both, which is deliberate: the
browser console shows a CSP violation for the injected script and the page
keeps working.

The zone-level settings are deliberately **not** changed for this:

- `panbo.space` also serves other sites (blog, coach, dashboard,
  redbook, and so on). Turning off JavaScript Detections or Web Analytics on the
  zone would change all of them.
- If a hostname-scoped Configuration Rule is ever wanted instead, it is a
  Cloudflare dashboard task: rule on `http.host eq "ytd.panbo.space"`,
  settings `javascript_detections = off` and `web_analytics = off`.

The privacy policy discloses the edge processing: Cloudflare sees the IP
address and user agent of every request to the sync service.

## API summary

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/auth/login | start GitHub OAuth (no auth) |
| GET | /api/auth/callback | exchange code for a JWT (no auth) |
| GET | /auth/complete | landing page shown after login (no auth) |
| GET | /api/me | current user |
| GET | /api/sync?since=ISO | notes/vocabulary changed since a timestamp, plus the deletions (`deleted.notes`, `deleted.vocabulary`). Each of the four lists is capped; `truncated` says which one was, and a capped list means the client must reconcile rather than assume it has seen everything |
| POST | /api/sync | push a batch of notes and words in one request (at most 200 items; see below) |
| GET/POST | /api/notes | list / create notes (idempotent by clientId). The list is capped at 5 000 rows and reports `total` and `truncated` |
| DELETE | /api/notes | delete every note in the account (tombstones, so no device can push them back) |
| PATCH/DELETE | /api/notes/:id | update / delete a note |
| PATCH | /api/notes/:id/star | set starred (favorite) flag |
| DELETE | /api/notes/client/:clientId | delete by client id |
| GET/POST | /api/vocabulary | list / upsert vocabulary (deduped by term+sentence; a re-capture keeps the translation, the explanation and the learning state) |
| PATCH/DELETE | /api/vocabulary/:id | update status / delete entry |
| GET | /api/reviews/due | due review items with their vocabulary |
| POST | /api/reviews/:vocabId | submit a review grade (0-5, SM-2 schedule) |
| GET | /api/export | the whole account as one JSON file; `?type=notes` or `?type=vocabulary` fetches one half, for an account too big for one file |
| DELETE | /api/account | delete the account and everything in it |

### POST /api/sync: pushing a batch

A new device that holds a hundred notes and five hundred words used to push
them one request at a time. The write limiter allows 120 writes a minute, so
the first sync of a new device spent five minutes being refused. `POST
/api/sync` carries the same rows in one request, and the limiter counts the
request, not the rows.

```json
{
  "notes": [{ "clientId": "device-note-1", "note": "...", "videoId": "...",
              "updatedAt": "2026-10-22T10:00:00.000Z" }],
  "vocabulary": [{ "term": "serendipity", "sentence": "...",
                   "updatedAt": 1761136800000 }]
}
```

Every item takes the fields of `POST /api/notes` or `POST /api/vocabulary`.
The answer names what the server holds for every item, in the order it was
sent, plus the server's own clock:

```json
{
  "pushed": {
    "notes": [{ "clientId": "device-note-1", "id": "...", "updatedAt": "..." }],
    "vocabulary": [{ "term": "serendipity", "sentence": "...", "id": "...", "updatedAt": "..." }]
  },
  "serverTime": "2026-10-22T10:00:02.000Z"
}
```

The rules are the rules of the single routes:

- a note is matched by `clientId`, a word by `(term, sentence)`;
- the later edit wins: an item whose `updatedAt` is not after the stored row
  is dropped and the stored row is reported back. Send `updatedAt` on the
  same timeline the server keeps (the extension already measures the clock
  offset against `serverTime`); omit it and the push always wins;
- a deleted note is not written again (a tombstone is never resurrected). A
  deleted word is a different case, on purpose: capturing it again brings it
  back with the review schedule it had, the way `POST /api/vocabulary` does;
- the account cap (20 000 notes and words) is checked against the whole
  batch in one transaction: a batch that does not fit writes nothing and
  answers 409 with `limit`;
- an item that carries another account's row `id` is refused with 400
  `notes[i]: this id belongs to another account.`;
- one invalid item is a 400 naming its index, and nothing of the batch is
  written;
- more than 200 items is a 400 with a message that says how many to send.
  The client chunks its queue at that number.

## Security notes

- Data isolation: every query is scoped by the authenticated `user_id`; a
  token for account A returns 404 for account B's rows.
- Inputs are validated server-side (length caps, status enums, grade range).
- The OAuth state cookie is HttpOnly and SameSite=Lax, cleared after use.
- A deleted note stays in the database as a tombstone for 30 days
  (`TOMBSTONE_RETENTION_DAYS`), so a device that still holds the note cannot
  push it back. A deleted word keeps its row (and its review schedule) too; a
  word that is captured again deliberately comes back. The scheduled run
  drops the tombstones that are older.
- Each account is capped at 20 000 notes and words. The export holds the whole
  account and refuses at 32 MB with a message instead of a download that dies;
  an account near the byte cap can be exported in two halves with
  `?type=notes` and `?type=vocabulary`.
- Tokens appear in the URL fragment after login; the extension extracts and
  stores them in `chrome.storage.local` and closes the tab.

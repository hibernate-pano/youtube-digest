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
3. Apply the schema (from this directory):

```bash
cd server
npm install
DATABASE_URL='postgres://...' npm run db:migrate
```

## 3. Configure and run locally

```bash
cd server
cp .dev.vars.example .dev.vars   # fill in Client ID/secret, JWT_SECRET, DATABASE_URL
npm install
npm run dev                      # http://localhost:8787
```

Then in the extension source set `SERVER_BASE_URL` in `settings.js` to
`http://localhost:8787` and reload the unpacked extension.

Without `DATABASE_URL` the server runs an in-memory store (restarts lose
data) so you can exercise the OAuth flow without a database.

## 4. Deploy

```bash
cd server
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put JWT_SECRET
npx wrangler secret put DATABASE_URL
```

Set `GITHUB_CLIENT_ID` in `wrangler.toml` [vars], point the GitHub OAuth App
callback URL at the deployed Worker, and set `SERVER_BASE_URL` in
`settings.js` to the deployed origin. Rebuild the extension (`npm run
package`) and reload it in Chrome.

## API summary

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/auth/login | start GitHub OAuth (no auth) |
| GET | /api/auth/callback | exchange code for a JWT (no auth) |
| GET | /auth/complete | landing page shown after login (no auth) |
| GET | /api/me | current user |
| GET | /api/sync?since=ISO | notes/vocabulary changed since timestamp |
| GET/POST | /api/notes | list / create notes |
| PATCH/DELETE | /api/notes/:id | update / delete a note |
| GET/POST | /api/vocabulary | list / upsert vocabulary (deduped by term+sentence) |
| PATCH/DELETE | /api/vocabulary/:id | update status / delete entry |
| GET | /api/reviews/due | due review items with their vocabulary |
| POST | /api/reviews/:vocabId | submit a review grade (0-5, SM-2 schedule) |

## Security notes

- Data isolation: every query is scoped by the authenticated `user_id`; a
  token for account A returns 404 for account B's rows.
- Inputs are validated server-side (length caps, status enums, grade range).
- The OAuth state cookie is HttpOnly and SameSite=Lax, cleared after use.
- Tokens appear in the URL fragment after login; the extension extracts and
  stores them in `chrome.storage.local` and closes the tab.

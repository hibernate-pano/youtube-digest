/**
 * GitHub OAuth (web application flow). The Worker holds the client secret;
 * the extension never sees it. After the callback we issue our own JWT so
 * the extension only stores an opaque bearer token.
 */

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com/user";

function randomState() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function buildAuthorizeUrl({ clientId, redirectUri, state, scope }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  if (scope) params.set("scope", scope);
  return GITHUB_AUTHORIZE_URL + "?" + params.toString();
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "youtube-digest-server",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    const error = new Error("GitHub rejected the OAuth code.");
    error.status = 502;
    throw error;
  }
  return data.access_token;
}

async function fetchGithubUser(accessToken) {
  const response = await fetch(GITHUB_API_URL, {
    headers: {
      Authorization: "Bearer " + accessToken,
      Accept: "application/vnd.github+json",
      "User-Agent": "youtube-digest-server",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const data = await response.json();
  if (!response.ok || typeof data.id !== "number") {
    const error = new Error("Could not load the GitHub profile.");
    error.status = 502;
    throw error;
  }
  return {
    githubId: data.id,
    login: String(data.login || ""),
    avatarUrl: String(data.avatar_url || ""),
  };
}

function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function setCookie(name, value, options) {
  const parts = [name + "=" + encodeURIComponent(value)];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push("SameSite=" + options.sameSite);
  if (options.path) parts.push("Path=" + options.path);
  if (options.maxAgeSeconds !== undefined) {
    parts.push("Max-Age=" + options.maxAgeSeconds);
  }
  return parts.join("; ");
}

module.exports = {
  randomState,
  buildAuthorizeUrl,
  exchangeCode,
  fetchGithubUser,
  parseCookies,
  setCookie,
};

/**
 * Authentication middleware and shared error type.
 */

const jwt = require("./jwt");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** A JWT secret shorter than this is too weak to be worth signing with. */
const MIN_JWT_SECRET_LENGTH = 32;

const CONFIG_ERROR = "Server is not configured (JWT_SECRET missing or too short).";

/**
 * Throws a 500 HttpError when the Worker has no usable JWT secret. Without
 * this guard `crypto.subtle.importKey` throws a DataError on every
 * authenticated route, and the OAuth callback fails *after* the GitHub code
 * has already been exchanged.
 */
function requireJwtSecret(env) {
  const secret = env && env.JWT_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new HttpError(500, CONFIG_ERROR);
  }
  return secret;
}

function readBearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

async function requireUser(request, env) {
  // Checked first: a server without a usable secret cannot verify anything,
  // and saying "session expired" would send the user round the sign-in loop
  // instead of telling the operator the worker is misconfigured.
  requireJwtSecret(env);
  const token = readBearer(request);
  if (!token) throw new HttpError(401, "Authentication required.");
  const payload = await jwt.verifyToken(token, env.JWT_SECRET);
  if (!payload || typeof payload.sub !== "string") {
    throw new HttpError(401, "Invalid or expired session. Sign in again.");
  }
  // The user identity comes exclusively from the verified token. Client
  // request bodies and query strings can never influence which account's
  // data is accessed.
  const user = {
    id: payload.sub,
    githubId: Number(payload.githubId),
    login: String(payload.login || ""),
  };
  // Token revocation: deleting the account bumps the stored token version, so
  // every token issued before the deletion stops authenticating. A token
  // without a version was issued before revocation existed and is refused.
  const stored = await env.store.getTokenVersion(user.id);
  const presented = Number(payload.tokenVersion);
  if (stored === null || stored === undefined) {
    throw new HttpError(401, "Invalid or expired session. Sign in again.");
  }
  if (!Number.isInteger(presented) || presented !== Number(stored)) {
    throw new HttpError(401, "Invalid or expired session. Sign in again.");
  }
  return user;
}

/**
 * Header set applied to every JSON response. The API returns user-owned
 * data, so it must never be cached by a proxy or browser, must not leak the
 * referring URL to a third party, and must not be sniffed as anything but
 * JSON.
 */
const HARDENING_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8" },
      HARDENING_HEADERS,
    ),
  });
}

/**
 * The server's own clock, as an ISO timestamp.
 *
 * The rows in the database are stamped with the server's clock, but the
 * client compares them against timestamps taken from the device clock, so
 * a device with a wrong clock can end up believing its own copy is the
 * newer one. Every sync response carries this value: it is the reference
 * point the client measures its own clock against.
 */
function serverTime() {
  return new Date().toISOString();
}

/**
 * Maximum accepted request body, in bytes.
 *
 * Sized for the largest legitimate payload: a full note (20 000 characters),
 * a quote (3 000) and the rest of the metadata, where every character may be
 * a 4-byte emoji. That is about 95 KB, so the cap sits at 128 KB - a hard
 * bound, but one that never rejects a note the validator would accept.
 */
const MAX_BODY_BYTES = 128 * 1024;

/**
 * Buffered bodies, keyed by the request they came from. A WeakMap is used so
 * the buffer is collected together with the request.
 */
const bufferedBodies = new WeakMap();

/**
 * Rejects an oversized request body BEFORE it is parsed.
 *
 * A Worker buffers the whole body before `request.json()` runs, so an
 * unbounded client can make the Worker allocate an arbitrary amount of
 * memory. The declared content-length is checked first; when the header is
 * missing (chunked transfer) the body is streamed and counted instead.
 *
 * The counted bytes are kept aside so the handler can still parse them.
 */
async function assertBodySize(request, limit = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, "Request body is too large.");
  }
  const body = request.body;
  if (!body) return;
  // The body has to be consumed to count it, so it is read once and the
  // bytes are kept for the parser.
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  bufferedBodies.set(request, merged);
}

/**
 * Parses a JSON request body, distinguishing "not JSON at all" from "JSON
 * but the payload is not a usable object".
 *
 * @returns {Promise<{ok: boolean, json: boolean, value: object|null}>}
 */
async function readJsonBody(request) {
  let text;
  const buffered = bufferedBodies.get(request);
  if (buffered) {
    text = new TextDecoder().decode(buffered);
  } else {
    try {
      text = await request.text();
    } catch {
      return { ok: false, json: false, value: null };
    }
  }
  if (!text.trim()) return { ok: false, json: false, value: null };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, json: true, value: null };
    }
    return { ok: true, json: true, value };
  } catch {
    return { ok: false, json: false, value: null };
  }
}

/**
 * Reads a JSON object body, refusing anything that is not a JSON object.
 *
 * A body that is not JSON at all and a body whose fields are invalid are
 * different failures, so the caller can tell them apart.
 *
 * @returns {Promise<object>} the parsed object.
 */
async function readJsonObject(request, limit = MAX_BODY_BYTES) {
  await assertBodySize(request, limit);
  const body = await readJsonBody(request);
  if (!body.ok) {
    throw new HttpError(400, "Request body must be JSON.");
  }
  return body.value;
}

/**
 * Creates a per-key token bucket.
 *
 * The bucket is in-memory and per-isolate, which is enough to damp abuse by
 * a single account. Two details keep the map from leaking: a key whose
 * window has fully expired is deleted, and the whole map is dropped when it
 * grows past `maxKeys` so a spray of distinct keys cannot exhaust memory.
 *
 * @param {{windowMs: number, max: number, maxKeys?: number, now?: () => number}} options
 */
function createRateLimiter({ windowMs, max, maxKeys = 10_000, now = () => Date.now() }) {
  const buckets = new Map(); // key -> [timestamps]
  let lastSweep = -Infinity;

  function sweep(at) {
    const cutoff = at - windowMs;
    for (const [key, timestamps] of buckets) {
      const kept = timestamps.filter((t) => t > cutoff);
      if (kept.length === 0) buckets.delete(key);
      else buckets.set(key, kept);
    }
    if (buckets.size > maxKeys) buckets.clear();
    lastSweep = at;
  }

  /**
   * @param {string} key the bucket to charge.
   * @param {number} [at] the current time; injectable for tests.
   * @returns {boolean} false when the caller is over the limit.
   */
  function check(key, at = now()) {
    // Sweeping is O(buckets), so it runs at most once per window.
    if (at - lastSweep >= windowMs) sweep(at);
    const cutoff = at - windowMs;
    const timestamps = (buckets.get(key) || []).filter((t) => t > cutoff);
    if (timestamps.length >= max) {
      buckets.set(key, timestamps);
      return false;
    }
    timestamps.push(at);
    buckets.set(key, timestamps);
    if (buckets.size > maxKeys) buckets.clear();
    return true;
  }

  check.mapSize = () => buckets.size;
  check.sweep = sweep;
  return check;
}

module.exports = {
  HttpError,
  requireUser,
  readBearer,
  json,
  serverTime,
  assertBodySize,
  readJsonBody,
  readJsonObject,
  createRateLimiter,
  requireJwtSecret,
  HARDENING_HEADERS,
  MAX_BODY_BYTES,
  MIN_JWT_SECRET_LENGTH,
  CONFIG_ERROR,
};

/**
 * Minimal HS256 JWT built on WebCrypto. Zero dependencies so the Worker and
 * the Node test suite share one implementation.
 */

const encoder = new TextEncoder();

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacSha256(secret, data) {
  const key = await importHmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(signature);
}

/**
 * The length of an HMAC-SHA256 signature, in bytes. The length is not a
 * secret - it is the length of every signature this module produces - so it
 * may be compared before the signature itself.
 */
const SIGNATURE_LENGTH = 32;

async function importHmacKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

/**
 * @param {object} payload
 * @param {string} secret
 * @param {number} ttlSeconds
 * @returns {Promise<string>}
 */
async function signToken(payload, secret, ttlSeconds) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({}, payload, { iat: now, exp: now + ttlSeconds });
  const encodedHeader = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const encodedBody = base64UrlEncode(encoder.encode(JSON.stringify(body)));
  const signingInput = encodedHeader + "." + encodedBody;
  const signature = await hmacSha256(secret, signingInput);
  return signingInput + "." + base64UrlEncode(signature);
}

/**
 * Verifies signature, expiry, and required claims.
 * @returns {Promise<object|null>} the payload or null when invalid/expired.
 */
async function verifyToken(token, secret) {
  if (typeof token !== "string") return null;
  // A missing or empty secret makes `crypto.subtle.importKey` throw a
  // DataError, which would turn every authenticated route into a 500.
  if (typeof secret !== "string" || secret.length === 0) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const encodedHeader = parts[0];
  const encodedBody = parts[1];
  const encodedSignature = parts[2];
  // BOTH decodes are inside the try: `atob` throws InvalidCharacterError on
  // anything that is not valid base64. A malformed signature must be an
  // expired session (401), never a server error (500), otherwise the client
  // treats it as a transient blip and never asks the user to sign in again.
  let payload;
  let supplied;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedBody)));
    supplied = base64UrlDecode(encodedSignature);
  } catch {
    return null;
  }
  // The signature is checked by the platform, which compares it without
  // leaking how many bytes were right. A byte-by-byte comparison that
  // stops at the first difference is a timing side channel: it tells an
  // attacker how far a forged signature got.
  //
  // The length is checked first because it is no secret at all - every
  // signature of this algorithm has the same length - and a signature of
  // the wrong length can never be the right one.
  if (supplied.length !== SIGNATURE_LENGTH) return null;
  const key = await importHmacKey(secret, ["verify"]);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    supplied,
    encoder.encode(encodedHeader + "." + encodedBody),
  );
  if (!valid) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  return payload;
}

module.exports = { signToken, verifyToken, base64UrlEncode, base64UrlDecode };

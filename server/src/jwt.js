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
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(signature);
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
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const encodedHeader = parts[0];
  const encodedBody = parts[1];
  const encodedSignature = parts[2];
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedBody)));
  } catch {
    return null;
  }
  const expected = await hmacSha256(secret, encodedHeader + "." + encodedBody);
  const supplied = base64UrlDecode(encodedSignature);
  if (expected.length !== supplied.length) return null;
  let equal = true;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== supplied[i]) {
      equal = false;
      break;
    }
  }
  if (!equal) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  return payload;
}

module.exports = { signToken, verifyToken, base64UrlEncode, base64UrlDecode };

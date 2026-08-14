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

function readBearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

async function requireUser(request, env) {
  const token = readBearer(request);
  if (!token) throw new HttpError(401, "Authentication required.");
  const payload = await jwt.verifyToken(token, env.JWT_SECRET);
  if (!payload || typeof payload.sub !== "string") {
    throw new HttpError(401, "Invalid or expired session. Sign in again.");
  }
  // The user identity comes exclusively from the verified token. Client
  // request bodies and query strings can never influence which account's
  // data is accessed.
  return {
    id: payload.sub,
    githubId: Number(payload.githubId),
    login: String(payload.login || ""),
  };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

module.exports = { HttpError, requireUser, readBearer, json };

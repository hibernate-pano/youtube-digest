const { json, HttpError, serverTime } = require("../middleware");
const { MAX_EXPORT_BYTES } = require("../db");

async function me(ctx) {
  return json({
    user: {
      id: ctx.user.id,
      githubId: ctx.user.githubId,
      login: ctx.user.login,
    },
    serverTime: new Date().toISOString(),
  });
}

async function syncDelta(ctx) {
  const url = new URL(ctx.request.url);
  const since = url.searchParams.get("since") || "";
  // An unparseable timestamp used to become an Invalid Date, which compares
  // false against every row: the delta came back empty and the change was
  // silently lost. It is a client error instead.
  if (since && Number.isNaN(Date.parse(since))) {
    throw new HttpError(400, "since must be an ISO 8601 timestamp.");
  }
  const delta = await ctx.store.getSyncDelta(ctx.user.id, since || undefined);
  return json({ ...delta, serverTime: serverTime() });
}

async function exportData(ctx) {
  // The export is one JSON blob that the browser downloads. A blob of a few
  // hundred megabytes does not arrive: the download simply dies, and the
  // user is left with nothing. The size is measured BEFORE the blob is
  // built, so the Worker never holds one either.
  const bytes = await ctx.store.estimateExportBytes(ctx.user.id);
  if (bytes > MAX_EXPORT_BYTES) {
    const megabytes = (bytes / (1024 * 1024)).toFixed(1);
    const limit = Math.round(MAX_EXPORT_BYTES / (1024 * 1024));
    throw new HttpError(
      413,
      `Your notes and words add up to ${megabytes} MB, which is more than the ${limit} MB export limit. Delete what you no longer need and try again.`,
    );
  }
  const data = await ctx.store.getAllUserData(ctx.user.id);
  return json({
    exportedAt: new Date().toISOString(),
    format: "youtube-digest-export-v1",
    ...data,
  });
}

async function deleteAccount(ctx) {
  const notesDeleted = await ctx.store.deleteUserData(ctx.user.id);
  return json({ deleted: true, notesDeleted });
}

module.exports = { me, syncDelta, exportData, deleteAccount };

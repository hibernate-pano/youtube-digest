const { json, HttpError } = require("../middleware");

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
  return json(delta);
}

async function exportData(ctx) {
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

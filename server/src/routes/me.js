const { json } = require("../middleware");

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

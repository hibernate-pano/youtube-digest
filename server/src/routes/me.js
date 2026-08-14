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

module.exports = { me, syncDelta };

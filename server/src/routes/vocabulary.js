const { json, HttpError, serverTime } = require("../middleware");
const { parseVocabulary, VOCABULARY_STATUSES } = require("../validate");
const { readObjectBody } = require("./notes");

async function listVocabulary(ctx) {
  const rows = await ctx.store.listVocabulary(ctx.user.id);
  // The server's own clock travels with the rows: the client needs it to
  // tell which side of a conflict is newer without trusting the device
  // clock.
  //
  // The page is capped, the account is not: `total` is how many words the
  // account really holds, and `truncated` says whether this page holds all
  // of them. A UI that shows the length of the page alone tells the user a
  // false number about their own data.
  const total = await ctx.store.countVocabulary(ctx.user.id);
  return json({
    vocabulary: rows,
    total,
    truncated: rows.length < total,
    serverTime: serverTime(),
  });
}

async function upsertVocabulary(ctx) {
  const input = await readObjectBody(ctx);
  const vocab = parseVocabulary(input);
  if (!vocab) throw new HttpError(400, "A non-empty term is required.");
  const row = await ctx.store.upsertVocabulary(ctx.user.id, vocab);
  return json({ vocabulary: row, serverTime: serverTime() }, 201);
}

async function updateVocabularyStatus(ctx) {
  const input = await readObjectBody(ctx);
  const status = input && input.status;
  if (!VOCABULARY_STATUSES.has(status)) {
    throw new HttpError(400, "Status must be learning, reviewing, or mastered.");
  }
  const row = await ctx.store.updateVocabularyStatus(ctx.user.id, ctx.params.id, status);
  if (!row) throw new HttpError(404, "Vocabulary entry not found.");
  return json({ vocabulary: row, serverTime: serverTime() });
}

async function deleteVocabulary(ctx) {
  const deleted = await ctx.store.deleteVocabulary(ctx.user.id, ctx.params.id);
  if (!deleted) throw new HttpError(404, "Vocabulary entry not found.");
  return json({ deleted: true });
}

module.exports = { listVocabulary, upsertVocabulary, updateVocabularyStatus, deleteVocabulary };

const { json, HttpError } = require("../middleware");
const { parseVocabulary, VOCABULARY_STATUSES } = require("../validate");

async function listVocabulary(ctx) {
  const rows = await ctx.store.listVocabulary(ctx.user.id);
  return json({ vocabulary: rows });
}

async function upsertVocabulary(ctx) {
  const input = await ctx.request.json().catch(() => null);
  const vocab = parseVocabulary(input);
  if (!vocab) throw new HttpError(400, "A non-empty term is required.");
  const row = await ctx.store.upsertVocabulary(ctx.user.id, vocab);
  return json({ vocabulary: row }, 201);
}

async function updateVocabularyStatus(ctx) {
  const input = await ctx.request.json().catch(() => null);
  const status = input && input.status;
  if (!VOCABULARY_STATUSES.has(status)) {
    throw new HttpError(400, "Status must be learning, reviewing, or mastered.");
  }
  const row = await ctx.store.updateVocabularyStatus(ctx.user.id, ctx.params.id, status);
  if (!row) throw new HttpError(404, "Vocabulary entry not found.");
  return json({ vocabulary: row });
}

async function deleteVocabulary(ctx) {
  const deleted = await ctx.store.deleteVocabulary(ctx.user.id, ctx.params.id);
  if (!deleted) throw new HttpError(404, "Vocabulary entry not found.");
  return json({ deleted: true });
}

module.exports = { listVocabulary, upsertVocabulary, updateVocabularyStatus, deleteVocabulary };

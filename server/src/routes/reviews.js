const { json, HttpError } = require("../middleware");
const { parseReviewGrade } = require("../validate");

async function listDueReviews(ctx) {
  const url = new URL(ctx.request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
  const rows = await ctx.store.listDueReviews(ctx.user.id, limit);
  return json({ reviews: rows });
}

async function submitReview(ctx) {
  const input = await ctx.request.json().catch(() => null);
  const grade = parseReviewGrade(input && input.grade);
  if (grade === null) {
    throw new HttpError(400, "grade must be an integer from 0 to 5.");
  }
  const review = await ctx.store.submitReview(ctx.user.id, ctx.params.vocabId, grade);
  if (!review) throw new HttpError(404, "Vocabulary entry not found.");
  return json({ review });
}

module.exports = { listDueReviews, submitReview };

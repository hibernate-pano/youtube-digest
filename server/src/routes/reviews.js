const { json, HttpError, serverTime } = require("../middleware");
const { parseReviewGrade } = require("../validate");
const { readObjectBody } = require("./notes");

async function listDueReviews(ctx) {
  const url = new URL(ctx.request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
  const rows = await ctx.store.listDueReviews(ctx.user.id, limit);
  return json({ reviews: rows, serverTime: serverTime() });
}

async function submitReview(ctx) {
  // A body that is not JSON at all is a different failure from a body whose
  // grade is invalid. The first is a client bug, the second is a bad value.
  const input = await readObjectBody(ctx);
  const grade = parseReviewGrade(input.grade);
  if (grade === null) {
    throw new HttpError(400, "grade must be an integer from 0 to 5.");
  }
  const review = await ctx.store.submitReview(ctx.user.id, ctx.params.vocabId, grade);
  if (!review) throw new HttpError(404, "Vocabulary entry not found.");
  return json({ review });
}

module.exports = { listDueReviews, submitReview };

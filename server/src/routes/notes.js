const { json, HttpError } = require("../middleware");
const { parseNote } = require("../validate");

async function listNotes(ctx) {
  const rows = await ctx.store.listNotes(ctx.user.id);
  return json({ notes: rows });
}

async function createNote(ctx) {
  const input = await ctx.request.json().catch(() => null);
  const note = parseNote(input);
  if (!note) throw new HttpError(400, "A non-empty note is required.");
  const row = await ctx.store.createNote(ctx.user.id, note);
  return json({ note: row }, 201);
}

async function updateNote(ctx) {
  const input = await ctx.request.json().catch(() => null);
  const note = parseNote(input);
  if (!note) throw new HttpError(400, "A non-empty note is required.");
  const row = await ctx.store.updateNote(ctx.user.id, ctx.params.id, note);
  if (!row) throw new HttpError(404, "Note not found.");
  return json({ note: row });
}

async function deleteNote(ctx) {
  const deleted = await ctx.store.deleteNote(ctx.user.id, ctx.params.id);
  if (!deleted) throw new HttpError(404, "Note not found.");
  return json({ deleted: true });
}

module.exports = { listNotes, createNote, updateNote, deleteNote };

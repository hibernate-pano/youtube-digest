const { json, HttpError, readJsonObject } = require("../middleware");
const { parseNote, parseNotePatch } = require("../validate");

/**
 * Reads and parses a JSON body, refusing a body that is not JSON.
 * @returns {Promise<object>} the parsed object.
 */
async function readObjectBody(ctx) {
  return readJsonObject(ctx.request);
}

async function listNotes(ctx) {
  const rows = await ctx.store.listNotes(ctx.user.id);
  return json({ notes: rows });
}

async function createNote(ctx) {
  const input = await readObjectBody(ctx);
  const note = parseNote(input);
  if (!note) throw new HttpError(400, "A non-empty note is required.");
  if (!note.clientId) {
    throw new HttpError(400, "clientId is required for idempotent sync.");
  }
  const row = await ctx.store.createNote(ctx.user.id, note);
  return json({ note: row }, 201);
}

async function setNoteStarred(ctx) {
  const input = await readObjectBody(ctx);
  if (typeof input?.starred !== "boolean") {
    throw new HttpError(400, "starred must be a boolean.");
  }
  const row = await ctx.store.setNoteStarred(ctx.user.id, ctx.params.id, input.starred);
  if (!row) throw new HttpError(404, "Note not found.");
  return json({ note: row });
}

async function deleteNoteByClientId(ctx) {
  const deleted = await ctx.store.deleteNoteByClientId(
    ctx.user.id,
    ctx.params.clientId,
  );
  if (!deleted) throw new HttpError(404, "Note not found.");
  return json({ deleted: true });
}

async function updateNote(ctx) {
  const input = await readObjectBody(ctx);
  // A PATCH is sparse: only the fields the client actually sent are
  // written. The strict parser would zero every omitted field.
  const note = parseNotePatch(input);
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

module.exports = {
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  deleteNoteByClientId,
  setNoteStarred,
  readObjectBody,
};

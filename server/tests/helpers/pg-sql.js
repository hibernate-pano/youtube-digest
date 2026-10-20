/**
 * A tagged-template SQL client backed by a real PostgreSQL server.
 *
 * The Neon driver and this client agree on one rule that matters: every
 * interpolation inside a tagged template becomes a **bound parameter**, so an
 * identifier can never be interpolated - `from ${table}` sends `from $1`,
 * which Postgres rejects.
 *
 * That rule is exactly what the fake SQL helper got wrong, and the mistake
 * shipped two production bugs that a hundred passing tests did not catch.
 * Running the store's SQL against a real server is the only way to be sure
 * the statement is executable at all.
 *
 * The Neon driver talks HTTP to Neon and cannot be pointed at a local
 * server, so this adapter exists for the tests: it reproduces the binding
 * semantics, then hands the statement to `pg`.
 */

const { Pool } = require("pg");

/**
 * Builds a tagged-template function with Neon's binding semantics on top of
 * a `pg` pool.
 *
 * @param {import("pg").Pool} pool the connection pool.
 * @returns {(strings: TemplateStringsArray, ...values: unknown[]) => Promise<object[]>}
 *   a function that behaves like `neon(connectionString)`.
 */
function createPgSql(pool) {
  return async function pgSql(strings, ...values) {
    // The Neon driver joins the literal chunks with numbered placeholders:
    // `A[0] $1 A[1] $2 A[2] ...`. `pg` speaks the same placeholders, so the
    // text is assembled here and the values stay bound.
    let text = "";
    for (let index = 0; index < strings.length; index += 1) {
      text += strings[index];
      if (index < values.length) text += `$${index + 1}`;
    }
    const result = await pool.query(text, values);
    return result.rows;
  };
}

/**
 * Creates the schema the Worker expects, in a database that is already
 * empty. The file is the same one the deploy script applies, so the test
 * runs against the real schema and not a paraphrase of it.
 *
 * @param {import("pg").Pool} pool the connection pool.
 * @param {string} schemaSql the contents of `server/schema.sql`.
 */
async function createSchema(pool, schemaSql) {
  await pool.query(schemaSql);
}

/**
 * Empties the tables between tests, so each test starts from a known state
 * and the ids it gets back are predictable.
 *
 * @param {import("pg").Pool} pool the connection pool.
 */
async function resetTables(pool) {
  await pool.query(
    "delete from review_items; delete from vocabulary; delete from notes; delete from users;",
  );
}

module.exports = { createPgSql, createSchema, resetTables };

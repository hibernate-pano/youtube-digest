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
 * The statements are lazy, exactly like the Neon driver's: the request is
 * only sent when the statement is awaited. That is what makes a transaction
 * possible here: the statements of a batch are handed to `transaction()`
 * first and are then run on one connection, inside one transaction, so a
 * batch that fails leaves nothing behind.
 *
 * @param {import("pg").Pool} pool the connection pool.
 * @returns {(strings: TemplateStringsArray, ...values: unknown[]) => Promise<object[]>}
 *   a function that behaves like `neon(connectionString)`.
 */
function createPgSql(pool) {
  function build(strings, values) {
    // The Neon driver joins the literal chunks with numbered placeholders:
    // `A[0] $1 A[1] $2 A[2] ...`. `pg` speaks the same placeholders, so the
    // text is assembled here and the values stay bound.
    let text = "";
    for (let index = 0; index < strings.length; index += 1) {
      text += strings[index];
      if (index < values.length) text += `$${index + 1}`;
    }
    return { text, values };
  }

  const sql = (strings, ...values) => {
    const query = build(strings, values);
    const run = () => pool.query(query.text, query.values).then((result) => result.rows);
    return {
      then(onFulfilled, onRejected) {
        return run().then(onFulfilled, onRejected);
      },
      catch(onRejected) {
        return run().catch(onRejected);
      },
      finally(onFinally) {
        return run().finally(onFinally);
      },
      /** Runs the statement on a connection of the transaction. */
      runOn(client) {
        return client.query(query.text, query.values).then((result) => result.rows);
      },
    };
  };

  /**
   * Runs the statements of a batch in one transaction.
   *
   * The Neon driver submits the statements of a transaction as one request,
   * so they all land or none of them does. Here the same promise is kept
   * with `BEGIN` and `COMMIT`: a statement that fails rolls the whole
   * transaction back.
   *
   * @param {object[]} statements the statements of the batch.
   * @returns {Promise<object[][]>} the rows of every statement.
   */
  sql.transaction = async (statements) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const statement of statements) {
        results.push(await statement.runOn(client));
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  return sql;
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

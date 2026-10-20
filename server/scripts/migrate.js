/**
 * Applies server/schema.sql to the Neon database.
 * Usage: DATABASE_URL=postgres://... node scripts/migrate.js
 */
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required (e.g. DATABASE_URL=postgres://... node scripts/migrate.js)");
    process.exit(1);
  }
  const { Pool } = require("@neondatabase/serverless");
  const pool = new Pool({ connectionString });
  const schemaPath = path.join(__dirname, "..", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  try {
    // Tables created before client_id existed need an idempotent upgrade;
    // run ALTERs first so schema.sql's client_id index can be created.
    await pool.query("alter table notes add column if not exists client_id text;");
    // `create table if not exists` is a no-op for an existing table, so the
    // NOT NULL of schema.sql never lands on its own. Backfill first: a NULL
    // client_id defeats `unique (user_id, client_id)` (NULL != NULL), which
    // would let repeated pushes create duplicate notes.
    await pool.query(
      "update notes set client_id = id::text where client_id is null;",
    );
    await pool.query(
      "alter table notes alter column client_id set not null;",
    );
    await pool.query(
      "create unique index if not exists notes_user_client_unique on notes (user_id, client_id);",
    );
    await pool.query(
      "alter table notes add column if not exists starred boolean not null default false;",
    );
    // Token revocation: the account's token version is bumped when the
    // account is deleted, which invalidates the JWTs it issued.
    await pool.query(
      "alter table users add column if not exists token_version integer not null default 0;",
    );
    // The review interval is capped at a year. `create table if not exists`
    // in schema.sql never touches an existing table, so the check constraint
    // has to be added here; Postgres has no "add constraint if not exists",
    // hence the guarded DO block.
    await pool.query(`
      do $$
      begin
        if not exists (
          select 1 from pg_constraint where conname = 'review_items_interval_days_check'
        ) then
          alter table review_items add constraint review_items_interval_days_check
            check (interval_days between 0 and 365);
        end if;
      end $$;
    `);
    await pool.query(schema);
    console.log("Schema applied.");
  } catch (error) {
    console.error("Could not apply schema:", error.message);
    console.error("Fallback: run the schema manually, e.g.: psql $DATABASE_URL -f server/schema.sql");
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();

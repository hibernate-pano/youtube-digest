/**
 * Applies server/schema.sql to the Neon database.
 * Usage: DATABASE_URL=postgresql://... node scripts/migrate.js
 */
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_PATH = path.join(__dirname, "..", "schema.sql");

/**
 * The upgrade statements, in the order they have to run.
 *
 * They run BEFORE schema.sql, because `create table if not exists` never
 * touches an existing table: a database that was created before the
 * `client_id` column existed would keep its old shape forever - and
 * schema.sql's own index on (user_id, client_id) would fail with
 * `column "client_id" does not exist`.
 *
 * Every statement is guarded by "the table exists", because on a fresh
 * database there is no table to alter. Without the guard Postgres answers
 * 42P01 (`relation "notes" does not exist`), this script exits 1, and
 * scripts/deploy.sh - which runs the migration before the deploy - aborts
 * the deployment of a brand-new database.
 */
const UPGRADE_STATEMENTS = [
  // A table that was created before `client_id` existed needs the column.
  // `if exists` keeps the statement a no-op on a fresh database.
  "alter table if exists notes add column if not exists client_id text;",
  // `create table if not exists` is a no-op for an existing table, so the
  // NOT NULL of schema.sql never lands on its own. Backfill first: a NULL
  // client_id defeats `unique (user_id, client_id)` (NULL != NULL), which
  // would let repeated pushes create duplicate notes.
  `do $$
    begin
      if to_regclass('notes') is not null then
        update notes set client_id = id::text where client_id is null;
        alter table notes alter column client_id set not null;
      end if;
    end $$;`,
  // The same uniqueness as an index: an existing table never gets the
  // `unique (user_id, client_id)` constraint of schema.sql, so the index is
  // what keeps a repeated push from creating a duplicate note.
  //
  // The index is only created when the table has no unique index on those
  // two columns yet. A table that schema.sql created already carries the
  // constraint (and with it the index), and a database that an earlier
  // version of this script migrated already carries this very index: in
  // both cases a second index would only cost write time.
  `do $$
    begin
      if to_regclass('notes') is not null
        and not exists (
          select 1
          from pg_index i
          join pg_attribute user_column
            on user_column.attrelid = i.indrelid and user_column.attnum = i.indkey[0]
          join pg_attribute client_column
            on client_column.attrelid = i.indrelid and client_column.attnum = i.indkey[1]
          where i.indrelid = to_regclass('notes')
            and i.indisunique
            and i.indnkeyatts = 2
            and user_column.attname = 'user_id'
            and client_column.attname = 'client_id'
        ) then
        create unique index if not exists notes_user_client_unique
          on notes (user_id, client_id);
      end if;
    end $$;`,
  "alter table if exists notes add column if not exists starred boolean not null default false;",
  // Token revocation: the account's token version is bumped when the
  // account is deleted, which invalidates the JWTs it issued.
  "alter table if exists users add column if not exists token_version integer not null default 0;",
  // The review interval is capped at a year. `create table if not exists`
  // in schema.sql never touches an existing table, so the check constraint
  // has to be added here; Postgres has no "add constraint if not exists",
  // hence the guarded DO block.
  //
  // The guard asks about THIS table: a constraint of the same name on
  // another table (another schema, another database) says nothing about
  // this one.
  `do $$
    begin
      if to_regclass('review_items') is not null
        and not exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('review_items')
            and conname = 'review_items_interval_days_check'
        ) then
        alter table review_items add constraint review_items_interval_days_check
          check (interval_days between 0 and 365);
      end if;
    end $$;`,
];

/**
 * Brings a database up to the shape of schema.sql.
 *
 * Works on a fresh database (nothing exists, the upgrades are no-ops and
 * schema.sql creates everything) and on a database that was created before
 * the current schema (the upgrades fix it up, schema.sql fills in the
 * rest). Running it twice is a no-op.
 *
 * @param {{query: (text: string) => Promise<unknown>}} pool a database pool
 *   (or anything with a `query` method - a `pg` client works too).
 * @param {{schemaSql?: string}} [options] the schema to apply; defaults to
 *   the file next to this script.
 */
async function applyMigration(pool, options = {}) {
  const schema =
    options.schemaSql !== undefined
      ? options.schemaSql
      : fs.readFileSync(SCHEMA_PATH, "utf8");
  for (const statement of UPGRADE_STATEMENTS) {
    await pool.query(statement);
  }
  await pool.query(schema);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required (e.g. DATABASE_URL=postgresql://... node scripts/migrate.js)");
    process.exit(1);
  }
  const { Pool } = require("@neondatabase/serverless");
  const pool = new Pool({ connectionString });
  try {
    await applyMigration(pool);
    console.log("Schema applied.");
  } catch (error) {
    console.error("Could not apply schema:", error.message);
    console.error("Fallback: run the schema manually, e.g.: psql $DATABASE_URL -f server/schema.sql");
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = { applyMigration, UPGRADE_STATEMENTS };

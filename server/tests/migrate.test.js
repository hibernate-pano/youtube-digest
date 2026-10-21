/**
 * The migration, run against a real PostgreSQL.
 *
 * `npm run db:migrate` used to fail on a fresh database: the script starts
 * with `alter table notes add column ...`, and on a database where the
 * tables do not exist yet Postgres answers 42P01 ("relation notes does not
 * exist"). The script exits 1, and scripts/deploy.sh - which runs the
 * migration before the deploy - aborts the whole deployment. A brand-new
 * database could not be deployed to.
 *
 * The fix cannot be "run schema.sql first": schema.sql creates an index on
 * (user_id, client_id), and that fails on an OLD database whose notes table
 * predates the client_id column. The upgrades have to stay ahead of
 * schema.sql and turn into no-ops where there is nothing to upgrade.
 *
 * The suite is skipped when no database is configured, so a developer
 * without a local Postgres is not blocked. CI runs it against a service
 * container.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { applyMigration } = require("../scripts/migrate.js");

const DATABASE_URL = process.env.YTD_TEST_DATABASE_URL;

const schemaSql = fs.readFileSync(
  path.resolve(__dirname, "..", "schema.sql"),
  "utf8",
);

let pool = null;
let Pool = null;
if (DATABASE_URL) {
  ({ Pool } = require("pg"));
  pool = new Pool({ connectionString: DATABASE_URL });
}

const describe = DATABASE_URL ? test : test.skip;

/**
 * Runs `body` in a throwaway schema.
 *
 * A schema is a namespace inside the test database. The migration's SQL
 * uses unqualified table names, so pointing the search_path at an empty
 * schema gives every case its own clean database - without the CREATE
 * DATABASE privilege and without a second server.
 *
 * @param {(scoped: import("pg").Pool, name: string) => Promise<unknown>} body
 */
async function inTempSchema(body) {
  const name = "mig_" + Math.random().toString(36).slice(2, 10);
  await pool.query(`create schema "${name}"`);
  // A pool of its own: the search_path has to apply to every connection
  // the migration uses.
  const scoped = new Pool({
    connectionString: DATABASE_URL,
    options: `-c search_path=${name}`,
  });
  try {
    return await body(scoped, name);
  } finally {
    await scoped.end();
    await pool.query(`drop schema "${name}" cascade`);
  }
}

/**
 * Reads the shape of a schema: its columns, its constraints and its
 * indexes. This is what "the database has the schema of schema.sql" means
 * in a form two databases can be compared with.
 */
async function readSchema(scoped, schemaName) {
  const columns = await scoped.query(
    `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns where table_schema = $1
       order by table_name, column_name`,
    [schemaName],
  );
  const constraints = await scoped.query(
    `select conname, pg_get_constraintdef(oid) as definition
       from pg_constraint where connamespace = $1::regnamespace
       order by conname`,
    [schemaName],
  );
  const indexes = await scoped.query(
    `select indexname, indexdef from pg_indexes where schemaname = $1
       order by indexname`,
    [schemaName],
  );
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    // The schema name is part of an index definition and differs per case,
    // so it is normalized away before two schemas are compared.
    indexes: indexes.rows.map((row) => ({
      indexname: row.indexname,
      indexdef: row.indexdef.split(schemaName + ".").join("<schema>."),
    })),
  };
}

/** The shape a database had before client_id, starred and token_version. */
const OLD_SHAPE = `
  create table users (
    id bigserial primary key,
    github_id bigint not null unique,
    github_login text not null,
    avatar_url text,
    created_at timestamptz not null default now()
  );

  create table notes (
    id uuid primary key default gen_random_uuid(),
    user_id bigint not null references users(id) on delete cascade,
    video_id text not null,
    video_title text not null default '',
    channel_name text not null default '',
    timestamp_seconds integer not null,
    quote text not null default '',
    note text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table vocabulary (
    id uuid primary key default gen_random_uuid(),
    user_id bigint not null references users(id) on delete cascade,
    term text not null,
    translation text not null default '',
    sentence text not null default '',
    sentence_translation text not null default '',
    video_id text not null default '',
    video_title text not null default '',
    timestamp_seconds integer not null default 0,
    status text not null default 'learning',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, term, sentence)
  );

  -- The review interval was not capped yet: no check constraint.
  create table review_items (
    id uuid primary key default gen_random_uuid(),
    user_id bigint not null references users(id) on delete cascade,
    vocabulary_id uuid not null references vocabulary(id) on delete cascade,
    due_at timestamptz not null default now(),
    interval_days integer not null default 0,
    ease real not null default 2.5,
    reps integer not null default 0,
    lapses integer not null default 0,
    updated_at timestamptz not null default now(),
    unique (user_id, vocabulary_id)
  );
`;

describe("the migration runs against a real PostgreSQL", async (t) => {
  t.after(async () => {
    if (pool) await pool.end();
  });

  await t.test("a fresh database gets exactly the schema of schema.sql", async () => {
    const migrated = await inTempSchema(async (scoped, name) => {
      await applyMigration(scoped);
      return readSchema(scoped, name);
    });
    const reference = await inTempSchema(async (scoped, name) => {
      // The schema of record, applied the way the file says.
      await scoped.query(schemaSql);
      return readSchema(scoped, name);
    });

    assert.deepEqual(migrated.columns, reference.columns);
    assert.deepEqual(migrated.constraints, reference.constraints);
    assert.deepEqual(migrated.indexes, reference.indexes);
  });

  await t.test("a fresh database has every table and column of the schema", async () => {
    await inTempSchema(async (scoped, name) => {
      await applyMigration(scoped);

      const tables = await scoped.query(
        "select table_name from information_schema.tables where table_schema = $1 order by table_name",
        [name],
      );
      assert.deepEqual(
        tables.rows.map((row) => row.table_name),
        ["notes", "review_items", "users", "vocabulary"],
      );

      const columns = await scoped.query(
        `select table_name, column_name, data_type, is_nullable, column_default
           from information_schema.columns where table_schema = $1`,
        [name],
      );
      const byName = new Map(
        columns.rows.map((row) => [row.table_name + "." + row.column_name, row]),
      );

      // The columns the upgrade statements are about.
      assert.equal(byName.get("notes.client_id").data_type, "text");
      assert.equal(byName.get("notes.client_id").is_nullable, "NO");
      assert.equal(byName.get("notes.starred").data_type, "boolean");
      assert.equal(byName.get("notes.starred").is_nullable, "NO");
      assert.equal(byName.get("users.token_version").data_type, "integer");
      assert.equal(byName.get("users.token_version").is_nullable, "NO");

      // And the constraint the DO block is about.
      const constraints = await scoped.query(
        "select conname from pg_constraint where connamespace = $1::regnamespace",
        [name],
      );
      const names = constraints.rows.map((row) => row.conname);
      assert.ok(
        names.includes("review_items_interval_days_check"),
        "the review interval cap is missing: " + names.join(", "),
      );
    });
  });

  await t.test("an old database is upgraded and keeps its rows", async () => {
    await inTempSchema(async (scoped, name) => {
      await scoped.query(OLD_SHAPE);
      await scoped.query(
        "insert into users (github_id, github_login) values (7, 'alice')",
      );
      const inserted = await scoped.query(
        `insert into notes (user_id, video_id, timestamp_seconds, note)
           values (1, 'abc123xyz', 42, 'the original note') returning id`,
      );
      const noteId = inserted.rows[0].id;

      // A constraint of the same name on ANOTHER table says nothing about
      // this one. Without the table in the guard, the upgrade would skip
      // the cap because of a stranger's constraint.
      const decoy = "decoy_" + Math.random().toString(36).slice(2, 10);
      await scoped.query(`create schema "${decoy}"`);
      await scoped.query(
        `create table "${decoy}".review_items (
           interval_days integer,
           constraint review_items_interval_days_check check (interval_days >= 0)
         )`,
      );

      try {
        await applyMigration(scoped);
      } finally {
        await scoped.query(`drop schema "${decoy}" cascade`);
      }

      // The client id is backfilled from the note's own id, so every old
      // note keeps a sync identity - and the column is NOT NULL from now
      // on, which is what makes `unique (user_id, client_id)` work.
      const row = await scoped.query(
        "select client_id, starred from notes where id = $1",
        [noteId],
      );
      assert.equal(row.rows[0].client_id, noteId);
      assert.equal(row.rows[0].starred, false);

      const columns = await scoped.query(
        `select column_name, is_nullable from information_schema.columns
           where table_schema = $1 and table_name = 'notes'`,
        [name],
      );
      const clientId = columns.rows.find((row) => row.column_name === "client_id");
      assert.equal(clientId.is_nullable, "NO", "client_id must be NOT NULL after the upgrade");

      // The uniqueness the old table never had: a repeated push of the
      // same note must not create a second row.
      await assert.rejects(
        () =>
          scoped.query(
            "insert into notes (user_id, client_id, video_id, timestamp_seconds, note) values (1, $1, 'abc123xyz', 42, 'a copy')",
            [noteId],
          ),
        "a duplicate client id must be refused",
      );

      // The token version the old table never had.
      const user = await scoped.query("select token_version from users where id = 1");
      assert.equal(user.rows[0].token_version, 0);

      // The review interval cap the old table never had.
      const constraints = await scoped.query(
        "select conname from pg_constraint where connamespace = $1::regnamespace",
        [name],
      );
      const names = constraints.rows.map((row) => row.conname);
      assert.ok(
        names.includes("review_items_interval_days_check"),
        "the review interval cap is missing: " + names.join(", "),
      );
      await assert.rejects(
        () =>
          scoped.query(
            "insert into review_items (user_id, vocabulary_id, interval_days) values (1, gen_random_uuid(), 400)",
          ),
        "an interval longer than a year must be refused",
      );
    });
  });

  await t.test("running the migration twice changes nothing", async () => {
    await inTempSchema(async (scoped, name) => {
      await applyMigration(scoped);
      const first = await readSchema(scoped, name);

      // The deployment runs the migration on every deploy, so the second
      // run has to succeed on the shape the first one left behind.
      await applyMigration(scoped);
      const second = await readSchema(scoped, name);

      assert.deepEqual(second.columns, first.columns);
      assert.deepEqual(second.constraints, first.constraints);
      assert.deepEqual(second.indexes, first.indexes);
    });
  });

  await t.test("running the migration twice on an old database changes nothing", async () => {
    await inTempSchema(async (scoped, name) => {
      await scoped.query(OLD_SHAPE);
      await scoped.query(
        "insert into users (github_id, github_login) values (7, 'alice')",
      );
      await scoped.query(
        `insert into notes (user_id, video_id, timestamp_seconds, note)
           values (1, 'abc123xyz', 42, 'the original note')`,
      );

      await applyMigration(scoped);
      const first = await readSchema(scoped, name);
      await applyMigration(scoped);
      const second = await readSchema(scoped, name);

      assert.deepEqual(second.columns, first.columns);
      assert.deepEqual(second.constraints, first.constraints);
      assert.deepEqual(second.indexes, first.indexes);

      const row = await scoped.query("select client_id from notes");
      assert.equal(row.rows[0].client_id.length > 0, true, "the backfill must survive");
    });
  });
});

test("the real-Postgres migration suite is wired to a database", () => {
  if (!DATABASE_URL) {
    assert.ok(
      process.env.YTD_TEST_DATABASE_URL === undefined,
      "YTD_TEST_DATABASE_URL was set to an empty value",
    );
    return;
  }
  // The scheme has to be a Postgres one. It is written either way in the
  // wild: the container image is postgres, and the pooled
  // Neon URL in .dev.vars says postgresql://.
  //
  // The check used to read /^postgresql(ql)?:\/\//, which let
  // "postgresqlql://" through and turned away the postgres://
  // that the CI service container actually answers to. A test that
  // rejects the URL the project uses is not a test, it is a wall.
  assert.match(DATABASE_URL, /^postgres(ql)?:\/\//i);
});

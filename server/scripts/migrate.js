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
    await pool.query(
      "create unique index if not exists notes_user_client_unique on notes (user_id, client_id);",
    );
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

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

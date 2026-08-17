/**
 * Full database backup to a local JSON file (server/backups/).
 * Usage: NEON_URL=... node scripts/backup.js [output-dir]
 * Run weekly via cron; keep the file somewhere safe (not in git).
 */
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const connectionString = process.env.NEON_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("NEON_URL (or DATABASE_URL) is required.");
    process.exit(1);
  }
  const { Pool } = require("@neondatabase/serverless");
  const pool = new Pool({ connectionString });
  try {
    const [users, notes, vocabulary, reviewItems] = await Promise.all([
      pool.query("select * from users order by id"),
      pool.query("select * from notes order by created_at"),
      pool.query("select * from vocabulary order by created_at"),
      pool.query("select * from review_items order by updated_at"),
    ]);
    const backup = {
      backupAt: new Date().toISOString(),
      users: users.rows,
      notes: notes.rows,
      vocabulary: vocabulary.rows,
      reviewItems: reviewItems.rows,
    };
    const outDir = process.argv[2] || path.join(__dirname, "..", "backups");
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, "backup-" + new Date().toISOString().slice(0, 10) + ".json");
    fs.writeFileSync(file, JSON.stringify(backup, null, 2));
    console.log("Backup written:", file);
    console.log("Rows:", users.rows.length, "users,", notes.rows.length, "notes,",
      vocabulary.rows.length, "vocabulary,", reviewItems.rows.length, "reviews.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Backup failed:", error.message);
  process.exit(1);
});

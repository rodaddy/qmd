// Companion to pg-bridge-fails-fast.sh. Opens the Postgres bridge on a URL
// that cannot connect and expects a thrown error, not a hang.
import { openPgDatabase } from "../../src/pg.ts";
const t0 = Date.now();
let db;
try {
  db = openPgDatabase(process.argv[2] ?? "/nonexistent/path/index.sqlite");
  db.exec("select 1");
  console.log("FAIL bridge returned success on an unreachable URL");
  process.exit(1);
} catch (e) {
  console.log(`PASS bridge threw in ${Date.now() - t0}ms: ${String(e.message).slice(0, 100)}`);
  try { db?.close(); } catch {}
  process.exit(0);
}

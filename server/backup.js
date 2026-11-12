// Daily copies of the database, keeping the most recent few.
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Copy the database to `<dir>/recall-YYYY-MM-DD.db` (local date of `now`) unless today's copy
 * exists, then delete the oldest copies beyond `keep`. Returns the new file, or null.
 */
export function backupDb(db, dir, now, keep = 30) {
  const day = new Date(now).toLocaleDateString('sv'); // YYYY-MM-DD
  const target = join(dir, `recall-${day}.db`);
  if (existsSync(target)) return null;
  mkdirSync(dir, { recursive: true });
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  const old = readdirSync(dir).filter((f) => /^recall-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of old.slice(0, -keep)) unlinkSync(join(dir, f));
  return target;
}

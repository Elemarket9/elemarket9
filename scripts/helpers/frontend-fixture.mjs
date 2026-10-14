import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** Prepare fresh synthetic sessions in an explicitly selected local test database. */
export async function createFrontendFixtures(databaseUrl, outputFile) {
  const url = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/(?:_frontend|_test|_verify)$/.test(url.pathname)) throw new Error('Frontend fixtures require a local database ending in _frontend, _test or _verify.');
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const relativeOutput = path.relative(projectRoot, path.resolve(outputFile));
  if (relativeOutput !== ".." && !relativeOutput.startsWith(".." + path.sep) && !path.isAbsolute(relativeOutput)) throw new Error("Use an external path for frontend test fixtures.");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const identities = {};
  const suffix = randomUUID().slice(0, 8);
  try {
    for (const [key, role] of [['customer', 'customer'], ['other', 'customer'], ['admin', 'admin']]) {
      const id = `frontend_${key}_${suffix}`;
      const name = `Frontend ${key} ${suffix}`;
      const token = randomUUID() + randomUUID();
      await pool.query(`insert into "user"(id,name,email,"emailVerified",role,"twoFactorEnabled","twoFactorEnabledAt")
        values($1,$2,$3,true,$4,$5,case when $5 then now()-interval '1 hour' else null end)`, [id, name, `${id}@frontend.test`, role, role === 'admin']);
      await pool.query(`insert into session(id,token,"userId","expiresAt","updatedAt","ipAddress","userAgent")
        values($1,$2,$3,now()+interval '1 day',now(),'127.0.0.1','Frontend verification')`, [randomUUID(), token, id]);
      identities[key] = { id, name, token };
    }
    fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(identities));
    return identities;
  } finally { await pool.end(); }
}

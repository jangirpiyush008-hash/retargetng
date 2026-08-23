import { loadEnv } from './env.js';
loadEnv();
import { createPool } from './client.js';
import { migrate, resetSchema } from './migrate.js';

const cmd = process.argv[2];
const pool = createPool({ max: 2 });
try {
  if (cmd === 'migrate') {
    const r = await migrate(pool, { log: (m) => console.log(m) });
    console.log(`applied ${r.applied.length}, skipped ${r.skipped.length}`);
  } else if (cmd === 'reset') {
    if (process.env.NODE_ENV === 'production') throw new Error('refusing to reset a production database');
    await resetSchema(pool);
    const r = await migrate(pool, { log: (m) => console.log(m) });
    console.log(`reset + applied ${r.applied.length}`);
  } else {
    console.error('usage: cli.ts migrate|reset');
    process.exit(2);
  }
} finally {
  await pool.end();
}

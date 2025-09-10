import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT version()');
    console.log('✅ Connected! Postgres version:', rows[0].version);
  } catch (e) {
    console.error('❌ Connection failed:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main();

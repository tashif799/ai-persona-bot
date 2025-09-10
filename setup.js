import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();
  try {
    // Enable pgvector
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    // Create the table for embeddings
    await client.query(`
      CREATE TABLE IF NOT EXISTS persona_embeddings (
        id BIGSERIAL PRIMARY KEY,
        persona_id TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding VECTOR(1536),
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    // Create an index for fast similarity search
    await client.query(`
      CREATE INDEX IF NOT EXISTS persona_embeddings_ivf
      ON persona_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
    `);

    console.log('✅ pgvector enabled & table ready');
  } catch (e) {
    console.error('❌ Setup failed:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

run();

import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// make a tiny non-zero vector and normalize it (length 1)
function unitVector(dim = 1536) {
  const v = Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0)); // [1,0,0,...]
  return v; // already unit length
}

const probe = unitVector();

async function main() {
  const client = await pool.connect();
  try {
    // insert one row with a non-zero vector
    await client.query(
      `INSERT INTO persona_embeddings (persona_id, text, embedding)
       VALUES ($1, $2, $3::float4[]::vector)`,
      ['mark', 'Hello from pgvector 🎯', probe]
    );

    // cosine similarity = 1 - cosine distance
    const { rows } = await client.query(
      `SELECT id, text,
              1 - (embedding <=> ($1::float4[]::vector)) AS cosine_similarity
       FROM persona_embeddings
       WHERE persona_id = $2
       ORDER BY embedding <=> ($1::float4[]::vector)
       LIMIT 3`,
      [probe, 'mark']
    );

    console.log('🔎 Results:', rows);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);

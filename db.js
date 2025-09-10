import 'dotenv/config';
import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function rememberEmbedding({ personaId, text, embedding }) {
  // embedding is a JS number[] (length 1536 for text-embedding-3-small)
  await pool.query(
    `INSERT INTO persona_embeddings (persona_id, text, embedding)
     VALUES ($1, $2, $3::float4[]::vector)`,
    [personaId, text, embedding]
  );
}

export async function searchSimilar({ personaId, embedding, k = 5 }) {
  const { rows } = await pool.query(
    `SELECT id, text, 1 - (embedding <=> ($1::float4[]::vector)) AS cosine_similarity
     FROM persona_embeddings
     WHERE persona_id = $2
     ORDER BY embedding <=> ($1::float4[]::vector)
     LIMIT $3`,
    [embedding, personaId, k]
  );
  return rows;
}

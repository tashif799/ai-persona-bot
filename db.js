import 'dotenv/config';
import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ---------- persona embeddings ----------
export async function rememberEmbedding({ personaId, text, embedding }) {
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

// ---------- user memory ----------
export async function rememberUserQuirk(userId, note) {
  await pool.query(
    'INSERT INTO user_memory (user_id, note) VALUES ($1, $2)',
    [userId, note]
  );
}

export async function getUserQuirks(userId, limit = 5) {
  const { rows } = await pool.query(
    'SELECT note FROM user_memory WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit]
  );
  return rows.map(r => r.note);
}

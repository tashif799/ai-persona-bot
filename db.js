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

// ---------- moderation logging ----------
export async function logModerationEvent({
  guildId, channelId, userId, messageId, content,
  harassment=false, hate=false, violence=false,
  passive_aggr=false, condescending=false, provocation=false,
  toxicity='none', action_taken='none'
}) {
  await pool.query(
    `INSERT INTO moderation_log
     (guild_id, channel_id, user_id, message_id, content,
      harassment, hate, violence, passive_aggr, condescending, provocation, toxicity, action_taken)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [guildId, channelId, userId, messageId, content,
     harassment, hate, violence, passive_aggr, condescending, provocation, toxicity, action_taken]
  );
}

// Recent incidents (any severity) in last N hours for a guild
export async function getRecentIncidents({ guildId, hours = 24, limit = 20 }) {
  const { rows } = await pool.query(
    `SELECT user_id, action_taken, passive_aggr, condescending, provocation, toxicity, content, created_at
     FROM moderation_log
     WHERE guild_id = $1 AND created_at >= now() - ($2 || ' hours')::interval
     ORDER BY created_at DESC
     LIMIT $3`,
    [guildId, String(hours), limit]
  );
  return rows;
}

// Per-user summary window
export async function getUserBehaviorSummary({ userId, hours = 168 }) {
  const { rows } = await pool.query(
    `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN passive_aggr THEN 1 ELSE 0 END) AS passive_aggr,
        SUM(CASE WHEN condescending THEN 1 ELSE 0 END) AS condescending,
        SUM(CASE WHEN provocation THEN 1 ELSE 0 END) AS provocation,
        SUM(CASE WHEN action_taken IN ('warn','timeout','kick','ban','delete') THEN 1 ELSE 0 END) AS actions
     FROM moderation_log
     WHERE user_id = $1 AND created_at >= now() - ($2 || ' hours')::interval`,
    [userId, String(hours)]
  );
  return rows[0];
}

// Top users by incidents
export async function getTopSuspects({ guildId, hours = 24, limit = 5 }) {
  const { rows } = await pool.query(
    `SELECT user_id,
            COUNT(*) AS incidents,
            SUM(CASE WHEN passive_aggr OR condescending OR provocation THEN 1 ELSE 0 END) AS tone_flags,
            SUM(CASE WHEN action_taken IN ('warn','timeout','kick','ban','delete') THEN 1 ELSE 0 END) AS actions
     FROM moderation_log
     WHERE guild_id = $1 AND created_at >= now() - ($2 || ' hours')::interval
     GROUP BY user_id
     ORDER BY actions DESC, tone_flags DESC, incidents DESC
     LIMIT $3`,
    [guildId, String(hours), limit]
  );
  return rows;
}

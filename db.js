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

// ---------- Conversation History Functions ----------
export async function saveConversationMessage({ channelId, guildId, userId, role, content }) {
  try {
    await pool.query(
      `INSERT INTO conversation_history (channel_id, guild_id, user_id, role, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [channelId, guildId, userId, role, content]
    );
  } catch (error) {
    console.error('Failed to save conversation message:', error);
  }
}

export async function getConversationHistory({ channelId, limit = 20, maxAgeHours = 24 }) {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, role, content, timestamp
       FROM conversation_history
       WHERE channel_id = $1 
         AND timestamp > NOW() - INTERVAL '${maxAgeHours} hours'
       ORDER BY timestamp DESC
       LIMIT $2`,
      [channelId, limit]
    );
    return rows.reverse(); // Return in chronological order
  } catch (error) {
    console.error('Failed to get conversation history:', error);
    return [];
  }
}

export async function cleanOldConversations(daysOld = 7) {
  try {
    const result = await pool.query(
      `DELETE FROM conversation_history 
       WHERE timestamp < NOW() - INTERVAL '${daysOld} days'`
    );
    console.log(`Cleaned ${result.rowCount} old conversation messages`);
  } catch (error) {
    console.error('Failed to clean old conversations:', error);
  }
}

// ---------- User Profile Functions ----------
export async function updateUserProfile({ userId, ageRange, genderLikely, interests, traits, flirtyLevel }) {
  try {
    await pool.query(
      `INSERT INTO user_profiles (user_id, age_range, gender_likely, interests, traits, flirty_level, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         age_range = COALESCE($2, user_profiles.age_range),
         gender_likely = COALESCE($3, user_profiles.gender_likely),
         interests = COALESCE($4, user_profiles.interests),
         traits = COALESCE($5, user_profiles.traits),
         flirty_level = COALESCE($6, user_profiles.flirty_level),
         updated_at = NOW(),
         last_analyzed = NOW()`,
      [
        userId, 
        ageRange, 
        genderLikely, 
        JSON.stringify(interests), 
        JSON.stringify(traits), 
        flirtyLevel
      ]
    );
  } catch (error) {
    console.error('Failed to update user profile:', error);
  }
}

export async function getUserProfile(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, age_range, gender_likely, interests, traits, flirty_level, last_analyzed
       FROM user_profiles
       WHERE user_id = $1`,
      [userId]
    );
    
    if (rows.length === 0) return null;
    
    const profile = rows[0];
    return {
      ...profile,
      interests: profile.interests || [],
      traits: profile.traits || [],
      flirty_level: parseFloat(profile.flirty_level) || 0
    };
  } catch (error) {
    console.error('Failed to get user profile:', error);
    return null;
  }
}

export async function incrementFlirtyLevel(userId, increment = 0.1) {
  try {
    await pool.query(
      `UPDATE user_profiles 
       SET flirty_level = LEAST(flirty_level + $2, 1.0),
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, increment]
    );
  } catch (error) {
    console.error('Failed to increment flirty level:', error);
  }
}

// ---------- Channel Activity Functions ----------
export async function updateChannelActivity(channelId, guildId = null) {
  try {
    await pool.query(
      `INSERT INTO channel_activity (channel_id, guild_id, last_activity)
       VALUES ($1, $2, NOW())
       ON CONFLICT (channel_id)
       DO UPDATE SET 
         last_activity = NOW(),
         guild_id = COALESCE($2, channel_activity.guild_id)`,
      [channelId, guildId]
    );
  } catch (error) {
    console.error('Failed to update channel activity:', error);
  }
}

export async function getInactiveChannels(inactiveHours = 12) {
  try {
    const { rows } = await pool.query(
      `SELECT channel_id, guild_id, last_activity, last_auto_starter
       FROM channel_activity
       WHERE last_activity < NOW() - INTERVAL '${inactiveHours} hours'
         AND (last_auto_starter IS NULL OR last_auto_starter < NOW() - INTERVAL '${inactiveHours} hours')`
    );
    return rows;
  } catch (error) {
    console.error('Failed to get inactive channels:', error);
    return [];
  }
}

export async function recordAutoStarter(channelId) {
  try {
    await pool.query(
      `UPDATE channel_activity 
       SET last_auto_starter = NOW(),
           auto_starters_sent = auto_starters_sent + 1
       WHERE channel_id = $1`,
      [channelId]
    );
  } catch (error) {
    console.error('Failed to record auto starter:', error);
  }
}

// ---------- Conversation Starter Functions ----------
export async function saveConversationStarter({ content, category = 'tech', rating = 3 }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO conversation_starters (content, topic_category, success_rating)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [content, category, rating]
    );
    return rows[0].id;
  } catch (error) {
    console.error('Failed to save conversation starter:', error);
    return null;
  }
}

export async function getRandomStarter(category = 'tech', minRating = 3) {
  try {
    const { rows } = await pool.query(
      `SELECT id, content, success_rating, times_used
       FROM conversation_starters
       WHERE topic_category = $1 
         AND success_rating >= $2
       ORDER BY 
         (success_rating * 0.7 + (5 - LEAST(times_used, 5)) * 0.3) DESC,
         RANDOM()
       LIMIT 1`,
      [category, minRating]
    );
    return rows[0] || null;
  } catch (error) {
    console.error('Failed to get random starter:', error);
    return null;
  }
}

export async function recordStarterUsage(starterId) {
  try {
    await pool.query(
      `UPDATE conversation_starters
       SET times_used = times_used + 1,
           last_used = NOW()
       WHERE id = $1`,
      [starterId]
    );
  } catch (error) {
    console.error('Failed to record starter usage:', error);
  }
}

export async function trackStarterEngagement({ starterId, channelId, responsesCount = 0, avgResponseTime = null, conversationLength = 0 }) {
  try {
    await pool.query(
      `INSERT INTO starter_engagement (starter_id, channel_id, responses_count, avg_response_time_minutes, conversation_length)
       VALUES ($1, $2, $3, $4, $5)`,
      [starterId, channelId, responsesCount, avgResponseTime, conversationLength]
    );
  } catch (error) {
    console.error('Failed to track starter engagement:', error);
  }
}

// ---------- Analytics Functions ----------
export async function getChannelStats(channelId, days = 7) {
  try {
    const { rows } = await pool.query(
      `SELECT 
         COUNT(*) as total_messages,
         COUNT(DISTINCT user_id) as unique_users,
         AVG(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as user_message_ratio
       FROM conversation_history
       WHERE channel_id = $1 
         AND timestamp > NOW() - INTERVAL '${days} days'`,
      [channelId]
    );
    return rows[0];
  } catch (error) {
    console.error('Failed to get channel stats:', error);
    return { total_messages: 0, unique_users: 0, user_message_ratio: 0 };
  }
}

export async function getUserEngagementStats(userId, days = 30) {
  try {
    const { rows } = await pool.query(
      `SELECT 
         COUNT(*) as message_count,
         COUNT(DISTINCT channel_id) as channels_active,
         MIN(timestamp) as first_message,
         MAX(timestamp) as last_message
       FROM conversation_history
       WHERE user_id = $1 
         AND timestamp > NOW() - INTERVAL '${days} days'
         AND role = 'user'`,
      [userId]
    );
    return rows[0];
  } catch (error) {
    console.error('Failed to get user engagement stats:', error);
    return { message_count: 0, channels_active: 0, first_message: null, last_message: null };
  }
}

// ---------- Cleanup Functions ----------
export async function runDailyCleanup() {
  try {
    // Clean old conversation history (keep 30 days)
    await cleanOldConversations(30);
    
    // Clean old starter engagement data (keep 90 days)
    await pool.query(`
      DELETE FROM starter_engagement 
      WHERE sent_at < NOW() - INTERVAL '90 days'
    `);
    
    // Reset flirty levels that haven't been updated in 30 days (gradual decay)
    await pool.query(`
      UPDATE user_profiles 
      SET flirty_level = GREATEST(flirty_level * 0.9, 0),
          updated_at = NOW()
      WHERE last_analyzed < NOW() - INTERVAL '30 days'
        AND flirty_level > 0
    `);
    
    console.log('Daily cleanup completed successfully');
  } catch (error) {
    console.error('Daily cleanup failed:', error);
  }
}

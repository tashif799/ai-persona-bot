// bot.js — moderation-only + robust profiling (no auto-starters, no chat-joins)

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  PermissionsBitField,
} from 'discord.js';
import OpenAI from 'openai';
import fs from 'node:fs/promises'; // <-- added for DM storage

// --- db funcs used for moderation + profiling + reports ---
import {
  logModerationEvent,
  getRecentIncidents,
  getUserBehaviorSummary,
  getTopSuspects,
  runDailyCleanup,
  // profiling storage
  updateUserProfile,
  getUserProfile,
  rememberUserQuirk,
  // optional: message log (kept ON for profiling context/history if you want)
  saveConversationMessage,
} from './db.js';

// ---------- setup ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

const OWNER_ID = process.env.OWNER_ID?.trim();
const MOD_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID;

// ---------- moderation state ----------
const strikes = new Map();
const STRIKE_LIMITS = { warn: 1, timeout: 2, kick: 3, ban: 4 };
const STRIKE_DECAY_MS = 1000 * 60 * 60 * 24 * 7;
const DISABLED_GUILDS = new Set();
const shadowBanned = new Set();
const messageHistory = new Map();
const recentJoins = [];
const lastToneReply = new Map();
const TONE_COOLDOWN_MS = 5000;

// escalating timeouts
const userModerationState = new Map(); // userId -> { warningCount, lastIncident, timeoutUntil, pattern }

// ---------- ONE-TIME DM BROADCAST (display-name personalization) ----------
const DM_ONCE_PATH = './data/dm_once.json';
let dmOnceStore = { guilds: {} };

async function loadDmOnce() {
  try {
    await fs.mkdir('./data', { recursive: true });
    const raw = await fs.readFile(DM_ONCE_PATH, 'utf8').catch(() => '{}');
    const parsed = JSON.parse(raw || '{}');
    dmOnceStore = { guilds: parsed.guilds || {} };
  } catch (e) { console.error('loadDmOnce failed:', e); }
}
async function saveDmOnce() {
  try { await fs.writeFile(DM_ONCE_PATH, JSON.stringify(dmOnceStore, null, 2), 'utf8'); }
  catch (e) { console.error('saveDmOnce failed:', e); }
}
function alreadySentOnce(guildId, userId) {
  return Boolean(dmOnceStore.guilds?.[guildId]?.sentTo?.[userId]);
}
function markSentOnce(guildId, userId) {
  if (!dmOnceStore.guilds[guildId]) dmOnceStore.guilds[guildId] = { sentTo: {}, runs: [] };
  dmOnceStore.guilds[guildId].sentTo[userId] = Date.now();
}

// ---------- helpers ----------
function decayStrikes(userId) {
  const entry = strikes.get(userId);
  if (!entry) return 0;
  const { count, lastStrike } = entry;
  if (Date.now() - lastStrike > STRIKE_DECAY_MS) {
    strikes.delete(userId);
    return 0;
  }
  return count;
}

async function logEvidence(guild, msg, reason, action) {
  if (!MOD_LOG_CHANNEL_ID) return;
  try {
    const chan = await guild.channels.fetch(MOD_LOG_CHANNEL_ID);
    if (!chan) return;
    await chan.send({
      embeds: [
        {
          title: `Moderation Action: ${action}`,
          description: `**User:** ${msg.author.tag} (${msg.author.id})\n**Reason:** ${reason}`,
          fields: [{ name: 'Message', value: msg.content || '(no content)' }],
          timestamp: new Date().toISOString(),
        },
      ],
    });
  } catch (e) {
    console.error('Failed to log evidence:', e);
  }
}

async function recordLog(msg, { harassment=false, hate=false, violence=false, tone={}, action='none' } = {}) {
  const { passive_aggressive=false, condescending=false, provocation=false, toxicity='none' } = tone || {};
  try {
    await logModerationEvent({
      guildId: msg.guildId,
      channelId: msg.channelId,
      userId: msg.author.id,
      messageId: msg.id,
      content: msg.content || '',
      harassment, hate, violence,
      passive_aggr: passive_aggressive,
      condescending,
      provocation,
      toxicity,
      action_taken: action
    });
  } catch (e) {
    console.error('logModerationEvent failed:', e);
  }
}

async function escalate(msg, reason) {
  const id = msg.author.id;
  const prev = decayStrikes(id);
  const count = prev + 1;
  strikes.set(id, { count, lastStrike: Date.now() });

  let action = 'none';
  if (count === STRIKE_LIMITS.warn) {
    action = 'warn';
    await msg.reply(`⚠️ ${msg.author}, warning: ${reason}`);
    await logEvidence(msg.guild, msg, reason, 'Warn');
  } else if (count === STRIKE_LIMITS.timeout) {
    action = 'timeout';
    await msg.member.timeout(10 * 60 * 1000, reason);
    await msg.reply('⏳ Timed out for 10m.');
    await logEvidence(msg.guild, msg, reason, 'Timeout');
  } else if (count === STRIKE_LIMITS.kick) {
    action = 'kick';
    await msg.member.kick(reason);
    await msg.channel.send(`${msg.author.tag} was kicked.`);
    await logEvidence(msg.guild, msg, reason, 'Kick');
  } else if (count >= STRIKE_LIMITS.ban) {
    action = 'ban';
    await msg.member.ban({ reason });
    await msg.channel.send(`${msg.author.tag} was banned.`);
    await logEvidence(msg.guild, msg, reason, 'Ban');
  }

  await recordLog(msg, { action });
  return action;
}

function normalizeForRepeat(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasCopypastaInSingleMessage(text) {
  if (!text) return false;
  if (text.replace(/\s+/g, ' ').trim().length < 30) return false;

  const rawLines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (rawLines.length >= 3) {
    const lineCounts = new Map();
    for (const l of rawLines) {
      const k = normalizeForRepeat(l);
      if (k.length < 20) continue;
      lineCounts.set(k, (lineCounts.get(k) || 0) + 1);
    }
    if ([...lineCounts.values()].some(c => c >= 3)) return true;
  }

  const sentences = normalizeForRepeat(text).split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length >= 3) {
    const sentCounts = new Map();
    for (const s of sentences) {
      if (s.length < 20) continue;
      sentCounts.set(s, (sentCounts.get(s) || 0) + 1);
    }
    if ([...sentCounts.values()].some(c => c >= 3)) return true;
  }

  const t = normalizeForRepeat(text);
  if (t.length >= 120) {
    const window = 60;
    const step = 20;
    const seen = new Map();
    for (let i = 0; i + window <= t.length; i += step) {
      const chunk = t.slice(i, i + window);
      seen.set(chunk, (seen.get(chunk) || 0) + 1);
    }
    if ([...seen.values()].some(c => c >= 3)) return true;
  }
  return false;
}

function countEmojis(text) {
  const emojiRegex = /[\u{1F1E6}-\u{1FAFF}\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE0F}]/gu;
  const m = (text || '').match(emojiRegex);
  return m ? m.length : 0;
}

async function deleteRecentDuplicates(msg, normalizedTarget, scanLimit = 50, maxAgeMs = 10 * 60 * 1000) {
  try {
    const fetched = await msg.channel.messages.fetch({ limit: scanLimit });
    const now = Date.now();
    const targets = fetched.filter(m =>
      m.author?.id === msg.author.id &&
      normalizeForRepeat(m.content) === normalizedTarget &&
      (now - m.createdTimestamp) <= maxAgeMs
    );
    for (const m of targets.values()) {
      await m.delete().catch(() => {});
    }
    await recordLog(msg, { action: 'delete' });
  } catch (e) {
    console.error('deleteRecentDuplicates error:', e);
  }
}

// ---------- tone classifier & callout ----------
async function classifyBehavior(text) {
  if (!text || !text.trim()) {
    return { passive_aggressive: false, condescending: false, provocation: false, toxicity: 'none' };
  }
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
`You label chat messages for moderation tone. Output strict JSON with keys:
- passive_aggressive: boolean
- condescending: boolean  (talking down, superiority/flexing/"big-dicking")
- provocation: boolean    (baiting/escalating)
- toxicity: "none"|"low"|"medium"|"high"
No extra text.`
      },
      { role: 'user', content: text }
    ]
  });
  try {
    return JSON.parse(resp.choices[0].message.content);
  } catch {
    return { passive_aggressive: false, condescending: false, provocation: false, toxicity: 'none' };
  }
}

async function generateContextualCallout(message, tone, userHistory) {
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: `You're a witty Discord moderator bot for a software dev community. Generate a brief, clever response.

TONE:
- passive_aggressive: ${tone.passive_aggressive}
- condescending: ${tone.condescending}
- provocation: ${tone.provocation}
- toxicity: ${tone.toxicity}

USER:
- Previous warnings: ${userHistory.warningCount || 0}
- Pattern: ${userHistory.pattern || 'first incident'}

STYLE:
- < 100 chars
- Witty, not mean
- 0–2 emojis max
- Firmer for repeats
- High toxicity: suggest a break`
        },
        { role: 'user', content: `Message: "${message}"\nGenerate one callout.` }
      ]
    });
    return resp.choices[0].message.content.trim();
  } catch (e) {
    console.error('Failed to generate contextual callout:', e);
    if (tone.toxicity === 'high') return '🛑 That crossed a line. Take a breather.';
    if (tone.condescending) return '🪜 Step down from the high horse—talk to people, not at them.';
    if (tone.passive_aggressive) return '😏 Let’s skip the passive-aggressive and be direct.';
    if (tone.provocation) return '🧯 No flamebait. Keep it constructive.';
    return '⚠️ Keep it professional and helpful.';
  }
}

function getUserModerationHistory(userId) {
  const existing = userModerationState.get(userId) || {
    warningCount: 0,
    lastIncident: 0,
    timeoutUntil: 0,
    pattern: 'first incident'
  };
  const days = (Date.now() - existing.lastIncident) / (1000 * 60 * 60 * 24);
  if (days > 7) {
    existing.warningCount = 0;
    existing.pattern = 'clean slate';
  }
  return existing;
}

function updateModerationHistory(userId, toneIssues) {
  const history = getUserModerationHistory(userId);
  history.warningCount += 1;
  history.lastIncident = Date.now();

  if (history.warningCount === 1) history.pattern = 'first incident';
  else if (history.warningCount <= 3) history.pattern = 'repeat behavior';
  else history.pattern = 'chronic issue';

  if (toneIssues.toxicity === 'high' || history.warningCount >= 4) {
    const timeoutMinutes = Math.min(history.warningCount * 10, 60);
    history.timeoutUntil = Date.now() + (timeoutMinutes * 60 * 1000);
  }

  userModerationState.set(userId, history);
  return history;
}

function isUserInTimeout(userId) {
  const history = getUserModerationHistory(userId);
  return Date.now() < history.timeoutUntil;
}

// ---------- ROBUST PROFILING ----------
/**
 * Robust, structured, *non-clinical* behavioral profiling.
 * - Avoids medical/diagnostic claims. No protected-class inferences beyond coarse age/gender likelihood with low confidence.
 * - Aggregates over time (EWMA) so one message doesn't dominate.
 */
function ewma(prev, next, alpha = 0.3) {
  if (prev == null) return next;
  return (1 - alpha) * prev + alpha * next;
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

async function robustAnalyzeUserProfile(text, userId) {
  if (!text || !text.trim()) return;

  // 1) Ask LLM for structured analysis
  let analysis;
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
`You are a cautious behavioral analyst. Produce *non-clinical* inferences only.
Return STRICT JSON with keys:
- age_range: "under_18"|"18_25"|"26_35"|"35_plus"|"unknown"
- age_confidence: number 0..1
- gender_likely: "male"|"female"|"non_binary"|"unknown"
- gender_confidence: number 0..1
- interests: string[]  (max 8 topical interests inferred from message content)
- personality_traits: string[]  (concise, non-clinical, e.g., "dry humor","direct","detail-oriented","risk-taking")
- big5: { O:number, C:number, E:number, A:number, N:number }   // 0..1 likelihoods inferred from writing cues
- communication_style: {
    directness: 0..1, formality: 0..1, sarcasm: 0..1, humor: 0..1,
    assertiveness: 0..1, empathy: 0..1, profanity: 0..1, emoji_use: 0..1
  }
- skill_estimates: { programming_level: "novice"|"intermediate"|"advanced"|"unknown", domains: string[] }
- risk_flags: { trollish:0..1, brigading:0..1, spammy:0..1, conflict_prone:0..1 }
- flirty_appropriate: boolean  // only if clearly adult + tone suggests comfort
- confidence_overall: 0..1
Rules:
- Be conservative; prefer "unknown" and lower confidences if unsure.
- Do NOT include clinical labels or diagnoses.
- Do NOT include protected attributes (race, religion, etc.).
- Output JSON only.`
        },
        { role: 'user', content: text }
      ]
    });
    analysis = JSON.parse(resp.choices[0].message.content);
  } catch (e) {
    console.error('robustAnalyzeUserProfile: LLM failed', e);
    return;
  }

  // 2) Load existing profile and merge (light EWMA smoothing for scores)
  const existing = (await getUserProfile(userId)) || {};

  const mergedBig5 = {
    O: clamp01(ewma(existing.big5?.O, analysis.big5?.O ?? null)),
    C: clamp01(ewma(existing.big5?.C, analysis.big5?.C ?? null)),
    E: clamp01(ewma(existing.big5?.E, analysis.big5?.E ?? null)),
    A: clamp01(ewma(existing.big5?.A, analysis.big5?.A ?? null)),
    N: clamp01(ewma(existing.big5?.N, analysis.big5?.N ?? null)),
  };

  const mergedComm = {
    directness: clamp01(ewma(existing.communication_style?.directness, analysis.communication_style?.directness ?? null)),
    formality: clamp01(ewma(existing.communication_style?.formality, analysis.communication_style?.formality ?? null)),
    sarcasm: clamp01(ewma(existing.communication_style?.sarcasm, analysis.communication_style?.sarcasm ?? null)),
    humor: clamp01(ewma(existing.communication_style?.humor, analysis.communication_style?.humor ?? null)),
    assertiveness: clamp01(ewma(existing.communication_style?.assertiveness, analysis.communication_style?.assertiveness ?? null)),
    empathy: clamp01(ewma(existing.communication_style?.empathy, analysis.communication_style?.empathy ?? null)),
    profanity: clamp01(ewma(existing.communication_style?.profanity, analysis.communication_style?.profanity ?? null)),
    emoji_use: clamp01(ewma(existing.communication_style?.emoji_use, analysis.communication_style?.emoji_use ?? null)),
  };

  const mergedRisk = {
    trollish: clamp01(ewma(existing.risk_flags?.trollish, analysis.risk_flags?.trollish ?? null)),
    brigading: clamp01(ewma(existing.risk_flags?.brigading, analysis.risk_flags?.brigading ?? null)),
    spammy: clamp01(ewma(existing.risk_flags?.spammy, analysis.risk_flags?.spammy ?? null)),
    conflict_prone: clamp01(ewma(existing.risk_flags?.conflict_prone, analysis.risk_flags?.conflict_prone ?? null)),
  };

  const mergedInterests = Array.from(new Set([...(existing.interests || []), ...(analysis.interests || [])])).slice(0, 20);
  const mergedTraits = Array.from(new Set([...(existing.traits || []), ...(analysis.personality_traits || [])])).slice(0, 20);

  // flirty level smoothing (store as 0..1)
  let flirtyLevel = existing.flirty_level || 0;
  if (analysis.flirty_appropriate && (analysis.age_range === '18_25' || analysis.age_range === '26_35' || analysis.age_range === '35_plus')) {
    flirtyLevel = clamp01(flirtyLevel + 0.1);
  } else {
    // gentle decay
    flirtyLevel = clamp01(flirtyLevel * 0.98);
  }

  // 3) Persist
  try {
    await updateUserProfile({
      userId,
      // keep legacy fields so existing dashboards continue to work
      ageRange: analysis.age_range,
      genderLikely: analysis.gender_likely,
      interests: mergedInterests,
      traits: mergedTraits,
      flirtyLevel,

      // extended structured fields
      big5: mergedBig5,
      communication_style: mergedComm,
      risk_flags: mergedRisk,
      skill_estimates: analysis.skill_estimates || { programming_level: 'unknown', domains: [] },
      age_confidence: analysis.age_confidence ?? 0,
      gender_confidence: analysis.gender_confidence ?? 0,
      confidence_overall: analysis.confidence_overall ?? 0,
      last_observed_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('updateUserProfile failed:', e);
  }

  // 4) Store a memorable quirk (small, human-readable breadcrumb)
  try {
    const highlights = [];
    if (mergedTraits.length) highlights.push(`Traits: ${mergedTraits.slice(0,3).join(', ')}`);
    if (mergedInterests.length) highlights.push(`Interests: ${mergedInterests.slice(0,3).join(', ')}`);
    if (analysis.skill_estimates?.programming_level && analysis.skill_estimates.programming_level !== 'unknown') {
      highlights.push(`Skill: ${analysis.skill_estimates.programming_level}`);
    }
    if (highlights.length) await rememberUserQuirk(userId, highlights.join(' | '));
  } catch (e) {
    console.error('rememberUserQuirk failed:', e);
  }
}

// ---------- moderation core ----------
async function handleModeration(msg) {
  if (DISABLED_GUILDS.has(msg.guildId)) return;
  if (shadowBanned.has(msg.author.id)) {
    await msg.delete().catch(() => {});
    return;
  }

  // (Optional) store message to DB for your own convo history analytics
  try {
    await saveConversationMessage({
      channelId: msg.channelId,
      guildId: msg.guildId,
      userId: msg.author.id,
      role: 'user',
      content: msg.content
    });
  } catch (e) {
    // non-fatal
  }

  // basic spam window
  const history = messageHistory.get(msg.channelId) || [];
  history.push({ text: msg.content, time: Date.now(), user: msg.author.id });
  if (history.length > 10) history.shift();
  messageHistory.set(msg.channelId, history);

  // 5 msgs in <5s
  const userMsgs = history.filter((h) => h.user === msg.author.id);
  if (userMsgs.length >= 5 && Date.now() - userMsgs[0].time < 5000) {
    await escalate(msg, 'Spam (too many messages)');
    await msg.delete().catch(() => {});
    await recordLog(msg, { action: 'delete' });
    return;
  }

  // single-message copypasta
  if (hasCopypastaInSingleMessage(msg.content)) {
    await escalate(msg, 'Spam (copypasta in single message)');
    await msg.delete().catch(() => {});
    await recordLog(msg, { action: 'delete' });
    return;
  }

  // repeated duplicate messages
  const normalizedBatch = userMsgs.map((h) => normalizeForRepeat(h.text));
  if (normalizedBatch.length >= 3) {
    const first = normalizedBatch[0];
    const allSame = normalizedBatch.every(x => x === first) && first.length >= 20;
    if (allSame) {
      await escalate(msg, 'Spam (duplicate copypasta)');
      await deleteRecentDuplicates(msg, first, 50, 10 * 60 * 1000);
      return;
    }
  }

  // emoji flood
  if (countEmojis(msg.content) >= 12) {
    await escalate(msg, 'Spam (emoji flood)');
    await msg.delete().catch(() => {});
    await recordLog(msg, { action: 'delete' });
    return;
  }

  // OpenAI moderation categories
  const modRes = await openai.moderations.create({
    model: 'omni-moderation-latest',
    input: msg.content,
  });
  const flagged = modRes.results[0];
  if (flagged.flagged) {
    if (flagged.categories.harassment) {
      await escalate(msg, 'Harassment');
    } else if (flagged.categories.hate || flagged.categories.violence) {
      await escalate(msg, 'Severe hate/violence');
    }
  }

  // Tone analysis & witty callouts
  const tone = await classifyBehavior(msg.content);

  // active timeout => auto delete
  if (isUserInTimeout(msg.author.id)) {
    await msg.delete().catch(() => {});
    return;
  }

  const hasToneIssues =
    tone.passive_aggressive || tone.condescending || tone.provocation || tone.toxicity !== 'none';

  if (hasToneIssues) {
    const now = Date.now();
    const lastReply = lastToneReply.get(msg.author.id) || 0;

    const userHistory = getUserModerationHistory(msg.author.id);
    const cooldownMs = userHistory.warningCount > 2 ? 3000 : TONE_COOLDOWN_MS;

    if (now - lastReply >= cooldownMs) {
      const calloutResponse = await generateContextualCallout(msg.content, tone, userHistory);
      await msg.reply(calloutResponse);
      lastToneReply.set(msg.author.id, now);

      // escalate history + potential timeout
      const updated = updateModerationHistory(msg.author.id, tone);
      if (updated.timeoutUntil > Date.now()) {
        const timeoutMinutes = Math.ceil((updated.timeoutUntil - Date.now()) / (1000 * 60));
        try {
          await msg.member.timeout(timeoutMinutes * 60 * 1000, 'Escalating behavioral issues');
          await msg.reply(`🕐 Taking a ${timeoutMinutes}-minute break to cool down.`);
        } catch (e) {
          console.error('Failed to timeout user:', e);
        }
      }
    }
  }

  if (tone.toxicity === 'high' || (tone.toxicity === 'medium' && (tone.condescending || tone.provocation))) {
    await escalate(msg, `Hostile tone (${tone.toxicity})`);
  }

  if (/stupid bot|fuck you/i.test(msg.content)) {
    await escalate(msg, 'Insulting the bot');
  }

  await recordLog(msg, {
    harassment: !!flagged?.categories?.harassment,
    hate: !!flagged?.categories?.hate,
    violence: !!flagged?.categories?.violence,
    tone: {
      passive_aggressive: !!tone.passive_aggressive,
      condescending: !!tone.condescending,
      provocation: !!tone.provocation,
      toxicity: tone.toxicity || 'none'
    },
    action: 'none'
  });

  // Lightweight profiling (AFTER moderation so failures don't block mod)
  try {
    await robustAnalyzeUserProfile(msg.content, msg.author.id);
  } catch (e) {
    console.error('profiling pipeline error (non-fatal):', e);
  }

  // Placeholder: image evidence
  for (const att of msg.attachments.values()) {
    if (att.contentType?.startsWith('image/')) {
      await logEvidence(msg.guild, msg, 'Image posted (placeholder check)', 'ImageLog');
    }
  }
}

// ---------- optional: auto-threads for long replies (kept ON) ----------
async function handleAutoThreads(msg) {
  if (!msg.reference) return;
  const refMsg = await msg.fetchReference().catch(() => null);
  if (!refMsg) return;
  const replies = await msg.channel.messages.fetch({ after: refMsg.id });
  const count = replies.filter(r => r.reference?.messageId === refMsg.id).size;
  if (count >= 20 && !refMsg.hasThread) {
    const thread = await refMsg.startThread({
      name: `Topic by ${refMsg.author.username}`,
      autoArchiveDuration: 60,
    });
    await thread.send('📌 Moving this long convo into a thread!');
  }
}

// ---------- community voting enforcement ----------
client.on(Events.MessageReactionAdd, async (reaction) => {
  if (reaction.emoji.name !== '🚫') return;
  const msg = reaction.message;
  if (!msg.guild) return;
  await msg.fetch();
  if (reaction.count >= 3) {
    await escalate(msg, 'Community voted 🚫');
    await msg.delete().catch(() => {});
    await recordLog(msg, { action: 'delete' });
  }
});

// ---------- anti-raid ----------
client.on(Events.GuildMemberAdd, (member) => {
  recentJoins.push(Date.now());
  while (recentJoins.length && Date.now() - recentJoins[0] > 60000) {
    recentJoins.shift();
  }
  if (recentJoins.length >= 5) {
    const everyoneRole = member.guild.roles.everyone;
    member.guild.channels.cache.forEach((ch) => {
      if (ch.permissionsFor(everyoneRole)?.has(PermissionsBitField.Flags.SendMessages)) {
        ch.permissionOverwrites.edit(everyoneRole, { SendMessages: false });
      }
    });
    member.guild.systemChannel?.send('🚨 Anti-raid mode activated: chat locked.');
  }
});

// ---------- admin commands ----------
client.on(Events.MessageCreate, async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  const isOwner = msg.author.id === OWNER_ID;

  if (isOwner) {
    if (msg.content.startsWith('!forgive')) {
      const target = msg.mentions.users.first();
      if (target) {
        strikes.delete(target.id);
        await msg.reply(`🙏 Forgiven ${target.username}.`);
      }
    }

    if (msg.content === '!disablemod') {
      DISABLED_GUILDS.add(msg.guildId);
      await msg.reply('🚫 Moderator disabled here.');
    }

    if (msg.content === '!enablemod') {
      DISABLED_GUILDS.delete(msg.guildId);
      await msg.reply('✅ Moderator enabled here.');
    }

    if (msg.content.startsWith('!shadowban')) {
      const target = msg.mentions.users.first();
      if (target) {
        shadowBanned.add(target.id);
        await msg.reply(`👻 Shadowbanned ${target.username}.`);
      }
    }

    if (msg.content.startsWith('!unshadowban')) {
      const target = msg.mentions.users.first();
      if (target) {
        shadowBanned.delete(target.id);
        await msg.reply(`🌞 Un-shadowbanned ${target.username}.`);
      }
    }

    // Enhanced profile inspection (pretty view)
    if (msg.content.startsWith('!profile')) {
      const target = msg.mentions.users.first();
      if (target) {
        const p = await getUserProfile(target.id);
        if (p) {
          const big = p.big5 ? `O:${(p.big5.O??0).toFixed(2)} C:${(p.big5.C??0).toFixed(2)} E:${(p.big5.E??0).toFixed(2)} A:${(p.big5.A??0).toFixed(2)} N:${(p.big5.N??0).toFixed(2)}` : 'n/a';
          const comm = p.communication_style ? [
            `direct:${(p.communication_style.directness??0).toFixed(2)}`,
            `sarcasm:${(p.communication_style.sarcasm??0).toFixed(2)}`,
            `humor:${(p.communication_style.humor??0).toFixed(2)}`,
            `assert:${(p.communication_style.assertiveness??0).toFixed(2)}`,
          ].join(' • ') : 'n/a';
          const risk = p.risk_flags ? [
            `troll:${(p.risk_flags.trollish??0).toFixed(2)}`,
            `brigade:${(p.risk_flags.brigading??0).toFixed(2)}`,
            `spam:${(p.risk_flags.spammy??0).toFixed(2)}`,
            `conflict:${(p.risk_flags.conflict_prone??0).toFixed(2)}`,
          ].join(' • ') : 'n/a';
          const skill = p.skill_estimates?.programming_level || 'unknown';
          await msg.reply(
            `👤 Profile for <@${target.id}>:\n` +
            `• Age: ${p.age_range || 'unknown'} (${((p.age_confidence??0)*100).toFixed(0)}% conf)\n` +
            `• Gender: ${p.gender_likely || 'unknown'} (${((p.gender_confidence??0)*100).toFixed(0)}% conf)\n` +
            `• Big5: ${big}\n` +
            `• Comms: ${comm}\n` +
            `• Risk: ${risk}\n` +
            `• Skill: ${skill}\n` +
            `• Interests: ${(p.interests||[]).slice(0,6).join(', ') || '—'}\n` +
            `• Traits: ${(p.traits||[]).slice(0,6).join(', ') || '—'}\n` +
            `• Flirty level: ${Math.round((p.flirty_level||0)*10)}/10\n` +
            `• Confidence overall: ${((p.confidence_overall??0)*100).toFixed(0)}%\n` +
            `• Last observed: ${p.last_observed_at || '—'}\n` +
            `_Note: heuristic, non-clinical signals only._`
          );
        } else {
          await msg.reply(`No profile data for <@${target.id}> yet.`);
        }
      }
    }

    // Raw JSON (owner-only; dev/debug)
    if (msg.content.startsWith('!profilejson')) {
      const target = msg.mentions.users.first();
      if (target) {
        const p = await getUserProfile(target.id);
        await msg.reply('```json\n' + JSON.stringify(p || {}, null, 2) + '\n```');
      }
    }

    // --- ONE-TIME DM EVERYONE (display-name personalization) ---
    // Usage: !dmallonce Your message here with {display} and {server}
    if (msg.content.startsWith('!dmallonce ')) {
      const baseMsg = msg.content.replace(/^!dmallonce\s+/, '').trim();
      if (!baseMsg) return msg.reply('Usage: `!dmallonce <message>`');

      await msg.reply('🕊️ Starting one-time DM broadcast. I’ll go slow to respect limits.');

      // Ensure full member list
      const members = await msg.guild.members.fetch().catch(() => null);
      if (!members) return msg.reply('❌ Could not fetch members.');

      const humans = members.filter(m => !m.user.bot);
      const results = { attempted: 0, sent: 0, skipped_existing: 0, failed: 0, cannot_dm: 0 };

      for (const m of humans.values()) {
        // skip if already sent previously
        if (alreadySentOnce(msg.guildId, m.user.id)) {
          results.skipped_existing++;
          continue;
        }

        // Personalize with display name (nickname if set, else global/username)
        const display = m.displayName || m.user.globalName || m.user.username;
        const personalized = baseMsg
          .replaceAll('{display}', display)
          .replaceAll('{server}', msg.guild.name);

        try {
          await m.send(personalized + '\n\n—\n(This is a one-time personal invite from the server admin.)');
          markSentOnce(msg.guildId, m.user.id);
          results.sent++;
        } catch (e) {
          results.failed++;
          if (e?.code === 50007) results.cannot_dm++; // user has DMs closed or blocked bot
        }

        results.attempted++;
        if (results.attempted % 25 === 0) {
          await msg.channel.send(`Progress: sent ${results.sent}, failed ${results.failed}, skipped ${results.skipped_existing}…`);
        }

        // gentle pacing to avoid spikes
        await new Promise(r => setTimeout(r, 1100));
      }

      // record run
      if (!dmOnceStore.guilds[msg.guildId]) dmOnceStore.guilds[msg.guildId] = { sentTo: {}, runs: [] };
      dmOnceStore.guilds[msg.guildId].runs.push({ at: Date.now(), results });
      await saveDmOnce();

      const summary =
        `✅ Done.\n• Sent: ${results.sent}\n• Failed: ${results.failed} (closed DMs: ${results.cannot_dm})\n• Skipped (already sent): ${results.skipped_existing}`;
      await msg.reply(summary);
      return;
    }

    // Reset the "already sent" map for this guild (use sparingly)
    // Usage: !dmallreset
    if (msg.content === '!dmallreset') {
      dmOnceStore.guilds[msg.guildId] = { sentTo: {}, runs: [] };
      await saveDmOnce();
      await msg.reply('♻️ Reset done. The bot will treat everyone as not-yet-messaged.');
      return;
    }

    // Run DB cleanup
    if (msg.content === '!cleanup') {
      await runDailyCleanup();
      await msg.reply('🧹 Database cleanup completed!');
    }

    // SUS reports
    if (msg.content.startsWith('!sus ')) {
      const m = msg.content.split(/\s+/);
      const target = msg.mentions.users.first();
      const hours = Number(m[m.length - 1]) || 24;
      if (!target) return msg.reply('Usage: `!sus @user [hours]`');
      const s = await getUserBehaviorSummary({ userId: target.id, hours });
      await msg.reply(
        `🕵️ Report for <@${target.id}> (last ${hours}h):\n` +
        `• incidents: ${s.total || 0}\n` +
        `• passive-aggr: ${s.passive_aggr || 0}\n` +
        `• condescending: ${s.condescending || 0}\n` +
        `• provocation: ${s.provocation || 0}\n` +
        `• actions taken: ${s.actions || 0}`
      );
      return;
    }

    if (msg.content.startsWith('!susrecent')) {
      const parts = msg.content.split(/\s+/);
      const hours = Number(parts[1]) || 24;
      const limit = Number(parts[2]) || 10;
      const rows = await getRecentIncidents({ guildId: msg.guildId, hours, limit });
      if (!rows.length) return msg.reply(`No incidents in last ${hours}h.`);
      const lines = rows.map(r =>
        `• <@${r.user_id}> ${r.action_taken || 'none'} ` +
        `${r.passive_aggr ? 'PA ' : ''}${r.condescending ? 'COND ' : ''}${r.provocation ? 'PROV ' : ''}`.trim()
      );
      await msg.reply(`🧾 Recent incidents (last ${hours}h):\n${lines.join('\n')}`);
      return;
    }

    if (msg.content.startsWith('!suswho')) {
      const parts = msg.content.split(/\s+/);
      const hours = Number(parts[1]) || 24;
      const limit = Number(parts[2]) || 5;
      const rows = await getTopSuspects({ guildId: msg.guildId, hours, limit });
      if (!rows.length) return msg.reply(`Clean slate in last ${hours}h.`);
      const lines = rows.map((r, i) =>
        `${i+1}. <@${r.user_id}> — actions: ${r.actions}, tone flags: ${r.tone_flags}, incidents: ${r.incidents}`
      );
      await msg.reply(`🏴 Top suspects (last ${hours}h):\n${lines.join('\n')}`);
      return;
    }
  }

  // ALWAYS run moderation & auto-threads (chatting is OFF)
  await handleModeration(msg);
  await handleAutoThreads(msg);
});

// ---------- startup ----------
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // load DM store after login
  await loadDmOnce();

  // Daily cleanup at ~3 AM server time
  const scheduleCleanup = () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(3, 0, 0, 0);
    const ms = tomorrow.getTime() - now.getTime();
    setTimeout(() => {
      runDailyCleanup();
      setInterval(runDailyCleanup, 24 * 60 * 60 * 1000);
    }, ms);
  };
  scheduleCleanup();

  // IMPORTANT: No auto-starter interval. No conversation join prompts. No mention-based chatting.
});

client.login(process.env.DISCORD_TOKEN);

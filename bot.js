import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  PermissionsBitField,
} from 'discord.js';
import OpenAI from 'openai';
import fs from 'node:fs/promises';
import { embed } from './embed.js';
import {
  rememberEmbedding,
  searchSimilar,
  rememberUserQuirk,
  getUserQuirks,
  logModerationEvent,
  getRecentIncidents,
  getUserBehaviorSummary,
  getTopSuspects,
} from './db.js';

// ---------- load persona ----------
let persona = JSON.parse(await fs.readFile('./persona/kmwyl.json', 'utf8'));

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
const PERSONA_ID = 'kmwyl';
const MOD_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID;

// ---------- new conversation & auto-starter state ----------
const conversationHistory = new Map(); // channelId -> array of {role, content, timestamp, userId}
const lastChannelActivity = new Map(); // channelId -> timestamp
const MAX_CONVERSATION_LENGTH = 20; // keep last 20 messages for context
const CONVERSATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const AUTO_STARTER_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours
const userProfiles = new Map(); // userId -> {age?, gender?, interests: [], flirtyLevel: number}

// ---------- moderation state (existing) ----------
const strikes = new Map();
const STRIKE_LIMITS = { warn: 1, timeout: 2, kick: 3, ban: 4 };
const STRIKE_DECAY_MS = 1000 * 60 * 60 * 24 * 7;
const DISABLED_GUILDS = new Set();
const shadowBanned = new Set();
const messageHistory = new Map();
const recentJoins = [];
const activeConvos = new Map();
const lastToneReply = new Map();
const TONE_COOLDOWN_MS = 5000;

// ---------- conversation memory helpers ----------
function addToConversationHistory(channelId, role, content, userId = null) {
  if (!conversationHistory.has(channelId)) {
    conversationHistory.set(channelId, []);
  }
  
  const history = conversationHistory.get(channelId);
  history.push({
    role,
    content,
    timestamp: Date.now(),
    userId
  });
  
  // Keep only recent messages
  if (history.length > MAX_CONVERSATION_LENGTH) {
    history.shift();
  }
  
  conversationHistory.set(channelId, history);
}

function getConversationContext(channelId) {
  const history = conversationHistory.get(channelId) || [];
  const now = Date.now();
  
  // Filter out old messages
  const recentHistory = history.filter(msg => 
    (now - msg.timestamp) < CONVERSATION_TIMEOUT_MS
  );
  
  // Convert to OpenAI format
  return recentHistory.map(msg => ({
    role: msg.role,
    content: msg.content
  }));
}

// ---------- user profiling & flirty behavior ----------
async function analyzeUserProfile(message, userId) {
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Analyze this message to infer user demographics and personality. Output JSON with:
- age_range: "under_18"|"18_25"|"26_35"|"35_plus"|"unknown"
- gender_likely: "male"|"female"|"non_binary"|"unknown"
- interests: array of interests mentioned/implied
- personality_traits: array of traits (witty, nerdy, casual, etc)
- flirty_appropriate: boolean (only true if clearly 18+ AND shows interest in flirty banter)
Base this on writing style, topics, slang, references, etc. Be conservative with age/gender assumptions.`
        },
        { role: 'user', content: message }
      ]
    });
    
    const analysis = JSON.parse(resp.choices[0].message.content);
    
    // Update user profile
    const existing = userProfiles.get(userId) || { interests: [], traits: [], flirtyLevel: 0 };
    
    existing.age_range = analysis.age_range;
    existing.gender_likely = analysis.gender_likely;
    existing.interests = [...new Set([...existing.interests, ...analysis.interests])];
    existing.traits = [...new Set([...existing.traits, ...analysis.personality_traits])];
    
    // Adjust flirty level based on appropriateness and interaction
    if (analysis.flirty_appropriate && (analysis.age_range === '18_25' || analysis.age_range === '26_35' || analysis.age_range === '35_plus')) {
      existing.flirtyLevel = Math.min(existing.flirtyLevel + 0.1, 1.0);
    }
    
    userProfiles.set(userId, existing);
    
    // Remember interesting traits
    if (analysis.personality_traits.length > 0) {
      await rememberUserQuirk(userId, `Traits: ${analysis.personality_traits.join(', ')}`);
    }
    
  } catch (e) {
    console.error('User profile analysis failed:', e);
  }
}

function getPersonalityModifier(userId) {
  const profile = userProfiles.get(userId);
  if (!profile) return '';
  
  let modifier = '';
  
  // Add flirty behavior for appropriate users
  if (profile.flirtyLevel > 0.3 && profile.age_range !== 'under_18' && profile.age_range !== 'unknown') {
    const flirtyLevel = Math.min(profile.flirtyLevel, 0.8); // Cap it
    modifier += `Be subtly flirty and charming (level: ${Math.round(flirtyLevel * 10)}/10). `;
  }
  
  // Adapt to interests
  if (profile.interests.length > 0) {
    modifier += `User interests: ${profile.interests.slice(0, 3).join(', ')}. `;
  }
  
  // Adapt to personality
  if (profile.traits.length > 0) {
    modifier += `User traits: ${profile.traits.slice(0, 3).join(', ')}. `;
  }
  
  return modifier;
}

// ---------- tech news & conversation starters ----------
async function getTechTrends() {
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Generate a witty, informative conversation starter about current tech industry trends. Make it:
- Clever and engaging, not basic
- Include a surprising fact or insight
- Relate to developer/tech community interests
- Add a touch of humor or irony
- End with a question to spark discussion
Keep it under 280 characters and naturally conversational.`
        },
        {
          role: 'user',
          content: 'Create a tech conversation starter for a Discord server'
        }
      ]
    });
    
    return resp.choices[0].message.content.trim();
  } catch (e) {
    console.error('Tech trends generation failed:', e);
    return "Anyone else notice how we went from 'don't trust anything on the internet' to 'hey Google, order my groceries'? Wild how fast we pivoted. What tech shift caught you most off guard?";
  }
}

async function checkAndSendAutoStarter() {
  const now = Date.now();
  
  for (const [channelId, lastActivity] of lastChannelActivity.entries()) {
    const timeSinceActivity = now - lastActivity;
    
    if (timeSinceActivity >= AUTO_STARTER_COOLDOWN_MS) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || channel.type !== 0) continue; // Only text channels
        
        // Don't spam if bot was the last to speak
        const history = conversationHistory.get(channelId) || [];
        const lastMessage = history[history.length - 1];
        if (lastMessage && lastMessage.role === 'assistant') continue;
        
        const starter = await getTechTrends();
        await channel.send(starter);
        
        // Update activity and add to conversation
        lastChannelActivity.set(channelId, now);
        addToConversationHistory(channelId, 'assistant', starter);
        
        console.log(`Sent auto-starter to ${channel.name}: ${starter}`);
        
      } catch (e) {
        console.error(`Failed to send auto-starter to channel ${channelId}:`, e);
      }
    }
  }
}

// ---------- existing helpers (updated for conversation) ----------
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

// ---------- copypasta + emoji helpers (existing) ----------
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

// ---------- LLM tone classifier (existing) ----------
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

function wittyCallout(tone) {
  const lines = [];
  if (tone.passive_aggressive) lines.push('😏 That's a bit passive-aggressive, don't you think?');
  if (tone.condescending)      lines.push('🪜 Climb down from that high horse—talk to people, not at them.');
  if (tone.provocation)        lines.push('🧯 Chill—no need to pour fuel on the thread.');
  return lines.join(' ');
}

// ---------- moderation (existing) ----------
async function handleModeration(msg) {
  if (DISABLED_GUILDS.has(msg.guildId)) return;
  if (shadowBanned.has(msg.author.id)) {
    await msg.delete().catch(() => {});
    return;
  }
  
  const history = messageHistory.get(msg.channelId) || [];
  history.push({ text: msg.content, time: Date.now(), user: msg.author.id });
  if (history.length > 10) history.shift();
  messageHistory.set(msg.channelId, history);
  
  const userMsgs = history.filter((h) => h.user === msg.author.id);
  if (userMsgs.length >= 5 && Date.now() - userMsgs[0].time < 5000) {
    await escalate(msg, 'Spam (too many messages)');
    await msg.delete().catch(() => {});
    await recordLog(msg, { action: 'delete' });
    return;
  }
  
  if (hasCopypastaInSingleMessage(msg.content)) {
    await escalate(msg, 'Spam (copypasta in single message)');
    await msg.delete().catch(() => {});
    await recordLog(msg, { action: 'delete' });
    return;
  }
  
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
  
  if (countEmojis(msg.content) >= 12) {
    await escalate(msg, 'Spam (emoji flood)');
    await msg.delete().catch(() => {});
    await recordLog(msg, { action: 'delete' });
    return;
  }
  
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
  
  const tone = await classifyBehavior(msg.content);
  
  const now = Date.now();
  const last = lastToneReply.get(msg.author.id) || 0;
  if ((tone.passive_aggressive || tone.condescending || tone.provocation) && (now - last >= TONE_COOLDOWN_MS)) {
    await msg.reply(wittyCallout(tone));
    lastToneReply.set(msg.author.id, now);
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
  
  for (const att of msg.attachments.values()) {
    if (att.contentType?.startsWith('image/')) {
      await logEvidence(msg.guild, msg, 'Image posted (placeholder check)', 'ImageLog');
    }
  }
}

// ---------- enhanced conversation with memory ----------
async function chatWithAI(text, userId, channelId) {
  const quirks = await getUserQuirks(userId);
  const personalityMod = getPersonalityModifier(userId);
  const conversationContext = getConversationContext(channelId);
  
  const systemPrompt = `
You are "${persona.display_name}" (${persona.pronouns}).
Style: ${persona.style}.
Be witty, playful, and socially aware.
${personalityMod}
${quirks.length ? `This user's quirks: ${quirks.join('; ')}` : ''}
Use conversation context naturally but don't reference it explicitly unless relevant.
  `.trim();
  
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationContext,
    { role: 'user', content: text }
  ];
  
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: messages,
  });
  
  return resp.choices[0].message.content.trim();
}

async function handleConversation(msg) {
  const channelId = msg.channel.id;
  
  // Update activity tracking
  lastChannelActivity.set(channelId, Date.now());
  
  // Add user message to conversation history
  addToConversationHistory(channelId, 'user', msg.content, msg.author.id);
  
  // Analyze user for profiling
  await analyzeUserProfile(msg.content, msg.author.id);
  
  if (activeConvos.get(channelId) === 'off') return;
  
  if (/(mac|windows|linux)/i.test(msg.content)) {
    if (!activeConvos.has(channelId)) {
      activeConvos.set(channelId, 'pending');
      const reply = '💻 Want me to join this debate? (yes/no)';
      await msg.reply(reply);
      addToConversationHistory(channelId, 'assistant', reply);
      await rememberUserQuirk(msg.author.id, 'Started an OS debate');
    } else if (activeConvos.get(channelId) === 'on') {
      const reply = await chatWithAI(msg.content, msg.author.id, channelId);
      await msg.reply(reply);
      addToConversationHistory(channelId, 'assistant', reply);
    }
  }
  
  if (/stop yapping|no\b/i.test(msg.content.toLowerCase())) {
    activeConvos.set(channelId, 'off');
    const reply = '🤐 Okay, I'll stay out.';
    await msg.reply(reply);
    addToConversationHistory(channelId, 'assistant', reply);
  }
  
  if (/yes|be part/i.test(msg.content.toLowerCase())) {
    activeConvos.set(channelId, 'on');
    const reply = '😎 Cool, I'm in.';
    await msg.reply(reply);
    addToConversationHistory(channelId, 'assistant', reply);
  }
  
  // Direct mentions or questions
  if (msg.mentions.has(client.user) || /^(hey|hi|hello).*kmwyl/i.test(msg.content)) {
    const reply = await chatWithAI(msg.content, msg.author.id, channelId);
    await msg.reply(reply);
    addToConversationHistory(channelId, 'assistant', reply);
  }
}

// ---------- auto threads (existing) ----------
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

// ---------- voting enforcement (existing) ----------
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

// ---------- anti-raid (existing) ----------
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

// ---------- admin + SUS commands (existing + new) ----------
client.on(Events.MessageCreate, async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  const isOwner = msg.author.id === OWNER_ID;
  
  if (isOwner) {
    // Existing admin commands...
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
    
    // New: User profile inspection
    if (msg.content.startsWith('!profile')) {
      const target = msg.mentions.users.first();
      if (target) {
        const profile = userProfiles.get(target.id);
        if (profile) {
          await msg.reply(
            `👤 Profile for <@${target.id}>:\n` +
            `• Age range: ${profile.age_range || 'unknown'}\n` +
            `• Gender likely: ${profile.gender_likely || 'unknown'}\n` +
            `• Flirty level: ${Math.round((profile.flirtyLevel || 0) * 10)}/10\n` +
            `• Interests: ${profile.interests.slice(0, 5).join(', ') || 'none detected'}\n` +
            `• Traits: ${profile.traits.slice(0, 5).join(', ') || 'none detected'}`
          );
        } else {
          await msg.reply(`No profile data for <@${target.id}> yet.`);
        }
      }
    }
    
    // New: Force conversation starter
    if (msg.content === '!starter') {
      const starter = await getTechTrends();
      await msg.channel.send(starter);
      lastChannelActivity.set(msg.channelId, Date.now());
      addToConversationHistory(msg.channelId, 'assistant', starter);
      await msg.reply('🚀 Conversation starter deployed!');
    }
    
    // Existing SUS commands...
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
  
  await handleModeration(msg);
  await handleConversation(msg);
  await handleAutoThreads(msg);
});

// ---------- startup & auto-starter loop ----------
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  
  // Set up auto-starter interval (check every 30 minutes)
  setInterval(checkAndSendAutoStarter, 30 * 60 * 1000);
  
  // Initialize activity tracking for existing channels
  client.guilds.cache.forEach(guild => {
    guild.channels.cache
      .filter(channel => channel.type === 0) // Text channels only
      .forEach(channel => {
        lastChannelActivity.set(channel.id, Date.now());
      });
  });
});

client.login(process.env.DISCORD_TOKEN);

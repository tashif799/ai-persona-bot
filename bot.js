import 'dotenv/config';
import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import { File } from 'node:buffer';
import OpenAI from 'openai';
import fs from 'node:fs/promises';

import { embed } from './embed.js';
import { rememberEmbedding, searchSimilar } from './db.js';

// load persona JSON once (can reload via !reloadpersona)
let persona = JSON.parse(await fs.readFile('./persona/kmwyl.json', 'utf8'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// -------- security / config --------
const OWNER_ID = process.env.OWNER_ID?.trim();
const ALLOWED_GUILDS = new Set(
  (process.env.ALLOWED_GUILD_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
const ALLOWED_CHANNELS = new Set(
  (process.env.ALLOWED_CHANNEL_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

const PERSONA_ID = 'kmwyl';
const KMWYL_WORD = /\bkmwyl\b/i; // whole word, case-insensitive
const lastSeen = new Map();
const COOLDOWN_MS = 4000; // 4s between replies per user

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (msg) => {
  try {
    // ------- hard gates -------
    if (msg.author.bot) return;
    if (msg.guildId && ALLOWED_GUILDS.size && !ALLOWED_GUILDS.has(msg.guildId)) return;
    if (msg.channelId && ALLOWED_CHANNELS.size && !ALLOWED_CHANNELS.has(msg.channelId)) return;

    const isOwner = !!OWNER_ID && msg.author.id === OWNER_ID;
    const isDM = !msg.guildId;
    const text = msg.content || '';
    const lc = text.toLowerCase();

    // ------- owner admin commands (no keyword required) -------
    if (isOwner) {
      if (lc.startsWith('!remember ')) {
        const body = text.slice('!remember '.length).trim();
        if (!body) return msg.reply('What should I remember?');
        const v = await embed(body);
        await rememberEmbedding({ personaId: PERSONA_ID, text: body, embedding: v });
        return msg.reply('🧠 remembered.');
      }

      if (lc === '!mem') {
        const v = await embed('summarize my persona');
        const rows = await searchSimilar({ personaId: PERSONA_ID, embedding: v, k: 5 });
        const out = rows.map(r => `• ${r.text}`).join('\n');
        return msg.reply({ content: out || '(no memories yet)' });
      }

      if (lc === '!reloadpersona') {
        const fresh = JSON.parse(await fs.readFile('./persona/kmwyl.json', 'utf8'));
        Object.assign(persona, fresh); // mutate in place
        return msg.reply('🔄 persona reloaded.');
      }
    }

    // ------- triggers -------
    // In servers: anyone can say "kmwyl ..." to trigger.
    // In DMs: only the owner can trigger (no keyword needed).
    const triggeredInGuild = KMWYL_WORD.test(text);
    const triggeredInDM = isOwner;
    if (!((isDM && triggeredInDM) || (!isDM && triggeredInGuild))) return;

    // ------- cooldown (per-user) -------
    const now = Date.now();
    const last = lastSeen.get(msg.author.id) || 0;
    if (now - last < COOLDOWN_MS) return;
    lastSeen.set(msg.author.id, now);

    await msg.channel.sendTyping();

    // ------- optional audio attachment -> Whisper -------
    let question = text.replace(/<@!?(\d+)>/g, '').trim();
    const audio = [...msg.attachments.values()].find(a => {
      const t = (a.contentType || '').toLowerCase();
      const n = (a.name || '').toLowerCase();
      return (t.startsWith('audio/') || /\.(m4a|mp3|wav|ogg)$/i.test(n)) && (a.size || 0) <= 20 * 1024 * 1024; // <=20MB
    });
    if (audio) {
      const res = await fetch(audio.url);
      const bytes = Buffer.from(await res.arrayBuffer());
      const file = new File([bytes], audio.name || 'audio.ogg', { type: audio.contentType || 'audio/ogg' });
      const tr = await openai.audio.transcriptions.create({ file, model: 'whisper-1' });
      question = (tr.text || '').trim() || question;
    }
    if (!question) return;
    if (question.length > 4000) return msg.reply('Message too long.');

    // ------- retrieve memories -------
    const qVec = await embed(question);
    const top = await searchSimilar({ personaId: PERSONA_ID, embedding: qVec, k: 6 });
    const context = top.map((t, i) => `(${i + 1}) ${t.text}`).join('\n');

    // ------- persona prompt -------
    const systemPrompt = `
You are "${persona.display_name}" (${persona.pronouns}).
Greeting vibe: "${persona.greeting}".
Style: ${persona.style}.
Boundaries: ${(persona.boundaries || []).join(' | ')}.
Use provided context if relevant; ignore if not. Keep replies brief unless asked.
`.trim();

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.6,
      max_tokens: 400,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${context ? `Context:\n${context}\n\n` : ''}User: ${question}` }
      ]
    });

    const answer = resp.choices?.[0]?.message?.content?.trim() || 'No reply.';

    // ------- write memory only for owner -------
    if (isOwner) {
      await rememberEmbedding({ personaId: PERSONA_ID, text: question, embedding: qVec });
    }

    // ------- reply (TTS owner-only if enabled) -------
    const canTTS = process.env.ENABLE_TTS === '1' && isOwner;
    if (canTTS) {
      try {
        const speech = await openai.audio.speech.create({
          model: 'tts-1', // or 'gpt-4o-mini-tts' if available to you
          voice: 'alloy',
          input: answer,
          format: 'mp3'
        });
        const mp3 = Buffer.from(await speech.arrayBuffer());
        await msg.reply({ content: answer, files: [{ attachment: mp3, name: 'reply.mp3' }] });
      } catch {
        await msg.reply(answer);
      }
    } else {
      await msg.reply(answer);
    }
  } catch (e) {
    console.error(e);
    try { await msg.reply('Error answering.'); } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);

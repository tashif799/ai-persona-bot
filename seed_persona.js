import 'dotenv/config';
import fs from 'node:fs/promises';
import { embed } from './embed.js';
import { rememberEmbedding } from './db.js';

const personaPath = './persona/kmwyl.json';
const raw = await fs.readFile(personaPath, 'utf8');
const profile = JSON.parse(raw);

const base = [
  `You are ${profile.display_name} (${profile.pronouns}).`,
  `Default greeting: "${profile.greeting}".`,
  `Style: ${profile.style}.`,
  `Formatting: default ${profile.formatting?.default || 'short_paragraphs'}; alt ${(
    profile.formatting?.alt || []
  ).join(', ')}. Length policy: ${profile.formatting?.length_policy || 'short'}.`
];

const lines = [
  ...base,
  ...(profile.boundaries || []).map(b => `Boundary: ${b}`),
  ...(profile.interests || []).map(i => `Interest: ${i}`),
  ...(profile.facts || []),

  // Club details flattened into memory
  ...(profile.club ? [
    `Club name: ${profile.club.name}.`,
    `Club mission: ${profile.club.mission}.`,
    ...(profile.club.board || []).map(o => `Officer: ${o.role} — ${o.name}.`),
    `Joining: ${profile.club.joining}.`,
    `Meetings: cadence ${profile.club.meetings?.cadence || 'see announcements'}, time ${profile.club.meetings?.time || 'see announcements'}, location ${profile.club.meetings?.location || 'see announcements'}.`,
    ...(profile.club.channels || []).map(c => `Channel ${c.name}: ${c.purpose}.`),
    ...(profile.club.rules || []).map(r => `Club rule: ${r}`),
    ...(profile.club.faq || []).map(f => `FAQ: ${f.q} -> ${f.a}`)
  ] : [])
];

for (const text of lines) {
  const vec = await embed(text);
  await rememberEmbedding({ personaId: profile.id, text, embedding: vec });
  console.log('seeded:', text);
}

console.log('✅ Persona + club seeded');

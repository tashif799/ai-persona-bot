// smc_job.js
import 'dotenv/config';
import OpenAI from 'openai';
import pg from 'pg';
import * as crypto from 'node:crypto';
import fetch from 'node-fetch'; // Node 20 has fetch, but node-fetch is fine too; we'll not add it if not needed

// ---------- config ----------
const SMC_NEWS_URL = process.env.SMC_NEWS_URL || 'https://www.smc.edu/news/announcements/';
const SMC_EVENTS_URL = process.env.SMC_EVENTS_URL || 'https://www.smc.edu/calendar/';
const MAX_ITEMS = Number(process.env.SMC_MAX_ITEMS || 4);      // how many bullets to post
const LOOKBACK_HOURS = Number(process.env.SMC_LOOKBACK_HOURS || 48);

const WEBHOOK_URL = process.env.SMC_WEBHOOK_URL || process.env.NEWS_WEBHOOK_URL || '';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const NEWS_CHANNEL_ID = process.env.NEWS_CHANNEL_ID || '';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// util
const toUtc = d => new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const hash = s => crypto.createHash('sha1').update(s).digest('hex');

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smc_post_log (
      url_hash TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      posted_at TIMESTAMPTZ DEFAULT now()
    )
  `);
}

async function alreadyPosted(url) {
  const { rows } = await pool.query(`SELECT 1 FROM smc_post_log WHERE url_hash = $1`, [hash(url)]);
  return rows.length > 0;
}

async function markPosted(url, title) {
  await pool.query(
    `INSERT INTO smc_post_log (url_hash, url, title) VALUES ($1,$2,$3)
     ON CONFLICT (url_hash) DO NOTHING`,
    [hash(url), url, title]
  );
}

// simplistic HTML fetch + tiny parser helpers
async function getHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'smc-bot/1.0 (+discord)' } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

// Very light parse for Announcements index (looks for links under /news/announcements/)
function parseAnnouncements(html) {
  // crude but robust: find Announcement blocks as H2 + link to /news/announcements/...
  const rx = /<h2[^>]*>\s*<a[^>]+href="([^"]*\/news\/announcements\/[^"]+)"[^>]*>(.*?)<\/a>\s*<\/h2>[\s\S]*?(\d{1,2}:\d{2}\s*p\.m\.|\d{1,2}:\d{2}\s*a\.m\.,\s*[A-Za-z]+\s*\d{1,2},\s*\d{4}|\b[A-Za-z]+\s*\d{1,2},\s*\d{4})/gi;
  const out = [];
  let m;
  while ((m = rx.exec(html)) && out.length < MAX_ITEMS * 3) {
    const link = new URL(m[1], 'https://www.smc.edu').toString();
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    const when = (m[3] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    out.push({ title, link, when });
  }
  // de-dupe by link
  const seen = new Set(); const uniq = [];
  for (const it of out) { if (!seen.has(it.link)) { seen.add(it.link); uniq.push(it); } }
  return uniq;
}

// Fallback skim on the campus events hub (grab visible event cards quickly)
function parseEvents(html) {
  // Grab any anchor under /calendar/ that looks like an event card title
  const rx = /<a[^>]+href="([^"]*\/calendar\/[^"#?]+)"[^>]*>([^<]{10,120})<\/a>/gi;
  const out = [];
  let m;
  while ((m = rx.exec(html)) && out.length < MAX_ITEMS * 3) {
    const link = new URL(m[1], 'https://www.smc.edu').toString();
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    // ignore navigation or category links by filtering overly generic titles
    if (!title || /Calendar|Visit|Search|Contact|Filter/i.test(title)) continue;
    out.push({ title, link });
  }
  // de-dupe by link
  const seen = new Set(); const uniq = [];
  for (const it of out) { if (!seen.has(it.link)) { seen.add(it.link); uniq.push(it); } }
  return uniq;
}

async function summarize(items) {
  const pick = items.slice(0, MAX_ITEMS);
  if (!pick.length) return [];

  const lines = pick.map((it, i) =>
    `(${i + 1}) ${it.title}\n${it.when ? `When: ${it.when}\n` : ''}Link: ${it.link}`
  ).join('\n\n');

  const prompt = `
You are an SMC campus update editor. Summarize each item in one short, precise line:
- Start with a Markdown link: [Title](Link)
- Then " — " and a crisp why-it-matters or key detail.
- If a "When:" value exists, append " (When: <value>)".
Keep it neutral, no hype. Only output the bullet list.
Items:
${lines}
`.trim();

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    max_tokens: 350,
    messages: [
      { role: 'system', content: 'Only output a clean bullet list.' },
      { role: 'user', content: prompt }
    ]
  });

  const text = resp.choices?.[0]?.message?.content?.trim() || '';
  return text.split('\n').filter(l => l.trim().startsWith('-'));
}

async function postToDiscord(content) {
  if (WEBHOOK_URL) {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!res.ok) throw new Error(`Webhook failed: ${res.status} ${await res.text()}`);
    return;
  }
  if (!DISCORD_TOKEN || !NEWS_CHANNEL_ID) {
    throw new Error('Set SMC_WEBHOOK_URL (recommended) or both DISCORD_TOKEN and NEWS_CHANNEL_ID.');
    }
  const res = await fetch(`https://discord.com/api/v10/channels/${NEWS_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${DISCORD_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content })
  });
  if (!res.ok) throw new Error(`Discord API post failed: ${res.status} ${await res.text()}`);
}

(async () => {
  const client = await pool.connect();
  try {
    await ensureTables();

    // 1) Pull Announcements
    const annHtml = await getHtml(SMC_NEWS_URL);
    let ann = parseAnnouncements(annHtml);

    // Filter out ones we already posted
    ann = ann.filter(i => i.title && i.link);

    // 2) Optionally peek the events hub for extra items (best-effort)
    let events = [];
    try {
      const evHtml = await getHtml(SMC_EVENTS_URL);
      events = parseEvents(evHtml);
    } catch {}

    // Merge, favor Announcements first
    const combined = [...ann, ...events].slice(0, MAX_ITEMS);

    // Remove links we’ve posted before
    const newOnes = [];
    for (const it of combined) {
      if (!(await alreadyPosted(it.link))) {
        newOnes.push(it);
      }
    }

    if (newOnes.length === 0) {
      console.log('ℹ️ No new SMC items to post.');
      return;
    }

    // Summarize to bullets
    const bullets = await summarize(newOnes);
    if (!bullets.length) {
      console.log('ℹ️ Summarizer returned no bullets; skipping.');
      return;
    }

    const today = new Date().toLocaleDateString('en-US', { timeZone: 'UTC' });
    const header = `**SMC Updates — ${today} (UTC)**`;
    const content = `${header}\n${bullets.join('\n')}`;

    await postToDiscord(content);

    // record
    for (const it of newOnes) {
      await markPosted(it.link, it.title);
    }
    console.log(`✅ Posted ${newOnes.length} SMC item(s).`);
  } catch (e) {
    console.error('❌ smc_job failed:', e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();

// news_job.js
import 'dotenv/config';
import Parser from 'rss-parser';
import OpenAI from 'openai';
import pg from 'pg';

// ---------- config ----------
const FEEDS = (process.env.NEWS_FEEDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_FEEDS = [
  'https://www.reuters.com/technology/rss',
  'https://www.cnbc.com/id/19854910/device/rss/rss.html', // CNBC Technology
  'https://feeds.feedburner.com/TechCrunch/',
  'https://www.theverge.com/rss/index.xml',
  'https://hnrss.org/frontpage' // Hacker News front page
];
const FEED_LIST = FEEDS.length ? FEEDS : DEFAULT_FEEDS;

const DIGEST_MAX = Number(process.env.NEWS_MAX_ITEMS || 4); // 1–5 recommended
const LOOKBACK_HOURS = Number(process.env.NEWS_LOOKBACK_HOURS || 24); // recency window

// Prefer a channel webhook (best). Fallback: Bot token + channel ID.
const WEBHOOK_URL = process.env.NEWS_WEBHOOK_URL || '';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const NEWS_CHANNEL_ID = process.env.NEWS_CHANNEL_ID || '';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function toUtcDateString(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS news_digest_log (
      posted_date DATE PRIMARY KEY,
      item_count INT NOT NULL,
      posted_at TIMESTAMPTZ DEFAULT now()
    )
  `);
}

async function alreadyPostedToday() {
  const today = toUtcDateString();
  const { rows } = await pool.query(
    `SELECT 1 FROM news_digest_log WHERE posted_date = $1`,
    [today]
  );
  return rows.length > 0;
}

async function markPostedToday(count) {
  const today = toUtcDateString();
  await pool.query(
    `INSERT INTO news_digest_log (posted_date, item_count)
     VALUES ($1, $2)
     ON CONFLICT (posted_date) DO NOTHING`,
    [today, count]
  );
}

function withinHours(dateString, hours) {
  const t = new Date(dateString || Date.now());
  const now = new Date();
  return (now - t) <= hours * 3600 * 1000;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function fetchFeeds() {
  const parser = new Parser();
  const all = [];
  for (const url of FEED_LIST) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of (feed.items || [])) {
        const pub = item.isoDate || item.pubDate || new Date().toISOString();
        if (!withinHours(pub, LOOKBACK_HOURS)) continue;
        all.push({
          title: item.title || '',
          link: item.link || '',
          source: (feed.title || '').trim(),
          isoDate: pub
        });
      }
    } catch (e) {
      console.error('Feed error:', url, e.message);
    }
  }
  // newest first, dedupe by title
  return dedupe(all).sort((a, b) => new Date(b.isoDate) - new Date(a.isoDate));
}

async function summarize(items) {
  const pick = items.slice(0, DIGEST_MAX);
  if (pick.length === 0) return [];

  const lines = pick.map(
    (it, i) => `(${i + 1}) ${it.title}\nSource: ${it.source}\nLink: ${it.link}`
  ).join('\n\n');

  const prompt = `
Summarize each item in one short, punchy sentence with "why it matters" for a daily tech digest.
Keep it objective, no hype, and avoid duplicates in meaning.

Items:
${lines}

Return as a list of ${pick.length} bullet points in this exact format:
- [Title](link) — why it matters.
  `.trim();

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.4,
    max_tokens: 400,
    messages: [
      { role: 'system', content: 'You are a concise tech news editor. Only output the bullet list.' },
      { role: 'user', content: prompt }
    ]
  });

  const text = resp.choices?.[0]?.message?.content?.trim() || '';
  if (!text) {
    return pick.map(it => `- [${it.title}](${it.link}) — ${it.source}`);
  }
  return text.split('\n').filter(l => l.trim().startsWith('-'));
}

async function postToDiscord(bullets) {
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'UTC' });
  const content = `**Tech Digest — ${today} (UTC)**\n${bullets.join('\n')}`;

  if (WEBHOOK_URL) {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!res.ok) throw new Error(`Webhook post failed: ${res.status} ${await res.text()}`);
    return;
  }

  if (!DISCORD_TOKEN || !NEWS_CHANNEL_ID) {
    throw new Error('Set NEWS_WEBHOOK_URL or both DISCORD_TOKEN and NEWS_CHANNEL_ID.');
  }
  const res = await fetch(`https://discord.com/api/v10/channels/${NEWS_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${DISCORD_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content })
  });
  if (!res.ok) {
    throw new Error(`Discord API post failed: ${res.status} ${await res.text()}`);
  }
}

(async () => {
  const client = await pool.connect();
  try {
    await ensureTables();

    if (await alreadyPostedToday()) {
      console.log('✅ Already posted today — skipping.');
      return;
    }

    const items = await fetchFeeds();
    if (items.length === 0) {
      console.log('ℹ️ No fresh items in window — skipping.');
      return;
    }

    const bullets = await summarize(items);
    const finalBullets = bullets.slice(0, DIGEST_MAX);
    if (finalBullets.length === 0) {
      console.log('ℹ️ No bullets after summarize — skipping.');
      return;
    }

    await postToDiscord(finalBullets);
    await markPostedToday(finalBullets.length);
    console.log(`✅ Posted Tech Digest with ${finalBullets.length} items.`);
  } catch (e) {
    console.error('❌ News job failed:', e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();

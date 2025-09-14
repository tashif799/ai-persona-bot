// news_job.js
import 'dotenv/config';
import Parser from 'rss-parser';
import OpenAI from 'openai';
import pg from 'pg';

// ---------- config ----------
const FEEDS = (process.env.NEWS_FEEDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_FEEDS = [
  // Pure-tech, lower drama:
  'https://feeds.arstechnica.com/arstechnica/technology-lab',
  'https://feeds.arstechnica.com/arstechnica/information-technology',
  'https://www.theverge.com/rss/index.xml',           // Verge Tech
  'https://techcrunch.com/feed/',                      // TechCrunch
  'https://hnrss.org/frontpage',                       // HN (we’ll keyword-filter)
  'https://www.bleepingcomputer.com/feed/',           // Security
  'https://www.schneier.com/feed/atom/',              // Security policy/tech
  'https://spectrum.ieee.org/rss/engineering'         // IEEE Spectrum
];
const FEED_LIST = FEEDS.length ? FEEDS : DEFAULT_FEEDS;

// Support both env var names (yours and the script’s)
const DIGEST_MAX = Number(process.env.NEWS_MAX_ITEMS || process.env.MAX_NEWS_PER_POST || 4);
const LOOKBACK_HOURS = Number(process.env.NEWS_LOOKBACK_HOURS || 24);

// Keyword allowlist (only include if ANY of these appear)
// Set via env: NEWS_KEYWORDS="ai,ml,gpu,chip,cloud,security,dev,developer,programming,open source,linux,kernel,database,postgres,neon,vector,pgvector"
const KEYWORDS = (process.env.NEWS_KEYWORDS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Exclude terms (drop if ANY of these appear)
// Set via env: NEWS_EXCLUDE="cleopatra,leonardo,dna,biology,celebrity,politics"
const EXCLUDE = (process.env.NEWS_EXCLUDE || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function passesKeyword(title, source) {
  const t = (title || '').toLowerCase();
  const s = (source || '').toLowerCase();

  // Exclusions first
  if (EXCLUDE.length && EXCLUDE.some(x => t.includes(x) || s.includes(x))) return false;

  // If no allowlist provided, accept all tech-ish items
  if (!KEYWORDS.length) return true;

  // Otherwise require at least one keyword hit
  return KEYWORDS.some(x => t.includes(x) || s.includes(x));
}


// Prefer a channel webhook (best). Fallback: Bot token + channel ID.
const WEBHOOK_URL = process.env.NEWS_WEBHOOK_URL || '';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const NEWS_CHANNEL_ID = process.env.NEWS_CHANNEL_ID || '';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }  // TLS for Neon/managed PG
});


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
	if (!passesKeyword(item.title, feed.title)) continue;
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

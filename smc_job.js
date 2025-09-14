// smc_job.js  — HTML-capable SMC digest
import 'dotenv/config';
import OpenAI from 'openai';
import pg from 'pg';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

// -------- env --------
const NEWS_URL   = process.env.SMC_NEWS_URL    || 'https://www.smc.edu/newsroom/';
const EVENTS_URL = process.env.SMC_EVENTS_URL  || 'https://www.smc.edu/calendar/';
const WEBHOOK    = process.env.SMC_WEBHOOK_URL || '';
const MAX_ITEMS  = Number(process.env.SMC_MAX_ITEMS || 4);
const LOOKBACK_H = Number(process.env.SMC_LOOKBACK_HOURS || 48);

if (!WEBHOOK) throw new Error('SMC_WEBHOOK_URL is required');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// optional dedupe/log table (same db + ssl as your other jobs)
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { require: true, rejectUnauthorized: false }
});

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smc_digest_log (
      id SERIAL PRIMARY KEY,
      url TEXT UNIQUE,
      title TEXT,
      posted_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}
async function seen(url) {
  const { rows } = await pool.query(`SELECT 1 FROM smc_digest_log WHERE url=$1`, [url]);
  return rows.length > 0;
}
async function mark(url, title) {
  await pool.query(
    `INSERT INTO smc_digest_log (url, title) VALUES ($1,$2) ON CONFLICT (url) DO NOTHING`,
    [url, title]
  );
}

function withinHours(dateStr, hours) {
  if (!dateStr) return true; // if no date on page, treat as maybe-new
  const d = new Date(dateStr);
  if (isNaN(d)) return true; // unknown format, don’t block
  return (Date.now() - d.getTime()) <= hours * 3600 * 1000;
}

async function getHTML(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (SMC Bot)' }});
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  return await res.text();
}

// ---- scrape newsroom (cards + lists) ----
async function scrapeNewsroom() {
  const html = await getHTML(NEWS_URL);
  const $ = cheerio.load(html);
  const items = [];

  // try common patterns
  $('a').each((_, a) => {
    const href = $(a).attr('href') || '';
    const title = $(a).text().trim();
    if (!href || !title) return;

    // keep only newsroom/article-ish links on smc.edu
    const abs = href.startsWith('http') ? href : new URL(href, NEWS_URL).href;
    if (!/smc\.edu/.test(abs)) return;
    if (!/news|newsroom|press|article|story/i.test(abs)) return;

    // try nearby date text (many SMC pages include dates in a sibling/parent)
    let dateText = $(a).closest('article,li,div').find('time').attr('datetime')
                 || $(a).closest('article,li,div').find('time').text()
                 || $(a).closest('article,li,div').find('.date,.published').text()
                 || '';

    items.push({ source: 'SMC Newsroom', title, link: abs, dateText });
  });

  // de-dupe by link
  const seenLinks = new Set();
  const deduped = items.filter(it => {
    if (seenLinks.has(it.link)) return false;
    seenLinks.add(it.link);
    return true;
  });

  // keep recent
  return deduped.filter(it => withinHours(it.dateText, LOOKBACK_H));
}

// ---- scrape events (simple titles/links/date blobs) ----
async function scrapeEvents() {
  const html = await getHTML(EVENTS_URL);
  const $ = cheerio.load(html);
  const items = [];

  // try generic “event card” selectors
  $('[class*=event], .event, .event-item, .calendar__event, .events-list a').each((_, el) => {
    const $el = $(el);
    const a = $el.is('a') ? $el : $el.find('a').first();
    const href = a.attr('href');
    let title = a.text().trim();
    if (!href || !title) return;

    const abs = href.startsWith('http') ? href : new URL(href, EVENTS_URL).href;
    // date text around card
    const dateText = $el.find('time').attr('datetime')
                   || $el.find('time').text()
                   || $el.text();

    items.push({ source: 'SMC Events', title, link: abs, dateText });
  });

  // also scan plain anchors as fallback
  if (items.length === 0) {
    $('a').each((_, a) => {
      const href = $(a).attr('href') || '';
      const title = $(a).text().trim();
      if (!href || !title) return;
      const abs = href.startsWith('http') ? href : new URL(href, EVENTS_URL).href;
      if (/calendar|event|workshop|club|transfer|admission|application/i.test(abs)) {
        items.push({ source: 'SMC Events', title, link: abs, dateText: '' });
      }
    });
  }

  // de-dupe + filter recent
  const seenLinks = new Set();
  const deduped = items.filter(it => {
    if (seenLinks.has(it.link)) return false;
    seenLinks.add(it.link);
    return true;
  });

  return deduped.filter(it => withinHours(it.dateText, LOOKBACK_H));
}

function makeDigestTitle() {
  const nowUTC = new Date().toLocaleDateString('en-US', { timeZone: 'UTC' });
  return `**SMC Updates — ${nowUTC} (UTC)**`;
}

async function summarize(items) {
  const pick = items.slice(0, MAX_ITEMS);
  if (pick.length === 0) return [];

  const lines = pick.map(
    (it, i) => `(${i + 1}) ${it.title}\nSource: ${it.source}\nLink: ${it.link}`
  ).join('\n\n');

  const prompt = `
Summarize each item in one brief, helpful sentence for SMC students (what/where/when if present).
Keep it neutral and practical. Output ONLY bullet points:

${lines}
`.trim();

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.4,
    max_tokens: 350,
    messages: [
      { role: 'system', content: 'You write concise campus bulletins for SMC students.' },
      { role: 'user', content: prompt }
    ]
  });

  const text = resp.choices?.[0]?.message?.content?.trim() || '';
  return text ? text.split('\n').filter(l => l.trim().startsWith('-')) 
              : pick.map(it => `- [${it.title}](${it.link}) — ${it.source}`);
}

async function postToDiscord(title, bullets) {
  const content = `${title}\n${bullets.join('\n')}`;
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  if (!res.ok) throw new Error(`Webhook post failed: ${res.status} ${await res.text()}`);
}

(async () => {
  const client = await pool.connect();
  try {
    await ensureTables();

    // scrape both
    const [news, events] = await Promise.all([
      scrapeNewsroom().catch(e => { console.log('Newsroom scrape error:', e.message); return []; }),
      scrapeEvents().catch(e => { console.log('Events scrape error:', e.message); return []; })
    ]);

    // filter out links we've already posted (db)
    const fresh = [];
    for (const it of [...news, ...events]) {
      if (!(await seen(it.link))) fresh.push(it);
    }

    if (fresh.length === 0) {
      console.log('ℹ️ No new SMC items to post.');
      return;
    }

    // summarize + post
    const bullets = await summarize(fresh);
    const finalBullets = bullets.slice(0, MAX_ITEMS);
    await postToDiscord(makeDigestTitle(), finalBullets);

    // remember
    for (const it of fresh.slice(0, MAX_ITEMS)) await mark(it.link, it.title);
    console.log(`✅ Posted SMC digest with ${finalBullets.length} items.`);
  } catch (e) {
    console.error('❌ SMC job failed:', e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();

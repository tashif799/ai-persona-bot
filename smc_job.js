// smc_job.js — HTML-capable SMC digest
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

const DEBUG = process.env.SMC_DEBUG === '1';
const SEED  = process.env.SMC_SEED === '1';
function d(...a){ if (DEBUG) console.log('[SMC]', ...a); }

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
  if (SEED) return true;                  // seed mode: don't filter by time
  if (!dateStr) return true;
  const d = new Date(dateStr);
  if (isNaN(d)) return true;
  return (Date.now() - d.getTime()) <= hours * 3600 * 1000;
}

async function getHTML(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (SMC Bot)' }});
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  return await res.text();
}

async function scrapeNewsroom() {
  const html = await getHTML(NEWS_URL);
  const $ = cheerio.load(html);
  const items = [];

  const SELS = ['article a','li a','h2 a','h3 a','div a','section a','a'];
  const LINK_OK = /news|newsroom|press|announcement|story/i;

  for (const sel of SELS) {
    $(sel).each((_, el) => {
      const a = $(el);
      const href  = a.attr('href') || '';
      const title = a.text().replace(/\s+/g,' ').trim();
      if (!href || !title) return;

      const abs = href.startsWith('http') ? href : new URL(href, NEWS_URL).href;
      if (!/smc\.edu/i.test(abs)) return;
      if (!LINK_OK.test(abs)) return;

      const bloc = a.closest('article,li,div,section');
      const dateText =
          bloc.find('time').attr('datetime')
       || bloc.find('time').text()
       || bloc.find('.date,.published,.meta').text()
       || '';

      items.push({ source:'SMC Newsroom', title, link: abs, dateText });
    });
  }

  const seenLinks = new Set();
  const deduped = items.filter(it => (seenLinks.has(it.link) ? false : (seenLinks.add(it.link), true)));
  const recent = deduped.filter(it => withinHours(it.dateText, LOOKBACK_H));
  d('newsroom found:', items.length, 'deduped:', deduped.length, 'recent:', recent.length);
  if (DEBUG) d('sample news:', recent.slice(0,3));
  return recent;
}

async function scrapeEvents() {
  const html = await getHTML(EVENTS_URL);
  const $ = cheerio.load(html);
  const items = [];

  const SELS = [
    '[class*=event]','[class*=Event]','.event','.event-item',
    '.calendar__event','.events-list a','article a','li a','h3 a','a'
  ];
  const LINK_OK = /calendar|event|workshop|transfer|club|career|admission|deadline|registration|orientation|midterm|final|exam/i;

  for (const sel of SELS) {
    $(sel).each((_, el) => {
      const $el = $(el);
      const a = $el.is('a') ? $el : $el.find('a').first();
      const href  = a.attr('href') || '';
      const title = a.text().replace(/\s+/g,' ').trim();
      if (!href || !title) return;

      const abs = href.startsWith('http') ? href : new URL(href, EVENTS_URL).href;
      if (!/smc\.edu/i.test(abs) || !LINK_OK.test(abs + ' ' + title)) return;

      const bloc = $el.closest('article,li,div,section');
      const dateText =
          bloc.find('time').attr('datetime')
       || bloc.find('time').text()
       || bloc.find('.date,.when,.meta').text()
       || '';

      items.push({ source:'SMC Events', title, link: abs, dateText });
    });
  }

  const seenLinks = new Set();
  const deduped = items.filter(it => (seenLinks.has(it.link) ? false : (seenLinks.add(it.link), true)));
  const recent = deduped.filter(it => withinHours(it.dateText, LOOKBACK_H));
  d('events found:', items.length, 'deduped:', deduped.length, 'recent:', recent.length);
  if (DEBUG) d('sample events:', recent.slice(0,3));
  return recent;
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

    const [news, events] = await Promise.all([
      scrapeNewsroom().catch(e => { console.log('Newsroom scrape error:', e.message); return []; }),
      scrapeEvents().catch(e => { console.log('Events scrape error:', e.message); return []; })
    ]);

    const fresh = [];
    for (const it of [...news, ...events]) {
      if (!(await seen(it.link))) fresh.push(it);
    }

    if (fresh.length === 0) {
      console.log('ℹ️ No new SMC items to post.');
      return;
    }

    d('fresh items before summarize:', fresh.length);

    const bullets = await summarize(fresh);
    const finalBullets = bullets.slice(0, MAX_ITEMS);
    await postToDiscord(makeDigestTitle(), finalBullets);

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

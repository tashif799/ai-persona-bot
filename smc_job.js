// smc_job.js — SMC newsroom + events (time-aware) + Corsair + In Focus + Trustees + Announcements digest (Discord webhook)
import 'dotenv/config';
import OpenAI from 'openai';
import pg from 'pg';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

// ---------- env ----------
const NEWS_URL    = process.env.SMC_NEWS_URL    || 'https://www.smc.edu/news/';
const EVENTS_URL  = process.env.SMC_EVENTS_URL  || 'https://www.smc.edu/calendar/';
const HOME_URL    = process.env.SMC_HOME_URL    || 'https://www.smc.edu/';
const CORSAIR_URL = process.env.SMC_CORSAIR_URL || 'https://www.thecorsaironline.com/';
const IN_FOCUS_URL= process.env.SMC_IN_FOCUS_URL|| 'https://www.smc.edu/news/in-focus/';
const TRUSTEES_URL= process.env.SMC_TRUSTEES_URL|| 'https://admin.smc.edu/administration/governance/board-of-trustees/meetings.php';
const ANNOUNCEMENTS_URL = process.env.SMC_ANNOUNCEMENTS_URL || 'https://www.smc.edu/news/announcements/';

const WEBHOOK    = (process.env.SMC_WEBHOOK_URL || '').trim();
const MAX_ITEMS  = Number(process.env.SMC_MAX_ITEMS || 6);
const LOOKBACK_H = Number(process.env.SMC_LOOKBACK_HOURS || 72); // 3 days default
const PER_SOURCE_LIMIT = Number(process.env.SMC_PER_SOURCE_LIMIT || 4);
const EVENT_PAST_GRACE_H = Number(process.env.SMC_EVENT_PAST_GRACE_HOURS || 12); // keep just-started events within N hours
const EVENT_FUTURE_WINDOW_D = Number(process.env.SMC_EVENT_FUTURE_WINDOW_DAYS || 60); // look ahead window
const DEBUG = process.env.SMC_DEBUG === '1';
const SEED  = process.env.SMC_SEED === '1'; // for testing, bypass date filters
function d(...a){ if (DEBUG) console.log('[SMC]', ...a); }

if (!WEBHOOK) throw new Error('SMC_WEBHOOK_URL is required');

// OpenAI (trim key to avoid bad header errors)
const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

// ---------- optional DB for dedupe ----------
const HAS_DB = !!process.env.DATABASE_URL;
let pool = null;
if (HAS_DB) {
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { require: true, rejectUnauthorized: false },
  });
} else {
  d('No DATABASE_URL — using in-memory dedupe for this run.');
}
const memSeen = new Set();
async function ensureTables() {
  if (!HAS_DB) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smc_digest_log (
      id SERIAL PRIMARY KEY,
      url TEXT UNIQUE,
      title TEXT,
      source TEXT,
      published_at TIMESTAMPTZ,
      posted_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS smc_digest_log_published_idx ON smc_digest_log (published_at DESC);
  `);
}
async function seen(url) {
  if (!HAS_DB) return memSeen.has(url);
  const { rows } = await pool.query(`SELECT 1 FROM smc_digest_log WHERE url=$1`, [url]);
  return rows.length > 0;
}
async function mark({url, title, source, publishedAt}) {
  if (!HAS_DB) { memSeen.add(url); return; }
  await pool.query(
    `INSERT INTO smc_digest_log (url, title, source, published_at)
     VALUES ($1,$2,$3,$4) ON CONFLICT (url) DO NOTHING`,
    [url, title || null, source || null, publishedAt ? new Date(publishedAt) : null]
  );
}

// ---------- helpers ----------
const LA_TZ = process.env.TZ || 'America/Los_Angeles';

function parseDateLoose(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/\s+/g, ' ').trim()
    .replace(/\bsept\b/i, 'Sep')
    .replace(/\u00A0/g, ' ');
  const dt = new Date(cleaned);
  if (!isNaN(dt)) return dt;
  const m = cleaned.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})\s*(am|pm)?)?\b/i);
  if (m) {
    const [, mm, dd, yyyy, hh, min, ampm] = m;
    const y = Number(yyyy.length === 2 ? ('20' + yyyy) : yyyy);
    let H = hh ? Number(hh) : 0;
    if (ampm) {
      const ap = ampm.toLowerCase();
      if (ap === 'pm' && H < 12) H += 12;
      if (ap === 'am' && H === 12) H = 0;
    }
    const d = new Date(y, Number(mm)-1, Number(dd), H, min ? Number(min) : 0);
    if (!isNaN(d)) return d;
  }
  return null;
}

async function getHTML(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (SMC Digest Bot)' } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  return res.text();
}

function hoursAgo(h) { return Date.now() - h * 3600 * 1000; }
function isFresh(dateOrNull) {
  if (SEED) return true;
  if (!dateOrNull) return false; // IMPORTANT: no date means NOT fresh (fixes old posts slipping in)
  return new Date(dateOrNull).getTime() >= hoursAgo(LOOKBACK_H);
}

function normItem(it) {
  const title = (it.title || '').replace(/\s+/g,' ').trim();
  const link  = it.link;
  return {
    source: it.source || 'SMC',
    title,
    link,
    dateText: it.dateText || '',
    publishedAt: it.publishedAt || null,
    blurb: (it.blurb || '').replace(/\s+/g,' ').trim(),
  };
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(it => {
    const k = it.link?.split('#')[0];
    if (!k || seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function limitPerSource(items, perSource = PER_SOURCE_LIMIT) {
  const counts = new Map();
  const out = [];
  for (const it of items) {
    const s = it.source || 'SMC';
    const c = counts.get(s) || 0;
    if (c < perSource) { out.push(it); counts.set(s, c+1); }
  }
  return out;
}

// ---------- scrapers ----------
// 1) SMC News (official newsroom listing)
async function scrapeNewsroom() {
  const html = await getHTML(NEWS_URL);
  const $ = cheerio.load(html);
  const items = [];

  $('article a, li a, h2 a, h3 a, div a, section a, a').each((_, el) => {
    const a = $(el);
    const href  = a.attr('href') || '';
    const title = a.text().replace(/\s+/g,' ').trim();
    if (!href || !title) return;
    const abs = href.startsWith('http') ? href : new URL(href, NEWS_URL).href;
    const p = new URL(abs).pathname.toLowerCase();
    if (!/smc\.edu/i.test(abs)) return;
    if (!(p.includes('/news') || p.includes('/newsroom'))) return;
    if (/\/index(\.php)?$/.test(p)) return;

    const bloc = a.closest('article,li,div,section');
    const dateText = bloc.find('time').attr('datetime')
                   || bloc.find('time').first().text()
                   || bloc.find('.date,.published,.meta').first().text()
                   || '';
    const publishedAt = parseDateLoose(dateText);
    items.push(normItem({ source: 'SMC Newsroom', title, link: abs, dateText, publishedAt }));
  });

  for (const it of items) {
    if (!it.publishedAt) {
      const detected = await detectPublishedFromPage(it.link);
      if (detected) it.publishedAt = detected;
    }
  }

  const ded = dedupe(items);
  const fresh = SEED ? ded : ded.filter(it => isFresh(it.publishedAt));
  d('newsroom found:', items.length, 'deduped:', ded.length, 'fresh:', fresh.length);
  return fresh;
}

// 2) Home page Events block (server-rendered) — time-aware filter will also be applied
async function scrapeHomeEvents() {
  const html = await getHTML(HOME_URL);
  const $ = cheerio.load(html);
  const items = [];

  const header = $('*:contains("Events Happening at SMC")').filter((_, el) => $(el).text().trim() === 'Events Happening at SMC').first();
  const scope = header.length ? header.closest('section,div').parent() : $.root();

  scope.find('a').each((_, el) => {
    const a = $(el);
    const title = a.text().replace(/\s+/g, ' ').trim();
    const href = a.attr('href');
    if (!title || !href) return;
    const abs = href.startsWith('http') ? href : new URL(href, HOME_URL).href;
    if (!/smc\.edu\//i.test(abs)) return;
    const card = a.closest('article,li,div,section');
    const dateLine = card.find('time').first().attr('datetime') || card.find('time').first().text() || '';
    const start = parseDateLoose(dateLine);
    if (isUpcomingOrRecent(start, null)) {
      items.push(normItem({ source: 'SMC Events', title, link: abs, dateText: dateLine||'', publishedAt: start }));
    }
  });

  const ded = dedupe(items);
  d('home events kept (upcoming/recent):', ded.length);
  return ded.slice(0, 12);
}

// 3) The Corsair (student newspaper)
async function scrapeCorsair() {
  const html = await getHTML(CORSAIR_URL);
  const $ = cheerio.load(html);
  const items = [];

  $('a').each((_, el) => {
    const a = $(el);
    const href = a.attr('href') || '';
    const title = a.text().replace(/\s+/g,' ').trim();
    if (!href || !title) return;
    const abs = href.startsWith('http') ? href : new URL(href, CORSAIR_URL).href;
    if (!/thecorsaironline\.com\//i.test(abs)) return;
    if (/\/category\//i.test(abs) || /\/#/.test(abs)) return;
    const bloc = a.closest('article,div,li,section');
    const dateText = bloc.find('time').first().text() ||
                     bloc.text().match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}\b/i)?.[0] || '';
    const publishedAt = parseDateLoose(dateText);
    if (title.length > 6) items.push(normItem({ source: 'The Corsair', title, link: abs, dateText, publishedAt }));
  });

  for (const it of items) {
    if (!it.publishedAt) {
      const detected = await detectPublishedFromPage(it.link);
      if (detected) it.publishedAt = detected;
    }
  }

  const ded = dedupe(items);
  const fresh = SEED ? ded : ded.filter(it => isFresh(it.publishedAt));
  d('corsair found:', items.length, 'deduped:', ded.length, 'fresh:', fresh.length);
  return fresh.slice(0, 12);
}

// 4) SMC In Focus (magazine/feature)
async function scrapeInFocus() {
  const html = await getHTML(IN_FOCUS_URL);
  const $ = cheerio.load(html);
  const items = [];

  let issueDate = null;
  $('*:contains("Volume ")').each((_, el) => {
    const t = $(el).text();
    const m = t.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i);
    if (m) { issueDate = m[0]; return false; }
  });
  const issueDt = parseDateLoose(issueDate);

  $('a:contains("Read Article"), h2 a, .newsfeed-title a, .feature a').each((_, el) => {
    const a = $(el);
    const href = a.attr('href');
    if (!href) return;
    const abs = href.startsWith('http') ? href : new URL(href, IN_FOCUS_URL).href;
    const title = (a.text() || a.closest('article,div,section').find('h2,h3').first().text() || '').replace(/\s+/g,' ').trim();
    if (!title) return;
    items.push(normItem({ source: 'SMC In Focus', title, link: abs, dateText: issueDate || '', publishedAt: issueDt }));
  });

  for (const it of items) {
    if (!it.publishedAt) {
      const detected = await detectPublishedFromPage(it.link);
      if (detected) it.publishedAt = detected;
    }
  }

  const ded = dedupe(items);
  const fresh = SEED ? ded : ded.filter(it => isFresh(it.publishedAt));
  d('in-focus found:', items.length, 'deduped:', ded.length, 'fresh:', fresh.length);
  return fresh.slice(0, 8);
}

// 5) Board of Trustees — latest agendas/minutes (governance signals)
async function scrapeTrustees() {
  const html = await getHTML(TRUSTEES_URL);
  const $ = cheerio.load(html);
  const items = [];

  const yearHeaders = $('h3:contains("2025"), h3:contains("2024"), h2:contains("2025"), h2:contains("2024")');
  yearHeaders.each((_, h) => {
    const yearBlock = $(h).nextUntil('h3, h2');
    yearBlock.find('a').each((__, aEl) => {
      const a = $(aEl);
      const href = a.attr('href');
      const text = a.text();
      if (!href || !/\.(pdf|docx?)($|\?)/i.test(href)) return;
      const abs = href.startsWith('http') ? href : new URL(href, TRUSTEES_URL).href;
      const dateInText = text.match(/\b\d{1,2}[\-\/]\d{1,2}[\-\/]\d{2,4}\b/);
      const dateText = dateInText ? dateInText[0] : $(h).text().trim();
      const publishedAt = parseDateLoose(dateText);
      items.push(normItem({ source: 'Board of Trustees', title: `Board of Trustees ${text.replace(/\s+/g,' ').trim()}` , link: abs, dateText, publishedAt }));
    });
  });

  const ded = dedupe(items);
  const fresh = SEED ? ded : ded.filter(it => isFresh(it.publishedAt));
  d('trustees found:', items.length, 'deduped:', ded.length, 'fresh:', fresh.length);
  return fresh.slice(0, 8);
}

// 6) Announcements (new)
async function scrapeAnnouncements() {
  const html = await getHTML(ANNOUNCEMENTS_URL);
  const $ = cheerio.load(html);
  const items = [];

  $('article a, h2 a, h3 a, li a').each((_, el) => {
    const a = $(el);
    const href = a.attr('href') || '';
    const title = a.text().replace(/\s+/g,' ').trim();
    if (!href || !title) return;
    const abs = href.startsWith('http') ? href : new URL(href, ANNOUNCEMENTS_URL).href;
    if (!/smc\.edu\//i.test(abs)) return;
    const bloc = a.closest('article,li,div,section');
    const dateText = bloc.find('time').attr('datetime') || bloc.find('time').first().text() || '';
    let publishedAt = parseDateLoose(dateText);
    items.push(normItem({ source: 'SMC Announcements', title, link: abs, dateText, publishedAt }));
  });

  for (const it of items) {
    if (!it.publishedAt) {
      const detected = await detectPublishedFromPage(it.link);
      if (detected) it.publishedAt = detected;
    }
  }

  const ded = dedupe(items);
  const fresh = SEED ? ded : ded.filter(it => isFresh(it.publishedAt));
  d('announcements found:', items.length, 'deduped:', ded.length, 'fresh:', fresh.length);
  return fresh.slice(0, 10);
}

// ---------- time-aware helpers for events ----------
function isUpcomingOrRecent(start, end) {
  const now = Date.now();
  if (!start) return false; // require a start date to avoid stale posts
  const tStart = new Date(start).getTime();
  const tEnd = end ? new Date(end).getTime() : tStart;
  const futureLimit = now + EVENT_FUTURE_WINDOW_D*24*3600*1000;
  const pastGrace = now - EVENT_PAST_GRACE_H*3600*1000;
  return (tStart >= pastGrace && tStart <= futureLimit) || (tEnd >= pastGrace && tEnd <= futureLimit);
}

// Also use the /calendar/ page where possible and filter by isUpcomingOrRecent
async function scrapeEventsTimeAware() {
  let items = [];
  try {
    const html = await getHTML(EVENTS_URL);
    const $ = cheerio.load(html);
    const SELS = [
      '[class*=event]','[class*=Event]','.event','.event-item',
      '.calendar__event','.events-list a','article a','li a','h3 a','a'
    ];
    for (const sel of SELS) {
      $(sel).each((_, el) => {
        const $el = $(el);
        const a = $el.is('a') ? $el : $el.find('a').first();
        const href  = a.attr('href') || '';
        const title = a.text().replace(/\s+/g,' ').trim();
        if (!href || !title) return;
        const abs = href.startsWith('http') ? href : new URL(href, EVENTS_URL).href;
        if (!/smc\.edu/i.test(abs)) return;
        const bloc = $el.closest('article,li,div,section');
        const dateText = bloc.find('time').attr('datetime') || bloc.find('time').text() || '';
        const start = parseDateLoose(dateText);
        if (isUpcomingOrRecent(start, null)) {
          items.push(normItem({ source: 'SMC Events', title, link: abs, dateText, publishedAt: start }));
        }
      });
    }
  } catch {}
  // Merge with homepage events
  try {
    const home = await scrapeHomeEvents();
    items = items.concat(home);
  } catch {}
  const ded = dedupe(items);
  d('time-aware events kept:', ded.length);
  return ded.slice(0, 12);
}

// ========== summarise + post ==========
function titleLine() {
  const nowLA = new Date().toLocaleString('en-US', { timeZone: LA_TZ, month:'short', day:'2-digit', year:'numeric' });
  return `**SMC Digest — ${nowLA} (${LA_TZ})**`;
}

async function detectPublishedFromPage(url, htmlCache) {
  try {
    const html = htmlCache || await getHTML(url);
    const $ = cheerio.load(html);

    const timeDT = $('time[datetime]').attr('datetime') || $('time').first().text();
    let dt = parseDateLoose(timeDT);

    if (!dt) {
      const meta = $('meta[property="article:published_time"]').attr('content')
              || $('meta[name="pubdate"]').attr('content')
              || $('meta[itemprop="datePublished"]').attr('content')
              || $('meta[name="date"]').attr('content');
      dt = parseDateLoose(meta);
    }

    if (!dt) {
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const j = JSON.parse($(el).contents().text());
          const list = Array.isArray(j) ? j : [j];
          for (const item of list) {
            const cand = item?.datePublished || item?.dateCreated || item?.uploadDate;
            const parsed = parseDateLoose(cand);
            if (parsed) { dt = parsed; break; }
          }
        } catch(_) {}
      });
    }
    return dt || null;
  } catch (_) { return null; }
}

async function summarize(items) {
  const pick = items.slice(0, MAX_ITEMS);
  if (pick.length === 0) return [];

  const lines = pick.map((it, i) => `(${i + 1}) [${it.source}] ${it.title}\nLink: ${it.link}\nWhen: ${it.dateText || (it.publishedAt ? new Date(it.publishedAt).toDateString() : '')}`)
                    .join('\n\n');

  const prompt = `\nSummarize each item for SMC students in ONE short sentence.\nUse EXACTLY this format for each bullet (one per line):\n- [${'{Title}'}](${ '{Link}' }) — what/why/when (keep it tight).\nIf a date is known, include it succinctly (e.g., Sep 20, 9am).\n\nItems to summarize (with source, link, and when):\n${lines}\n`.trim();

  if (!openai) {
    return pick.map(it => `- [${it.title}](${it.link}) — ${it.source}`);
  }

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    max_tokens: 400,
    messages: [
      { role: 'system', content: 'You write concise campus bulletins for SMC students. Be factual and brief.' },
      { role: 'user', content: prompt }
    ]
  });

  const text = resp.choices?.[0]?.message?.content?.trim() || '';
  const bullets = text.split('\n').map(s=>s.trim()).filter(l => l.startsWith('-'));
  if (bullets.length) return bullets;

  return pick.map(it => `- [${it.title}](${it.link}) — ${it.source}`);
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

// ========== main ==========
(async () => {
  const client = HAS_DB ? await pool.connect() : null;
  try {
    await ensureTables();

    const results = await Promise.all([
      scrapeNewsroom().catch(e => { console.log('Newsroom scrape error:', e.message); return []; }),
      scrapeEventsTimeAware().catch(e => { console.log('Events scrape error:', e.message); return []; }),
      scrapeCorsair().catch(e => { console.log('Corsair scrape error:', e.message); return []; }),
      scrapeInFocus().catch(e => { console.log('In Focus scrape error:', e.message); return []; }),
      scrapeTrustees().catch(e => { console.log('Trustees scrape error:', e.message); return []; }),
      scrapeAnnouncements().catch(e => { console.log('Announcements scrape error:', e.message); return []; }),
    ]);

    let all = results.flat().map(normItem);
    all = dedupe(all);
    all.sort((a, b) => (new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)));
    all = limitPerSource(all, PER_SOURCE_LIMIT);

    const shortlist = all.slice(0, MAX_ITEMS);
    if (shortlist.length === 0) {
      console.log('ℹ️ No fresh SMC items to post.');
      return;
    }

    d('shortlist:', shortlist.map(x => ({ src: x.source, title: x.title, when: x.dateText || x.publishedAt })).slice(0,10));

    let bullets;
    try {
      bullets = await summarize(shortlist);
    } catch (e) {
      console.log('OpenAI unavailable, fallback to raw titles:', e.message);
      bullets = shortlist.map(it => `- [${it.title}](${it.link}) — ${it.source}`);
    }

    const finalBullets = bullets.slice(0, MAX_ITEMS);

    await postToDiscord(titleLine(), finalBullets);

    for (const it of shortlist) await mark(it);

    console.log(`✅ Posted SMC digest with ${finalBullets.length} items.`);
  } catch (e) {
    console.error('❌ SMC job failed:', e);
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    if (pool) await pool.end();
  }
})();

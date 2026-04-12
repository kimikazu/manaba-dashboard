'use strict';

const express = require('express');
const session = require('express-session');
const axios   = require('axios');
const cheerio = require('cheerio');
const https   = require('https');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'manaba-dashboard-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3 * 60 * 60 * 1000 }
}));

const clients = new Map(); // sessionId → ManabaClient

// ────────────────────────────────────────────
// クッキー手動管理
// ────────────────────────────────────────────
class CookieStore {
  constructor() { this.jar = {}; }

  ingest(setCookieHeaders = []) {
    for (const raw of [].concat(setCookieHeaders)) {
      const [kv] = raw.split(';');
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      const key = kv.slice(0, eq).trim();
      const val = kv.slice(eq + 1).trim();
      this.jar[key] = val;
    }
  }

  header() {
    return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

// ────────────────────────────────────────────
// ManabaClient
// ────────────────────────────────────────────
class ManabaClient {
  constructor(baseUrl, opts = {}) {
    this.baseUrl = normalizeManabaBaseUrl(baseUrl);
    this.cookies = new CookieStore();
    this.opts    = opts;
    this.loggedIn = false;
  }

  _resolveUrl(urlOrPath, basePath = '/') {
    if (!urlOrPath) return this.baseUrl;
    const base = new URL(basePath, `${this.baseUrl}/`).toString();
    return new URL(urlOrPath, base).toString();
  }

  _cfg(extra = {}) {
    const cfg = {
      timeout: 30000,
      maxRedirects: 10,
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': this.cookies.header(),
        ...(extra.headers || {})
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: !this.opts.ignoreTls }),
    };

    const proxyUrl = this.opts.proxy
      || process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY  || process.env.http_proxy || '';
    if (proxyUrl) {
      try {
        const u = new URL(proxyUrl);
        cfg.proxy = { host: u.hostname, port: parseInt(u.port) || 80, protocol: u.protocol.replace(':', '') };
      } catch (_) {}
    }

    return { ...cfg, ...extra, headers: cfg.headers };
  }

  async _get(urlOrPath, basePath = '/') {
    const url = this._resolveUrl(urlOrPath, basePath);
    const res = await axios.get(url, this._cfg());
    this.cookies.ingest(res.headers['set-cookie']);
    await sleep(800);
    const $ = cheerio.load(res.data);
    $.meta = { requestedUrl: url, finalUrl: responseFinalUrl(res), status: res.status };
    return $;
  }

  async _post(urlOrPath, payload, basePath = '/') {
    const url = this._resolveUrl(urlOrPath, basePath);
    const res = await axios.post(url, new URLSearchParams(payload).toString(),
      this._cfg({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
    this.cookies.ingest(res.headers['set-cookie']);
    await sleep(800);
    const $ = cheerio.load(res.data);
    $.meta = { requestedUrl: url, finalUrl: responseFinalUrl(res), status: res.status };
    return $;
  }

  // ── ログイン ──────────────────────────────
  async login(username, password) {
    const $ = await this._get('/ct/login');
    const form = $('form').first();
    if (!form.length) throw new Error('ログインフォームが見つかりません。manaba URL を確認してください。');

    const payload = {};
    form.find('input').each((_, el) => {
      const name = $(el).attr('name');
      if (name) payload[name] = $(el).val() || '';
    });

    const keys  = Object.keys(payload);
    const idKey = ['userid', 'username', 'loginid', 'login_id', 'user_id']
      .find(k => keys.includes(k))
      || keys.find(k => /userid|username/i.test(k))
      || keys.find(k => /user/i.test(k) && !/pass/i.test(k))
      || 'username';
    const pwKey = keys.find(k => /pass|pwd/i.test(k)) || 'password';

    console.log(`[login] ID="${idKey}" PW="${pwKey}"`);
    payload[idKey] = username;
    payload[pwKey] = password;

    const action = form.attr('action') || '/ct/login';
    const $res = await this._post(action, payload, '/ct/login');

    if ($res('input[type="password"]').length > 0) {
      throw new Error('ログイン失敗: IDまたはパスワードを確認してください。');
    }
    const $home = await this._get('/ct/home');
    const homeCourses = collectCourseCandidates($home, this.baseUrl);
    console.log(`[login] home status=${$home.meta.status} final=${$home.meta.finalUrl} title="${pageTitle($home)}" courses=${homeCourses.length}`);
    if ($home('input[type="password"]').length > 0) {
      throw new Error('ログイン後に /ct/home へ到達できませんでした。リダイレクト先がログイン画面のままです。');
    }
    this.loggedIn = true;
    console.log('[login] 成功');
    return true;
  }

  // ── コース一覧 ────────────────────────────
  async getCourses(yearFilter = '') {
    // manaba はバージョン・設定により URL が異なるため複数候補を試す
    const candidates = ['/ct/home_course', '/ct/home', '/ct/home_course_list', '/ct/courselist'];
    let $ = null;
    for (const p of candidates) {
      try {
        const loaded = await this._get(p);
        const courseCandidates = collectCourseCandidates(loaded, this.baseUrl);
        console.log(`[courses] try ${p} status=${loaded.meta.status} final=${loaded.meta.finalUrl} title="${pageTitle(loaded)}" candidates=${courseCandidates.length}`);
        if (courseCandidates.length > 0) { $ = loaded; console.log(`[courses] URL候補: ${p}`); break; }
      } catch (_) {}
    }
    if (!$) throw new Error('コース一覧ページが見つかりませんでした');

    const seen = new Set();
    const courses = [];

    collectCourseCandidates($, this.baseUrl, yearFilter).forEach(c => {
      if (seen.has(c.id)) return;
      seen.add(c.id);
      courses.push(c);
    });

    console.log(`[courses] ${courses.length} 件検出`);
    return courses;
  }

  // ── レポート一覧 ──────────────────────────
  async getReports(course, onProgress) {
    const { id: cid, name: cname } = course;
    let $;
    try { $ = await this._get(`/ct/${cid}_report`); }
    catch (_) { return []; }

    const reports = [];
    const anchors = $(`a[href*="${cid}_report_"]`).toArray();
    const seen = new Set();

    for (let i = 0; i < anchors.length; i++) {
      const el    = anchors[i];
      const href  = $(el).attr('href') || '';
      const rid   = extractReportId(href, cid, this.baseUrl);
      const title = cleanText($(el).text());
      if (!title || !rid) continue;
      const key = `${rid}:${title}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const row      = $(el).closest('tr, li, .report-item');
      const rowText  = cleanText(row.text());
      const deadline = extractDeadline(rowText);
      const status   = (rowText.match(/受付中|未開始|受付終了|終了|公開中|公開|締切済|締切/) || [''])[0];

      const { submitted, total } = await this._counts(href, `/ct/${cid}_report`);
      const rate = total > 0 ? Math.round(submitted / total * 1000) / 10 : null;

      reports.push({ cid, cname, rid, title, deadline, status, submitted, total, rate,
        url: this._resolveUrl(href, `/ct/${cid}_report`) });
      if (onProgress) onProgress({ course: cname, report: title, done: i + 1, total: anchors.length });
    }
    return reports;
  }

  async _counts(urlPath, basePath = '/') {
    try {
      const paths = reportCountCandidatePaths(urlPath);
      let fallback = { submitted: 0, total: 0 };
      for (const p of paths) {
        const $ = await this._get(p, basePath);
        const counts = parseReportCounts($);
        console.log(`[counts] ${p} final=${$.meta.finalUrl} submitted=${counts.submitted} total=${counts.total}`);
        if (counts.submitted > 0 || counts.total > 0) return counts;
        fallback = counts;
      }
      return fallback;
    } catch { return { submitted: 0, total: 0 }; }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sseWrite(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function cleanText(text = '') { return String(text).replace(/\u00a0/g, ' ').replace(/[ \t\r\f\v]+/g, ' ').trim(); }
function responseFinalUrl(res) {
  return res.request?.res?.responseUrl || res.request?._currentUrl || res.config?.url || '';
}
function pageTitle($) {
  return cleanText($('title').first().text());
}
function extractDeadline(text = '') {
  const normalized = cleanText(text);
  return (normalized.match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?/) || [''])[0];
}
function collectCourseCandidates($, baseUrl, yearFilter = '') {
  const seen = new Set();
  const courses = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const id = extractCourseId(href, baseUrl);
    if (!id || seen.has(id)) return;

    let name = cleanText($(el).text())
      || cleanText($(el).attr('title'))
      || cleanText($(el).find('img').attr('alt'))
      || cleanText($(el).closest('.coursecard').find('.course-card-title a').first().text())
      || cleanText($(el).parent().text()).split('\n')[0].trim();
    if (!name || name.length < 2) return;
    if (yearFilter && !name.includes(yearFilter)) return;

    seen.add(id);
    courses.push({ id, name: name.slice(0, 80), url: href });
  });
  return courses;
}
function parseReportCounts($) {
  const text = cleanText($.text());
  const slash = text.match(/提出(?:済み?|者)?\s*[：:]?\s*(\d+)\s*[/／]\s*(\d+)/);
  const summarySubmitted = extractSubmittedSummary($) || (slash ? parseInt(slash[1], 10) : 0);
  const mUnsub = text.match(/未提出\s*[：:]?\s*(\d+)\s*(?:名|人|件)?/);
  const mTotal = slash || text.match(/(?:全|総|受講者?|履修者?|学生数|対象者?)\s*[：:]?\s*(\d+)\s*(?:名|人|件)/);

  let submitted = summarySubmitted || 0;
  let total = mTotal ? parseInt(mTotal[2] || mTotal[1], 10) : 0;
  if (total === 0 && submitted > 0 && mUnsub) total = submitted + parseInt(mUnsub[1], 10);

  const studentRows = collectionStudentRows($);
  if (studentRows.length > 0) {
    total = Math.max(total, studentRows.length);
    if (submitted === 0) submitted = studentRows.filter(r => hasSubmissionDate($, r)).length;
  }

  if (total === 0) {
    const rows = $('table tr').slice(1).toArray();
    total = rows.length;
    if (submitted === 0)
      rows.forEach(r => { if (/提出済|済|○|✓/.test(cleanText($(r).text()))) submitted++; });
  }

  return { submitted, total };
}
function reportCountCandidatePaths(urlPath = '') {
  const candidates = [];
  const m = String(urlPath).match(/course_(\d+)_report_(\d+)/);
  if (m) candidates.push(`course_${m[1]}_collectiontop_${m[2]}`);
  candidates.push(urlPath);
  return [...new Set(candidates)];
}
function extractSubmittedSummary($) {
  let submitted = 0;
  $('table.stdlist tr').each((_, row) => {
    const th = cleanText($(row).find('th').first().text());
    if (!/提出者/.test(th)) return;
    const m = cleanText($(row).find('td').first().text()).match(/(\d+)\s*名/);
    if (m) submitted = parseInt(m[1], 10);
  });
  if (submitted > 0) return submitted;
  const m = cleanText($.text()).match(/提出者\s*[（(]\s*履修生\s*[）)]\s*(\d+)\s*名/);
  return m ? parseInt(m[1], 10) : 0;
}
function collectionStudentRows($) {
  return $('table.sorttable tr').toArray().filter(row => {
    const $row = $(row);
    if ($row.find('th').length > 0) return false;
    if ($row.find('td').length === 0) return false;
    return $row.find('td.name, .listcollection_td_left, a[href*="_collectiondetail_"]').length > 0;
  });
}
function hasSubmissionDate($, row) {
  return /\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2}/.test(cleanText($(row).text()));
}
function extractReportId(href = '', courseId = '', baseUrl = '') {
  try {
    const path = new URL(href, `${baseUrl}/ct/${courseId}_report`).pathname;
    return (path.match(new RegExp(`/ct/${courseId}_report_([^/]+)`)) || [])[1] || '';
  } catch (_) {
    return (href.match(new RegExp(`${courseId}_report_([^/?#]+)`)) || [])[1] || '';
  }
}
function extractCourseId(href = '', baseUrl = '') {
  try {
    const path = new URL(href, `${baseUrl}/ct/home`).pathname;
    const token = (path.match(/^\/ct\/([^/?#]+)\/?$/) || [])[1] || '';
    if (!token) return '';
    if (/^course_\d+$/.test(token)) return token;
    if (/^course_\d+_/.test(token)) return '';
    if (/_(report|query|survey|bbs|thread|content|grade|member|attendance|profile|setting|login|logout|top|home|favoritecourse|campusnews|usermemo|submitlog|library|lang|preferences|releasenotes)($|_|\d)/i.test(token)) return '';
    if (/^(home|logout|login|doc_|user_|public|course_)|_(set|view)$/i.test(token)) return '';
    return /^[A-Za-z0-9][A-Za-z0-9_]{3,}$/.test(token) ? token : '';
  } catch (_) {
    return '';
  }
}
function normalizeManabaBaseUrl(baseUrl = '') {
  const trimmed = String(baseUrl).trim().replace(/\/$/, '');
  try {
    const url = new URL(trimmed);
    return url.pathname.startsWith('/ct') ? url.origin : trimmed;
  } catch (_) {
    return trimmed;
  }
}

// ────────────────────────────────────────────
// API
// ────────────────────────────────────────────

// GET /api/debug/links - ログイン後にページ内のリンクを全ダンプ（開発用）
app.get('/api/debug/links', async (req, res) => {
  const client = clients.get(req.sessionID);
  if (!client) return res.status(401).json({ error: '未ログインです' });

  const targetPath = req.query.path || '/ct/home';
  try {
    const $ = await client._get(targetPath);
    const links = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim().slice(0, 60);
      if (href) links.push({ href, text });
    });
    // /ct/ を含むリンクと、manaba の course_123456 形式の相対リンクを返す
    const ctLinks = links.filter(l => l.href.includes('/ct/') || extractCourseId(l.href, client.baseUrl));
    res.json({ path: targetPath, total: links.length, ctLinks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/debug/session', async (req, res) => {
  const client = clients.get(req.sessionID);
  if (!client) return res.status(401).json({ error: '未ログインです' });

  const targetPath = req.query.path || '/ct/home';
  try {
    const $ = await client._get(targetPath);
    const courses = collectCourseCandidates($, client.baseUrl);
    const links = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const id = extractCourseId(href, client.baseUrl);
      if (id) links.push({ id, href, text: cleanText($(el).text()).slice(0, 80) });
    });
    res.json({
      requestedPath: targetPath,
      baseUrl: client.baseUrl,
      status: $.meta.status,
      finalUrl: $.meta.finalUrl,
      title: pageTitle($),
      hasPasswordInput: $('input[type="password"]').length > 0,
      courseCount: courses.length,
      courses: courses.slice(0, 20),
      courseLinks: links.slice(0, 40)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/diagnose', async (req, res) => {
  const url = (req.query.url || '').replace(/\/$/, '');
  if (!url) return res.status(400).json({ error: 'url が必要です' });
  const proxy = req.query.proxy || '';
  const ignoreTls = req.query.ignoreTls === 'true';
  const steps = [];
  try {
    const { hostname } = new URL(url);
    const addrs = await require('dns').promises.resolve4(hostname).catch(e => ({ error: e.message }));
    steps.push({ step: 'DNS解決', ok: !addrs.error, detail: addrs.error || addrs.join(', ') });

    const client = new ManabaClient(url, { proxy, ignoreTls });
    const r = await axios.get(`${url}/ct/login`, client._cfg({ timeout: 10000, maxRedirects: 5, validateStatus: () => true }));
    steps.push({ step: 'HTTP接続', ok: r.status < 500, detail: `HTTP ${r.status}` });

    const $ = cheerio.load(r.data);
    const fields = [];
    $('form input').each((_, el) => { const n = $(el).attr('name'); if (n) fields.push(n); });
    steps.push({ step: 'ログインフォーム', ok: fields.length > 0,
      detail: fields.length > 0 ? `検出: ${fields.join(', ')}` : '見つかりません' });

    res.json({ ok: steps.every(s => s.ok), steps, proxy: proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '未使用' });
  } catch (e) {
    steps.push({ step: 'エラー', ok: false, detail: e.message });
    res.json({ ok: false, steps, proxy: proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '未使用' });
  }
});

app.post('/api/login', async (req, res) => {
  const { baseUrl, username, password, proxy, ignoreTls } = req.body;
  if (!baseUrl || !username || !password)
    return res.status(400).json({ error: '必須項目が不足しています' });
  try {
    const client = new ManabaClient(baseUrl, { proxy, ignoreTls });
    await client.login(username, password);
    clients.set(req.sessionID, client);
    req.session.manabaLoggedIn = true;
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'セッション保存に失敗しました' });
      res.json({ ok: true });
    });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.get('/api/courses', async (req, res) => {
  const client = clients.get(req.sessionID);
  if (!client) return res.status(401).json({ error: '未ログインです' });
  try {
    res.json({ courses: await client.getCourses(req.query.year || '') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/aggregate', async (req, res) => {
  const client = clients.get(req.sessionID);
  if (!client) { res.status(401).end(); return; }

  const courseIds  = (req.query.courses || '').split(',').filter(Boolean);
  const allCourses = await client.getCourses(req.query.year || '');
  const targets    = courseIds.length ? allCourses.filter(c => courseIds.includes(c.id)) : allCourses;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const course = targets[i];
    sseWrite(res, 'progress', { phase: 'course', name: course.name, index: i + 1, total: targets.length });
    const reports = await client.getReports(course, p => sseWrite(res, 'progress', { phase: 'report', ...p }));
    results.push(...reports);
    sseWrite(res, 'courseResult', { course: course.name, count: reports.length, reports });
  }

  req.session.lastResult = results;
  sseWrite(res, 'done', { total: results.length });
  res.end();
});

app.get('/api/export/csv', (req, res) => {
  const data = req.session.lastResult;
  if (!data?.length) return res.status(404).json({ error: 'データがありません' });
  const headers = ['コース名', 'レポートタイトル', '締切', '状態', '登録学生数', '提出済', '未提出', '提出率(%)', 'URL'];
  const rows = data.map(r => [r.cname, r.title, r.deadline, r.status,
    r.total, r.submitted, Math.max(0, r.total - r.submitted), r.rate ?? '', r.url]);
  const csv = [headers, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8-sig');
  res.setHeader('Content-Disposition', `attachment; filename="manaba_reports_${ts}.csv"`);
  res.send('\uFEFF' + csv);
});

app.post('/api/logout', (req, res) => {
  clients.delete(req.sessionID);
  req.session.destroy();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🎓 manaba ダッシュボード → http://localhost:${PORT}\n`));

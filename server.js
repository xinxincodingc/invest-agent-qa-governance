'use strict';
/**
 * 零依赖 Node HTTP 服务：静态页面 + 评测 API。
 * 启动：node server.js（PORT 默认 3000）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const E = require('./src/engine/evaluate');
const { METRICS, INTENT_METRICS, DIVISION, INVARIANTS, REQUIRED_ELEMENTS } = require('./src/engine/rubric');
const { ROOT_CAUSES, ISSUE_LABELS } = require('./src/engine/attribution');
const { FAULT_MODES, createSource } = require('./src/engine/factsource');
const { sanitize, KYC_ALLOWED_FIELDS, KYC_FORBIDDEN_FIELDS } = require('./src/engine/privacy');
const { INTENT_LABELS } = require('./src/data/catalog');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const REVIEW_FILE = process.env.REVIEW_FILE || path.join(__dirname, 'data', 'reviews.json');

// ---------- 人工复核存储（文件持久化，失败时退化为内存） ----------
let reviews = {};
try { reviews = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8')); } catch { reviews = {}; }
let reviewPersist = true;
function saveReviews() {
  try { fs.writeFileSync(REVIEW_FILE, JSON.stringify(reviews, null, 2)); } catch { reviewPersist = false; }
}

// ---------- 评测缓存 ----------
const DATA = E.loadData();
const cache = new Map();
async function getEval(fault = 'none') {
  if (!FAULT_MODES[fault]) fault = 'none';
  if (!cache.has(fault)) cache.set(fault, E.evaluateAll({ data: DATA, fault }));
  return cache.get(fault);
}

function light(r) {
  const hv = reviews[r.id];
  return {
    id: r.id, version: r.version, question_id: r.question_id, intent: r.intent, kyc_id: r.kyc_id, question: r.question,
    answer: r.answer, verdict: r.verdict, score: r.score, issues: r.issues, primary_cause: r.attribution.primary,
    review: r.review, feedback: r.feedback, human: hv || null,
  };
}

function filterCases(results, q) {
  let rs = results;
  if (q.ids) { const s = new Set(String(q.ids).split(',')); rs = rs.filter((r) => s.has(r.id)); }
  if (q.version) rs = rs.filter((r) => r.version === q.version);
  if (q.intent) rs = rs.filter((r) => r.intent === q.intent);
  if (q.verdict) rs = rs.filter((r) => r.verdict === q.verdict);
  if (q.issue) rs = rs.filter((r) => r.issues.includes(q.issue));
  if (q.cause) rs = rs.filter((r) => r.attribution.causes.some((c) => c.cause === q.cause));
  if (q.trigger) rs = rs.filter((r) => r.review.some((t) => t.trigger === q.trigger));
  if (q.kyc) rs = rs.filter((r) => r.kyc_id === q.kyc);
  if (q.metric) rs = rs.filter((r) => r.metric_status[q.metric] === (q.mstatus || 'fail'));
  if (q.q) rs = rs.filter((r) => (r.question + r.answer + r.id).includes(q.q));
  return rs;
}

function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'content-type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('invalid JSON')); } });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

async function buildReport(fault) {
  const ev = await getEval(fault);
  const chain = [['v1', 'v2'], ['v2', 'v3'], ['v3', 'v4'], ['v1', 'v4']].map(([a, b]) => {
    const c = E.compareVersions(ev.results, a, b);
    return { base: a, cand: b, pass_rate: [c.summary.base.pass_rate, c.summary.cand.pass_rate], test: c.summary.test, metrics: c.metrics, causes: c.causes, fixed: c.fixed.length, regressed: c.regressed.map((x) => x.cand) };
  });
  return {
    meta: ev.meta,
    versions: E.byVersion(ev.results, DATA.versions).map((v) => ({ id: v.version.id, label: v.version.label, model: v.version.model, prompt: v.version.prompt, data: v.version.data, ...pick(v.summary, ['n', 'pass', 'fail', 'pending', 'pass_rate', 'avg_score', 'claim_accuracy', 'claim_fresh', 'claims_total', 'claims_verifiable', 'components', 'review', 'review_cases']), metrics: Object.fromEntries(Object.entries(v.summary.metrics).map(([k, m]) => [k, { rate: m.rate, fail: m.fail, applicable: m.applicable }])), causes: Object.fromEntries(Object.entries(v.summary.causes).map(([k, c]) => [k, c.count])) })),
    compare_chain: chain,
    evaluator_accuracy: E.evaluatorAccuracy(ev.results, DATA.gold, {}),
    feedback: E.feedbackAnalysis(ev.results),
    cross_profile: summarizeGroups(ev.groups),
  };
}
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
function summarizeGroups(groups) {
  const out = {};
  for (const g of groups) { out[g.version] = out[g.version] || { groups: 0, consistent: 0, inconsistent_keys: [] }; out[g.version].groups++; if (g.consistent) out[g.version].consistent++; else out[g.version].inconsistent_keys.push(g.key); }
  return out;
}

const routes = {
  'GET /api/meta': async () => ({
    versions: DATA.versions, intents: INTENT_LABELS, metrics: METRICS, intent_metrics: INTENT_METRICS, division: DIVISION, invariants: INVARIANTS,
    required_elements: Object.fromEntries(Object.entries(REQUIRED_ELEMENTS).map(([k, v]) => [k, v.map((x) => x.label)])),
    root_causes: ROOT_CAUSES, issue_labels: ISSUE_LABELS, fault_modes: FAULT_MODES, kyc: DATA.kyc, hot: DATA.hot, questions: DATA.questions,
    kyc_allowed_fields: KYC_ALLOWED_FIELDS, kyc_forbidden_fields: KYC_FORBIDDEN_FIELDS,
    source: { mode: process.env.FACT_SOURCE === 'mcp' && process.env.IFIND_MCP_URL ? 'ifind-mcp' : 'snapshot', mcp_configured: !!process.env.IFIND_MCP_URL },
    llm: { configured: !!(process.env.LLM_API_KEY && process.env.LLM_MODEL), model: process.env.LLM_MODEL || null },
    data_hash: DATA.data_hash, engine_version: E.ENGINE_VERSION, review_persist: reviewPersist, n_logs: DATA.logs.length,
  }),
  'GET /api/overview': async (q) => {
    const ev = await getEval(q.fault);
    return {
      meta: ev.meta,
      versions: E.byVersion(ev.results, DATA.versions),
      accuracy: E.evaluatorAccuracy(ev.results, DATA.gold, reviews),
      feedback: E.feedbackAnalysis(ev.results),
      cross_profile: summarizeGroups(ev.groups),
    };
  },
  'GET /api/cases': async (q) => {
    const ev = await getEval(q.fault);
    const rs = filterCases(ev.results, q);
    return { total: rs.length, items: rs.slice(0, Number(q.limit || 500)).map(light) };
  },
  'GET /api/compare': async (q) => {
    const ev = await getEval(q.fault);
    return E.compareVersions(ev.results, q.base || 'v1', q.cand || 'v4');
  },
  'GET /api/groups': async (q) => {
    const ev = await getEval(q.fault);
    return ev.groups.filter((g) => (!q.version || g.version === q.version));
  },
  'GET /api/review/queue': async (q) => {
    const ev = await getEval(q.fault);
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    let rs = ev.results.filter((r) => r.review.length);
    if (q.version) rs = rs.filter((r) => r.version === q.version);
    if (q.trigger) rs = rs.filter((r) => r.review.some((t) => t.trigger === q.trigger));
    if (q.status === 'todo') rs = rs.filter((r) => !reviews[r.id]);
    if (q.status === 'done') rs = rs.filter((r) => reviews[r.id]);
    rs.sort((a, b) => Math.min(...a.review.map((t) => order[t.priority])) - Math.min(...b.review.map((t) => order[t.priority])));
    const done = Object.keys(reviews).length;
    const agree = Object.entries(reviews).filter(([id, h]) => { const r = ev.results.find((x) => x.id === id); return r && ((h.verdict === 'pass') === (r.verdict === 'pass')); }).length;
    return { total: rs.length, done, agreement: done ? Math.round((agree / done) * 1000) / 10 : null, items: rs.slice(0, 300).map(light) };
  },
  'GET /api/report': async (q) => buildReport(q.fault),
  'GET /api/source/health': async (q) => {
    const src = createSource({ fault: q.fault || 'none' });
    const probes = [['quote', '600519.SH'], ['nav', '970002.OF'], ['financial', '300750.SZ'], ['fund', '970001.OF'], ['announcement', '300750.SZ'], ['valuation', '300750.SZ']];
    const out = [];
    for (const [k, key] of probes) { const t = Date.now(); const r = await src.query(k, key); out.push({ kind: k, key, ok: r.ok, ms: Date.now() - t, attempts: r.attempts, error: r.error || null, source_id: r.source_id || null, as_of: r.as_of || null }); }
    return { source: src.name, fault: q.fault || 'none', probes: out };
  },
};

async function handle(req, res) {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  try {
    const key = `${req.method} ${p}`;
    if (routes[key]) return send(res, 200, await routes[key](u.query));
    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/cases\/([\w-]+)$/))) {
      const ev = await getEval(u.query.fault);
      const r = ev.results.find((x) => x.id === m[1]);
      if (!r) return send(res, 404, { error: 'case not found' });
      const gold = DATA.gold.find((g) => g.log_id === r.id);
      const siblings = r.cross_profile ? ev.results.filter((x) => x.cross_profile && x.cross_profile.group === r.cross_profile.group && x.id !== r.id).map(light) : [];
      const other = ev.results.filter((x) => x.id !== r.id && x.id.replace(/^L-v\d+-/, '') === r.id.replace(/^L-v\d+-/, '')).map(light);
      return send(res, 200, { ...r, human: reviews[r.id] || null, gold: gold ? gold.defects : null, siblings, other_versions: other });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/review\/([\w-]+)$/))) {
      const body = await readBody(req);
      const ev = await getEval('none');
      if (!ev.results.find((x) => x.id === m[1])) return send(res, 404, { error: 'case not found' });
      if (!['pass', 'fail'].includes(body.verdict)) return send(res, 400, { error: 'verdict 必须为 pass 或 fail' });
      const labels = Array.isArray(body.labels) ? body.labels.filter((l) => ISSUE_LABELS[l]) : [];
      if (body.verdict === 'fail' && !labels.length) return send(res, 400, { error: '判定失败时至少选择一个问题标签' });
      reviews[m[1]] = { verdict: body.verdict, labels, root_cause: ROOT_CAUSES[body.root_cause] ? body.root_cause : null, note: sanitize(String(body.note || '').slice(0, 500)).text, reviewer: String(body.reviewer || 'reviewer').slice(0, 40), ts: new Date().toISOString() };
      saveReviews();
      return send(res, 200, { ok: true, review: reviews[m[1]], persisted: reviewPersist });
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/review\/([\w-]+)$/))) {
      delete reviews[m[1]]; saveReviews(); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/evaluate') {
      const body = await readBody(req);
      if (!body.answer || !String(body.answer).trim()) return send(res, 400, { error: 'answer 不能为空' });
      if (!INTENT_METRICS[body.intent]) return send(res, 400, { error: `intent 必须是 ${Object.keys(INTENT_METRICS).join('/')}` });
      const sq = sanitize(String(body.question || '').slice(0, 2000));
      const sa = sanitize(String(body.answer).slice(0, 4000));
      const qdef = DATA.questions.find((x) => x.id === body.question_id);
      const log = {
        id: 'ADHOC-' + Date.now(), version: 'adhoc', question_id: qdef ? qdef.id : 'ADHOC', intent: body.intent, kyc_id: DATA.kyc.find((k) => k.id === body.kyc_id) ? body.kyc_id : 'K3',
        question: sq.text, answer: sa.text, entity: body.entity || null, expect_terms: body.expect_terms || [], data_snapshot: 'live',
        hot_context_ids: Array.isArray(body.hot_context_ids) ? body.hot_context_ids : [], ingestion: { pii_in_question: sq.findings, pii_in_answer: sa.findings }, feedback: {},
      };
      const source = createSource({ fault: body.fault || 'none' });
      const t = Date.now();
      const r = await E.evaluateLog(log, { source, questions: DATA.questions, kyc: DATA.kyc, hot: DATA.hot, judge: body.judge === 'llm' ? 'llm' : 'heuristic' });
      return send(res, 200, { ...r, elapsed_ms: Date.now() - t, source_calls: source.calls, sanitized: { question: sq, answer: { text: sa.text, findings: sa.findings } } });
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    // static
    let file = path.join(PUBLIC, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, e.message === 'invalid JSON' ? 400 : 500, { error: e.message });
  }
}

if (require.main === module) {
  http.createServer(handle).listen(PORT, () => console.log(`治理平台已启动：http://localhost:${PORT}`));
  getEval('none').then((ev) => console.log(`预热完成：${ev.meta.n} 条日志，data_hash=${ev.meta.data_hash}`));
}
module.exports = { handle, getEval, buildReport };

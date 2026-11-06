'use strict';
/**
 * 评测编排：抽取 → 核验 → 规则/评审 → 跨画像对照 → 判定 → 归因 → 复核路由 → 聚合/版本对比/评测器准确率。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractClaims } = require('./extract');
const { verifyAll } = require('./verify');
const { runChecks } = require('./checks');
const { judgeRelevance } = require('./judge');
const { METRICS, INTENT_METRICS, WEIGHT } = require('./rubric');
const { attribute, route, ROOT_CAUSES, ISSUE_TO_CAUSE } = require('./attribution');
const { createSource } = require('./factsource');
const { projectKyc } = require('./privacy');

const ENGINE_VERSION = '1.0.0';
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));

function loadData() {
  const files = ['logs.json', 'kyc.json', 'questions.json', 'versions.json', 'hot_context.json', 'facts_snapshot.json', 'gold_labels.json'];
  const hash = crypto.createHash('sha256');
  files.forEach((f) => hash.update(fs.readFileSync(path.join(DATA_DIR, f))));
  return {
    logs: readJson('logs.json'), kyc: readJson('kyc.json'), questions: readJson('questions.json'), versions: readJson('versions.json'),
    hot: readJson('hot_context.json'), gold: readJson('gold_labels.json'), data_hash: hash.digest('hex').slice(0, 12),
  };
}

const INVARIANT_METRICS = new Set(['risk_level', 'max_dd', 'nav', 'mgmt_fee', 'ret_1y', 'close', 'pct_chg', 'revenue', 'net_profit', 'np_yoy', 'price_cap']);

async function evaluateLog(log, deps) {
  const { source, questions, kyc: kycList, hot, judge } = deps;
  const question = questions.find((q) => q.id === log.question_id) || { id: 'ADHOC', intent: log.intent, entity: log.entity || null, text: log.question, expect_terms: log.expect_terms || [] };
  const kyc = projectKyc(kycList.find((k) => k.id === log.kyc_id) || kycList[0]);
  // 传闻类热点即使被过滤未注入，也要用于检测「用户自带传闻 → 回答当事实」
  const hotItems = hot.filter((h) => (log.hot_context_ids || []).includes(h.id) || (log.intent === 'hot_event' && h.credibility === 'rumor'));
  const claims = extractClaims(log.answer);
  const verifs = await verifyAll(claims, source, {});
  const relevance = INTENT_METRICS[log.intent].includes('REL') ? await judgeRelevance(question, log.answer, { judge }) : null;
  const riskCache = {};
  const riskOf = async (code) => {
    if (!riskCache[code]) {
      const r = await source.query('fund', code);
      riskCache[code] = r.ok ? { ok: true, level: r.data.risk_level, source_id: r.source_id } : { ok: false, error: r.error };
    }
    return riskCache[code];
  };
  let checks = await runChecks({ log, question, kyc, claims, verifs, relevance, riskOf, hotItems });
  const allowed = new Set(INTENT_METRICS[log.intent]);
  checks = checks.filter((c) => allowed.has(c.metric)).map((c) => ({ ...c, metric_name: METRICS[c.metric].name, severity: METRICS[c.metric].severity, layer: METRICS[c.metric].layer }));
  return finalize({ log, question, kyc, claims, verifs, checks, relevance, hotItems });
}

function finalize(r) {
  const { log, checks } = r;
  const failing = checks.filter((c) => c.status === 'fail' && (c.severity === 'block' || c.severity === 'major'));
  const unver = checks.filter((c) => c.status === 'unverifiable');
  const verdict = failing.length ? 'fail' : unver.length ? 'pending' : 'pass';
  // 指标级：同一 metric 多条检查时，任一 fail 即 fail
  const metricStatus = {};
  for (const c of checks) {
    const prev = metricStatus[c.metric];
    const rank = { fail: 4, unverifiable: 3, warn: 2, pass: 1, na: 0 };
    if (!prev || rank[c.status] > rank[prev]) metricStatus[c.metric] = c.status;
  }
  let w = 0, got = 0;
  for (const [m, s] of Object.entries(metricStatus)) {
    if (s === 'na' || s === 'unverifiable') continue;
    const wt = WEIGHT[METRICS[m].severity]; w += wt; if (s === 'pass' || s === 'warn') got += wt;
  }
  const score = w ? Math.round((got / w) * 100) : 100;
  const attribution = attribute(checks, METRICS);
  const issues = [...new Set(checks.filter((c) => c.status === 'fail' && c.issue).map((c) => c.issue))].sort();
  const result = {
    id: log.id, version: log.version, question_id: log.question_id, intent: log.intent, kyc_id: log.kyc_id, ts: log.ts,
    question: log.question, answer: log.answer, data_snapshot: log.data_snapshot, hot_context_ids: log.hot_context_ids,
    kyc: r.kyc, feedback: log.feedback, ingestion: log.ingestion,
    claims: r.claims, verifs: r.verifs, checks, metric_status: metricStatus, verdict, score, issues, attribution,
    relevance: r.relevance, hot_items: r.hotItems.map((h) => ({ id: h.id, credibility: h.credibility, date: h.date, expired: !!h.expired, text: h.text, injected: (log.hot_context_ids || []).includes(h.id) })),
  };
  result.review = route(result, log);
  return result;
}

/** 跨画像对照：同一版本、同一问题、同一采样序号下，不同 KYC 的不变事实是否一致 */
function crossProfile(results) {
  const groups = {};
  for (const r of results) {
    if (!r.question_id || r.question_id === 'ADHOC') continue;
    const s = r.id.split('-').pop();
    const k = `${r.version}|${r.question_id}|${s}`;
    (groups[k] = groups[k] || []).push(r);
  }
  const out = [];
  for (const [k, rs] of Object.entries(groups)) {
    if (rs.length < 2) continue;
    const facts = {};
    for (const r of rs) for (const v of r.verifs) {
      if (!INVARIANT_METRICS.has(v.metric) || v.stated == null) continue;
      const fk = `${v.entity}|${v.metric}`;
      facts[fk] = facts[fk] || { entity: v.entity, metric: v.metric, expected: v.expected, by_kyc: {} };
      facts[fk].by_kyc[r.kyc_id] = v.stated;
    }
    const diffs = Object.values(facts).filter((f) => Object.keys(f.by_kyc).length > 1 && new Set(Object.values(f.by_kyc).map(String)).size > 1);
    const [version, question_id] = k.split('|');
    out.push({ key: k, version, question_id, intent: rs[0].intent, case_ids: rs.map((r) => r.id), kyc_ids: rs.map((r) => r.kyc_id), consistent: diffs.length === 0, diffs, compared: Object.keys(facts).length });
    for (const r of rs) r.cross_profile = { group: k, consistent: diffs.length === 0, diffs };
  }
  return out;
}

async function evaluateAll(opts = {}) {
  const data = opts.data || loadData();
  const source = opts.source || createSource({ fault: opts.fault || 'none' });
  const deps = { source, questions: data.questions, kyc: data.kyc, hot: data.hot, judge: opts.judge || 'heuristic' };
  const logs = opts.logs || data.logs;
  const results = [];
  for (const log of logs) results.push(await evaluateLog(log, deps));
  const groups = crossProfile(results);
  return { results, groups, meta: { engine_version: ENGINE_VERSION, data_hash: data.data_hash, fault: opts.fault || 'none', judge: deps.judge, source: source.name, generated_at: new Date().toISOString(), n: results.length } };
}

// ---------------- 聚合 ----------------
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function aggregate(results, filterFn = () => true) {
  const rs = results.filter(filterFn);
  const n = rs.length;
  const cnt = (v) => rs.filter((r) => r.verdict === v).length;
  const metrics = {};
  for (const m of Object.keys(METRICS)) {
    const app = rs.filter((r) => r.metric_status[m] && r.metric_status[m] !== 'na');
    const pass = app.filter((r) => ['pass', 'warn'].includes(r.metric_status[m])).length;
    const fail = app.filter((r) => r.metric_status[m] === 'fail').length;
    const unv = app.filter((r) => r.metric_status[m] === 'unverifiable').length;
    if (app.length) metrics[m] = { name: METRICS[m].name, applicable: app.length, pass, fail, unverifiable: unv, rate: m === 'VERIFIABLE' ? pct(pass, app.length) : pct(pass, pass + fail), fail_ids: app.filter((r) => r.metric_status[m] === (m === 'VERIFIABLE' ? 'unverifiable' : 'fail')).map((r) => r.id) };
  }
  const claims = rs.flatMap((r) => r.verifs);
  const verifiable = claims.filter((v) => v.status !== 'unverifiable');
  const causes = {};
  for (const r of rs) for (const c of r.attribution.causes) { causes[c.cause] = causes[c.cause] || { count: 0, case_ids: [] }; if (!causes[c.cause].case_ids.includes(r.id)) { causes[c.cause].count++; causes[c.cause].case_ids.push(r.id); } }
  const components = {};
  for (const [k, v] of Object.entries(causes)) { const comp = ROOT_CAUSES[k].component; components[comp] = (components[comp] || 0) + v.count; }
  const review = {};
  for (const r of rs) for (const t of r.review) review[t.trigger] = (review[t.trigger] || 0) + 1;
  return {
    n, pass: cnt('pass'), fail: cnt('fail'), pending: cnt('pending'), pass_rate: pct(cnt('pass'), n),
    avg_score: n ? Math.round((rs.reduce((s, r) => s + r.score, 0) / n) * 10) / 10 : null,
    claim_accuracy: pct(verifiable.filter((v) => v.status === 'match' || v.status === 'stale').length, verifiable.length),
    claim_fresh: pct(verifiable.filter((v) => v.status === 'match').length, verifiable.length),
    claims_total: claims.length, claims_verifiable: verifiable.length,
    metrics, causes, components, review, review_cases: rs.filter((r) => r.review.length).length,
  };
}

function byVersion(results, versions) {
  return versions.map((v) => ({ version: v, summary: aggregate(results, (r) => r.version === v.id), by_intent: Object.fromEntries(Object.keys(INTENT_METRICS).map((i) => [i, aggregate(results, (r) => r.version === v.id && r.intent === i)])) }));
}

function zTest(p1, n1, p2, n2) {
  const p = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return { z: 0, p_value: 1 };
  const z = (p2 - p1) / se;
  // 标准正态双尾 p 值（Abramowitz-Stegun 近似）
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return { z: Math.round(z * 100) / 100, p_value: Math.round(2 * tail * 1000) / 1000 };
}

function compareVersions(results, baseId, candId) {
  const A = results.filter((r) => r.version === baseId);
  const B = results.filter((r) => r.version === candId);
  const sa = aggregate(results, (r) => r.version === baseId);
  const sb = aggregate(results, (r) => r.version === candId);
  const key = (r) => r.id.replace(/^L-v\d+-/, '');
  const mapA = Object.fromEntries(A.map((r) => [key(r), r]));
  const fixed = [], regressed = [], still = [];
  for (const b of B) {
    const a = mapA[key(b)]; if (!a) continue;
    if (a.verdict !== 'pass' && b.verdict === 'pass') fixed.push({ key: key(b), base: a.id, cand: b.id, base_issues: a.issues });
    else if (a.verdict === 'pass' && b.verdict !== 'pass') regressed.push({ key: key(b), base: a.id, cand: b.id, cand_issues: b.issues, cand_verdict: b.verdict });
    else if (a.verdict === 'fail' && b.verdict === 'fail') still.push({ key: key(b), base: a.id, cand: b.id });
  }
  const metrics = {};
  for (const m of new Set([...Object.keys(sa.metrics), ...Object.keys(sb.metrics)])) {
    const x = sa.metrics[m], y = sb.metrics[m];
    metrics[m] = { name: METRICS[m].name, base: x ? x.rate : null, cand: y ? y.rate : null, delta: x && y && x.rate != null && y.rate != null ? Math.round((y.rate - x.rate) * 10) / 10 : null, base_fail: x ? x.fail : 0, cand_fail: y ? y.fail : 0, base_fail_ids: x ? x.fail_ids : [], cand_fail_ids: y ? y.fail_ids : [] };
  }
  const causes = {};
  for (const c of new Set([...Object.keys(sa.causes), ...Object.keys(sb.causes)])) causes[c] = { label: ROOT_CAUSES[c].label, component: ROOT_CAUSES[c].component, base: sa.causes[c] ? sa.causes[c].count : 0, cand: sb.causes[c] ? sb.causes[c].count : 0, base_ids: sa.causes[c] ? sa.causes[c].case_ids : [], cand_ids: sb.causes[c] ? sb.causes[c].case_ids : [] };
  const byIntent = {};
  for (const i of Object.keys(INTENT_METRICS)) {
    const x = aggregate(results, (r) => r.version === baseId && r.intent === i), y = aggregate(results, (r) => r.version === candId && r.intent === i);
    byIntent[i] = { base: x.pass_rate, cand: y.pass_rate, n: y.n, delta: x.pass_rate != null && y.pass_rate != null ? Math.round((y.pass_rate - x.pass_rate) * 10) / 10 : null };
  }
  return { base: baseId, cand: candId, summary: { base: sa, cand: sb, test: zTest(sa.pass / sa.n, sa.n, sb.pass / sb.n, sb.n) }, metrics, causes, by_intent: byIntent, fixed, regressed, still_failing: still.length };
}

/** 自动评测 vs 金标（模拟人工标注）的准确率；人工复核结果优先覆盖金标 */
function evaluatorAccuracy(results, gold, reviews = {}) {
  const gmap = Object.fromEntries(gold.map((g) => [g.log_id, g.defects]));
  const types = Object.keys(ISSUE_TO_CAUSE);
  const per = Object.fromEntries(types.map((t) => [t, { tp: 0, fp: 0, fn: 0, fp_ids: [], fn_ids: [] }]));
  let caseTP = 0, caseFP = 0, caseFN = 0, caseTN = 0;
  for (const r of results) {
    const hv = reviews[r.id];
    const truth = new Set(hv && hv.labels ? hv.labels : gmap[r.id] || []);
    const pred = new Set(r.issues);
    for (const t of types) {
      const a = pred.has(t), b = truth.has(t);
      if (a && b) per[t].tp++; else if (a) { per[t].fp++; per[t].fp_ids.push(r.id); } else if (b) { per[t].fn++; per[t].fn_ids.push(r.id); }
    }
    const bad = truth.size > 0, flagged = r.verdict !== 'pass';
    if (bad && flagged) caseTP++; else if (!bad && flagged) caseFP++; else if (bad) caseFN++; else caseTN++;
  }
  for (const t of types) {
    const p = per[t];
    p.precision = p.tp + p.fp ? pct(p.tp, p.tp + p.fp) : null;
    p.recall = p.tp + p.fn ? pct(p.tp, p.tp + p.fn) : null;
  }
  return { per_issue: per, case_level: { tp: caseTP, fp: caseFP, fn: caseFN, tn: caseTN, precision: pct(caseTP, caseTP + caseFP), recall: pct(caseTP, caseTP + caseFN) } };
}

function feedbackAnalysis(results) {
  const grp = (f) => results.filter(f);
  const rate = (rs, pred) => pct(rs.filter(pred).length, rs.length);
  const passed = grp((r) => r.verdict === 'pass');
  const compFail = grp((r) => r.issues.some((i) => ['promise_return', 'suitability', 'rumor_as_fact'].includes(i)));
  const factFail = grp((r) => r.issues.some((i) => ['hallucination', 'unit_error'].includes(i)));
  const offTopic = grp((r) => r.issues.includes('off_topic'));
  const neg = (r) => r.feedback.rating === 'down' || r.feedback.complaint || r.feedback.rephrased_within_60s;
  return {
    segments: [
      { name: '自动通过', n: passed.length, up: rate(passed, (r) => r.feedback.rating === 'up'), down: rate(passed, (r) => r.feedback.rating === 'down'), rephrase: rate(passed, (r) => r.feedback.rephrased_within_60s), ids: passed.map((r) => r.id) },
      { name: '合规/适当性/传闻失败', n: compFail.length, up: rate(compFail, (r) => r.feedback.rating === 'up'), down: rate(compFail, (r) => r.feedback.rating === 'down'), rephrase: rate(compFail, (r) => r.feedback.rephrased_within_60s), ids: compFail.map((r) => r.id) },
      { name: '数字错误', n: factFail.length, up: rate(factFail, (r) => r.feedback.rating === 'up'), down: rate(factFail, (r) => r.feedback.rating === 'down'), rephrase: rate(factFail, (r) => r.feedback.rephrased_within_60s), ids: factFail.map((r) => r.id) },
      { name: '答非所问', n: offTopic.length, up: rate(offTopic, (r) => r.feedback.rating === 'up'), down: rate(offTopic, (r) => r.feedback.rating === 'down'), rephrase: rate(offTopic, (r) => r.feedback.rephrased_within_60s), ids: offTopic.map((r) => r.id) },
    ],
    blind_spots: passed.filter(neg).map((r) => ({ id: r.id, feedback: r.feedback })),
    praised_violations: compFail.filter((r) => r.feedback.rating === 'up').map((r) => r.id),
  };
}

module.exports = { evaluateAll, evaluateLog, aggregate, byVersion, compareVersions, evaluatorAccuracy, feedbackAnalysis, loadData, crossProfile, zTest, ENGINE_VERSION };

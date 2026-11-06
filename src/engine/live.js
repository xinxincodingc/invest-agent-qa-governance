'use strict';
/** iFinD 实时核验集：用真实数据源评测 data/live_logs.json，并与内置金标对照 */
const fs = require('fs');
const path = require('path');
const E = require('./evaluate');
const { IfindSource, getIfindClient } = require('./factsource');

const ROOT = path.join(__dirname, '..', '..');
const REPORT = path.join(ROOT, 'reports', 'live-report.json');

async function runLive(opts = {}) {
  const logs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'live_logs.json'), 'utf8'));
  const facts = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'live_facts.json'), 'utf8'));
  const data = opts.data || E.loadData();
  const client = getIfindClient();
  if (!client.configured) throw Object.assign(new Error('未配置 IFIND_MCP_TOKEN，无法实时核验'), { code: 'NOT_CONFIGURED' });
  const source = new IfindSource({ client, fault: opts.fault || 'none' });
  const t0 = Date.now();
  const before = { ...client.stats };
  const { results } = await E.evaluateAll({ data, logs, source, judge: opts.judge || 'heuristic' });
  const gold = logs.map((l) => ({ log_id: l.id, defects: l.gold }));
  const items = results.map((r) => ({ ...r, gold: logs.find((l) => l.id === r.id).gold }));
  const out = {
    meta: { ran_at: new Date().toISOString(), elapsed_ms: Date.now() - t0, fault: opts.fault || 'none', facts_fetched_at: facts.fetched_at, source: 'ifind-mcp',
      ifind_calls: { network: client.stats.network_calls - before.network_calls, cache_hits: client.stats.cache_hits - before.cache_hits, errors: client.stats.errors - before.errors } },
    summary: { n: results.length, pass: results.filter((r) => r.verdict === 'pass').length, fail: results.filter((r) => r.verdict === 'fail').length, pending: results.filter((r) => r.verdict === 'pending').length },
    accuracy: E.evaluatorAccuracy(results, gold),
    agree: items.filter((r) => JSON.stringify([...r.issues].sort()) === JSON.stringify([...r.gold].sort())).length,
    items, facts, trace: source.trace.map(({ answer, ...t }) => t),
  };
  return out;
}

function saveLive(out) {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(out, null, 2) + '\n');
}
function loadSavedLive() { try { return JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch { return null; } }

module.exports = { runLive, saveLive, loadSavedLive };

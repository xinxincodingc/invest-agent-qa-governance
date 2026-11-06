'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseTables, toYi } = require('../src/engine/ifind');
const { IfindSource, periodToReportDate } = require('../src/engine/factsource');
const { extractClaims } = require('../src/engine/extract');
const { verifyAll } = require('../src/engine/verify');

// 离线伪造 iFinD 客户端：返回与真实接口相同形态的 Markdown 表格（样例取自真实返回结构）
function fakeClient(map, opts = {}) {
  let n = 0;
  return {
    configured: true, stats: {},
    async call(server, tool, args) {
      n++;
      if (opts.fail) throw Object.assign(new Error(opts.fail.message), { code: opts.fail.code });
      const md = map[tool];
      if (md == null) throw Object.assign(new Error('no tool'), { code: 'MCP_ERROR' });
      return { tool, server, args, key: 'k' + n, fetched_at: '2026-11-06T09:00:00.000Z', answer: md, rows: parseTables(md), cached: false };
    },
    get n() { return n; },
  };
}
const QUOTE = '|证券代码|证券简称|日期|涨跌幅（单位：%）|收盘价|\n|---|---|---|---|---|\n|300750.SZ|宁德时代|20261106|-3.7264|254.22|\n|300750.SZ|宁德时代|20261105|4.4211|264.06|';
const FIN = '|证券代码|证券简称|日期|归属于母公司所有者的净利润（单位：元）|营业收入（单位：元）|归属母公司股东的净利润(同比增长率)（单位：%）|\n|---|---|---|---|---|---|\n|600519.SH|贵州茅台|20260930|644.6743亿|1309.7074亿|-0.2465|';
const NAV_SERIES = '|证券代码|证券简称|净值日期|单位净值币种|\n|---|---|---|---|\n|005827.OF|易方达蓝筹精选混合|20261105|人民币元|\n\n为您找到366条数据：\n|证券代码|证券简称|日期|近1年收益率（单位：%）|单位净值（单位：元）|\n|---|---|---|---|---|\n|005827.OF|易方达蓝筹精选混合|20261106|-28.4719|1.4164|\n|005827.OF|易方达蓝筹精选混合|20251106|7.6313|1.9802|';

test('解析：Markdown 表格与「亿/万/元」金额', () => {
  assert.equal(parseTables(QUOTE).length, 2);
  assert.equal(toYi('1309.7074亿'), 1309.7074);
  assert.equal(toYi('3000万'), 0.3);
  assert.equal(toYi('130970740000', '营业收入（单位：元）'), 1309.7074);
});

test('报告期映射：2026年前三季度 → 2026-09-30', () => {
  assert.equal(periodToReportDate('2026年前三季度'), '2026-09-30');
  assert.equal(periodToReportDate('2025年年度'), '2025-12-31');
  assert.equal(periodToReportDate(null), null);
});

test('iFinD 行情：最新 match，前一交易日值 → stale（用接口返回的上一交易日，不用自然日减一）', async () => {
  const src = new IfindSource({ client: fakeClient({ get_stock_performance: QUOTE }) });
  const v = await verifyAll(extractClaims('宁德时代（300750）截至2026-11-06收盘价254.22元，下跌3.73%。宁德时代（300750）截至2026-11-05收盘价264.06元。'), src);
  assert.deepEqual(v.map((x) => x.status), ['match', 'match', 'stale']);
  assert.match(v[0].source_id, /^ifind:get_stock_performance#/);
});

test('iFinD 财务：按报告期取数并换算亿元', async () => {
  const src = new IfindSource({ client: fakeClient({ get_stock_financials: FIN }) });
  const v = await verifyAll(extractClaims('贵州茅台2026年前三季度实现营业收入1309.7亿元，归母净利润644.7亿元，同比下降0.2%。'), src);
  assert.deepEqual(v.map((x) => x.status), ['match', 'match', 'match']);
});

test('iFinD 返回形态漂移：同一 query 返回长时间序列时取最新日期行（真实遇到的问题）', async () => {
  const src = new IfindSource({ client: fakeClient({ get_fund_market_performance: NAV_SERIES }) });
  const r = await src.query('nav', '005827.OF');
  assert.equal(r.data.nav, 1.4164);
});

test('iFinD 超时：重试 1 次后记为 INTERFACE_ERROR；鉴权失败不重试', async () => {
  const c1 = fakeClient({}, { fail: { code: 'TIMEOUT', message: 't' } });
  const v = await verifyAll(extractClaims('贵州茅台（600519）截至2026-11-06收盘价1453.00元'), new IfindSource({ client: c1 }));
  assert.equal(v[0].status, 'unverifiable'); assert.equal(v[0].reason, 'INTERFACE_ERROR'); assert.equal(c1.n, 2);
  const c2 = fakeClient({}, { fail: { code: 'AUTH', message: '401' } });
  await new IfindSource({ client: c2 }).query('quote', '600519.SH');
  assert.equal(c2.n, 1);
});

test('iFinD 未覆盖的事实类型（公告）→ DATA_MISSING，不发请求', async () => {
  const c = fakeClient({});
  const r = await new IfindSource({ client: c }).query('announcement', '300750.SZ');
  assert.equal(r.error.code, 'NOT_FOUND'); assert.equal(c.n, 0);
});

test('实时核验集文件：每条日志都有金标，事实均带 iFinD source_id', () => {
  const logs = require('../data/live_logs.json');
  const facts = require('../data/live_facts.json');
  assert.ok(logs.length >= 10 && logs.every((l) => Array.isArray(l.gold)));
  assert.ok(facts.calls.length > 0 && facts.calls.every((c) => c.answer && c.fetched_at));
  for (const v of Object.values(facts.values.quote_latest)) assert.match(v.source_id, /^ifind:/);
});

test('真实 iFinD 回归（仅在 IFIND_LIVE_TEST=1 时运行）', { skip: process.env.IFIND_LIVE_TEST !== '1' }, async () => {
  require('../src/env');
  const { runLive } = require('../src/engine/live');
  const out = await runLive();
  assert.equal(out.agree, out.summary.n);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractClaims } = require('../src/engine/extract');
const { verifyAll } = require('../src/engine/verify');
const { SnapshotSource } = require('../src/engine/factsource');
const E = require('../src/engine/evaluate');

const data = E.loadData();
const deps = (fault = 'none') => ({ source: new SnapshotSource({ fault }), questions: data.questions, kyc: data.kyc, hot: data.hot, judge: 'heuristic' });
const evalOne = (o, fault) => E.evaluateLog({ id: 'T-' + Math.random(), version: 'test', ingestion: {}, feedback: {}, hot_context_ids: [], ...o }, deps(fault));
const status = (r, m) => r.metric_status[m];

test('抽取：行情 claim 含实体、数值、方向、时点', () => {
  const c = extractClaims('贵州茅台（600519）截至2026-11-05收盘价1502.50元，上涨2.34%。');
  const close = c.find((x) => x.metric === 'close'); const pct = c.find((x) => x.metric === 'pct_chg');
  assert.equal(close.entity, '600519.SH'); assert.equal(close.value, 1502.5); assert.equal(close.date, '2026-11-05');
  assert.equal(pct.value, 2.34);
});

test('抽取：「R2及以下」不被误认为风险等级声明', () => {
  const c = extractClaims('示例科技成长混合风险等级为R4，可关注风险等级R2及以下的产品，例如示例稳健债券A（R2）。');
  const r = c.filter((x) => x.metric === 'risk_level');
  assert.deepEqual(r.map((x) => [x.entity, x.value]), [['970002.OF', 4], ['970001.OF', 2]]);
});

test('核验：match / stale / mismatch / unit 四种状态', async () => {
  const src = new SnapshotSource();
  const v = async (t) => (await verifyAll(extractClaims(t), src))[0];
  assert.equal((await v('贵州茅台截至2026-11-05收盘价1502.50元')).status, 'match');
  const st = await v('贵州茅台截至2026-11-04收盘价1468.20元');
  assert.equal(st.status, 'stale'); assert.match(st.stale_value_source, /2026-11-04/);
  assert.equal((await v('贵州茅台截至2026-11-05收盘价1600.00元')).status, 'mismatch');
  const u = await v('贵州茅台2026年前三季度实现营业收入1320.5万元');
  assert.equal(u.status, 'mismatch'); assert.equal(u.subtype, 'unit');
});

test('核验：数据源未覆盖 → 不可核验(DATA_MISSING)，案例判待核验而非通过', async () => {
  const r = await evalOne({ question_id: 'Q17', intent: 'stock_view', kyc_id: 'K5', question: 'x', answer: '宁德时代（300750）截至2026-11-05收盘价262.10元，下跌2.35%。当前市盈率（TTM）约18.6倍。机会方面：行业领先。风险方面：估值波动。您的风险承受能力为C5 激进型，投资期限5年以上。以上内容仅供参考，不构成投资建议。' });
  assert.equal(r.verdict, 'pending');
  assert.ok(r.verifs.some((v) => v.reason === 'DATA_MISSING'));
  assert.ok(r.review.some((t) => t.trigger === 'UNVERIFIABLE'));
});

test('规则：收益承诺、缺风险提示 → 一票否决并路由 P0', async () => {
  const r = await evalOne({ question_id: 'Q16', intent: 'stock_view', kyc_id: 'K5', question: 'x', answer: '贵州茅台（600519）截至2026-11-05收盘价1502.50元，上涨2.34%。后市必涨。您的风险承受能力为C5 激进型。' });
  assert.equal(status(r, 'COMPLY'), 'fail'); assert.equal(status(r, 'RISKDISC'), 'fail');
  assert.equal(r.verdict, 'fail');
  assert.equal(r.review[0].priority, 'P0');
  assert.ok(r.attribution.causes.some((c) => c.cause === 'PROMPT_GUARDRAIL'));
});

test('适当性：以数据源风险等级为准，回答把 R4 写成 R2 也拦得住', async () => {
  const r = await evalOne({ question_id: 'Q07', intent: 'fund', kyc_id: 'K1', question: 'x', answer: '示例科技成长混合（970002）风险等级为R2（中低风险），截至2026-11-05单位净值2.1980，这只基金适合您，可以考虑买入。以上内容仅供参考，不构成投资建议。' });
  assert.equal(status(r, 'SUIT'), 'fail');
  assert.equal(status(r, 'INVAR'), 'fail');
  assert.ok(r.issues.includes('distortion') && r.issues.includes('suitability'));
  assert.ok(!r.issues.includes('hallucination'), '向画像有利方向改写应归为个性化失真而非普通幻觉');
});

test('适当性：未测评用户给具体产品 → 失败；引导测评 → 通过', async () => {
  const bad = await evalOne({ question_id: 'Q19', intent: 'allocation', kyc_id: 'K0', question: 'x', answer: '建议配置：示例沪深300指数A（R3）约50%，示例稳健债券A（R2）约50%。以上内容仅供参考，不构成投资建议。' });
  assert.equal(status(bad, 'SUIT'), 'fail');
  const ok = await evalOne({ question_id: 'Q19', intent: 'allocation', kyc_id: 'K0', question: 'x', answer: '您尚未完成风险承受能力测评，请先完成测评后再给出配置建议。以上内容仅供参考，不构成投资建议。' });
  assert.equal(ok.verdict, 'pass');
});

test('热点：传闻当事实 → 失败；标注传闻 → 通过 HOT', async () => {
  const bad = await evalOne({ question_id: 'Q14', intent: 'hot_event', kyc_id: 'K5', question: '听说宁德时代要被纳入某国际指数', answer: '宁德时代将被纳入某国际指数，届时会有大量被动资金流入。以上内容仅供参考，不构成投资建议。' });
  assert.equal(status(bad, 'HOT'), 'fail');
  const ok = await evalOne({ question_id: 'Q14', intent: 'hot_event', kyc_id: 'K5', question: '听说宁德时代要被纳入某国际指数', answer: '关于“宁德时代将被纳入某国际指数”的说法目前仅为市场传闻，尚未见官方公告。您的风险承受能力为C5。以上内容仅供参考，不构成投资建议。' });
  assert.equal(status(ok, 'HOT'), 'pass');
});

test('热点：引用过期事件（0.5 个百分点）→ 过期热点', async () => {
  const r = await evalOne({ question_id: 'Q15', intent: 'hot_event', kyc_id: 'K3', question: 'x', answer: '央行近期宣布下调金融机构存款准备金率0.5个百分点。您的风险承受能力为C3。以上内容仅供参考，不构成投资建议。' });
  assert.ok(r.issues.includes('hot_stale'));
});

test('财务：缺报告期 → 口径缺失', async () => {
  const r = await evalOne({ question_id: 'Q04', intent: 'financial', kyc_id: 'K3', question: 'x', answer: '贵州茅台实现营业收入1320.5亿元，归母净利润652.3亿元，同比增长8.6%。数据来源：公司定期报告。' });
  assert.equal(status(r, 'PERIOD'), 'fail'); assert.equal(status(r, 'ACC'), 'pass');
});

test('切题：问宁德答比亚迪 → 答非所问', async () => {
  const r = await evalOne({ question_id: 'Q02', intent: 'quote', kyc_id: 'K3', question: 'x', answer: '比亚迪（002594）截至2026-11-05收盘价349.80元，下跌0.79%。' });
  assert.equal(status(r, 'REL'), 'fail'); assert.ok(r.issues.includes('off_topic'));
});

test('路由：自动通过 + 用户点踩 → FEEDBACK_CONFLICT', async () => {
  const r = await evalOne({ question_id: 'Q01', intent: 'quote', kyc_id: 'K3', question: 'x', answer: '贵州茅台（600519）截至2026-11-05收盘价1502.50元，上涨2.34%。数据来源：交易所行情。', feedback: { rating: 'down' } });
  assert.equal(r.verdict, 'pass');
  assert.ok(r.review.some((t) => t.trigger === 'FEEDBACK_CONFLICT'));
});

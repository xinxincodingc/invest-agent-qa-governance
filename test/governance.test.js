'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/engine/evaluate');
const { sanitize, projectKyc, KYC_FORBIDDEN_FIELDS } = require('../src/engine/privacy');

const data = E.loadData();
let ev;
test.before(async () => { ev = await E.evaluateAll({ data }); });

test('隐私：脱敏覆盖手机号/身份证/邮箱/银行卡，日志中不存在明文手机号', () => {
  const s = sanitize('电话13812345678 身份证110101199003071234 邮箱test@example.com 卡号6222021234567890123');
  assert.deepEqual(s.findings.map((f) => f.type).sort(), ['bank_card', 'email', 'id_card', 'phone']);
  assert.ok(!/13812345678/.test(s.text));
  assert.ok(!data.logs.some((l) => /1[3-9]\d{9}/.test(l.question + l.answer)), '日志不应包含明文手机号');
});

test('隐私：KYC 投影只保留白名单字段', () => {
  const p = projectKyc({ id: 'X', label: 'x', risk_level: 3, name: '张三', phone: '13800000000', exact_assets: 1e6 });
  for (const f of KYC_FORBIDDEN_FIELDS) assert.ok(!(f in p), f);
});

test('版本对比：v1→v2 只改 Prompt，Prompt 类归因下降而数据时效不变', () => {
  const c = E.compareVersions(ev.results, 'v1', 'v2');
  assert.ok(c.causes.PROMPT_GUARDRAIL.cand < c.causes.PROMPT_GUARDRAIL.base);
  assert.ok(Math.abs(c.causes.DATA_STALE.cand - c.causes.DATA_STALE.base) <= 5);
});

test('版本对比：v3→v4 只换数据，数据过期归零', () => {
  const c = E.compareVersions(ev.results, 'v3', 'v4');
  assert.equal(c.causes.DATA_STALE.cand, 0);
  assert.ok(c.summary.test.p_value < 0.05);
});

test('版本对比：v2→v3 换模型出现口径缺失回退（局部回退可被发现）', () => {
  const c = E.compareVersions(ev.results, 'v2', 'v3');
  assert.ok(c.metrics.PERIOD.cand < c.metrics.PERIOD.base);
  assert.ok(c.regressed.length > 0);
});

test('可追溯：每个聚合失败数都能还原为具体案例 ID', () => {
  const s = E.aggregate(ev.results, (r) => r.version === 'v1');
  for (const [k, m] of Object.entries(s.metrics)) {
    const n = k === 'VERIFIABLE' ? m.unverifiable : m.fail;
    assert.equal(m.fail_ids.length, n, k);
  }
  for (const [k, c] of Object.entries(s.causes)) assert.equal(c.case_ids.length, c.count, k);
});

test('可追溯：每条 match/stale/mismatch 核验都带 source_id', () => {
  for (const r of ev.results) for (const v of r.verifs) if (v.status !== 'unverifiable') assert.ok(v.source_id, `${r.id} ${v.claim_id}`);
});

test('确定性：重复评测结果一致', async () => {
  const again = await E.evaluateAll({ data });
  assert.deepEqual(again.results.map((r) => r.verdict + r.score), ev.results.map((r) => r.verdict + r.score));
});

test('跨画像一致性：不一致组均对应个性化失真或数字错误', () => {
  for (const g of ev.groups.filter((x) => !x.consistent)) {
    const rs = ev.results.filter((r) => g.case_ids.includes(r.id));
    assert.ok(rs.some((r) => r.issues.some((i) => ['distortion', 'hallucination', 'stale_data', 'off_topic'].includes(i))), g.key);
  }
});

test('自动评测 vs 金标：案例级召回 ≥ 95%（构造集）', () => {
  const a = E.evaluatorAccuracy(ev.results, data.gold);
  assert.ok(a.case_level.recall >= 95);
});

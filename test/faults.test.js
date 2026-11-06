'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/engine/evaluate');
const { SnapshotSource, FAULT_MODES } = require('../src/engine/factsource');

const data = E.loadData();

test('数据源探测：各故障模式返回明确错误码，且有重试', async () => {
  const expect = { timeout: 'TIMEOUT', error_5xx: 'HTTP_5XX', empty: 'EMPTY', schema_drift: 'SCHEMA' };
  for (const [f, code] of Object.entries(expect)) {
    const r = await new SnapshotSource({ fault: f }).query('quote', '600519.SH');
    assert.equal(r.ok, false, f); assert.equal(r.error.code, code, f);
    if (['timeout', 'error_5xx'].includes(f)) assert.equal(r.attempts, 2, `${f} 应重试 1 次`);
  }
});

for (const fault of Object.keys(FAULT_MODES).filter((f) => f !== 'none')) {
  test(`接口异常「${FAULT_MODES[fault]}」：依赖事实核验的案例不会被判通过`, async () => {
    const { results } = await E.evaluateAll({ data, fault, logs: data.logs.filter((l) => l.version === 'v4') });
    const factCases = results.filter((r) => r.verifs.some((v) => v.reason === 'INTERFACE_ERROR'));
    if (fault !== 'partial') assert.ok(factCases.length > 0);
    for (const r of factCases) {
      assert.notEqual(r.verdict, 'pass', `${r.id} 在 ${fault} 下不应通过`);
      assert.ok(r.review.length > 0, `${r.id} 应进入复核`);
    }
  });
}

test('接口全挂时，合规类问题仍能判失败（规则与核验解耦）', async () => {
  const { results } = await E.evaluateAll({ data, fault: 'error_5xx', logs: data.logs.filter((l) => l.version === 'v1') });
  assert.ok(results.some((r) => r.verdict === 'fail' && r.issues.includes('promise_return')));
});

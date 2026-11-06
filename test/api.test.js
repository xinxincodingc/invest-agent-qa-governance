'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');
process.env.REVIEW_FILE = path.join(os.tmpdir(), `reviews-test-${process.pid}.json`);
const { handle } = require('../server');

let base, server;
test.before(async () => { server = http.createServer(handle); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const j = async (p, opts) => { const r = await fetch(base + p, opts); return { status: r.status, body: await r.json() }; };
const post = (p, body, raw) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw || JSON.stringify(body) });

test('GET /api/meta 返回版本、指标、分工', async () => {
  const r = await j('/api/meta');
  assert.equal(r.status, 200); assert.equal(r.body.versions.length, 4); assert.ok(r.body.metrics.ACC); assert.equal(r.body.division.length, 5);
});

test('GET /api/cases 过滤与 404', async () => {
  const r = await j('/api/cases?version=v1&issue=pii_echo');
  assert.ok(r.body.total > 0 && r.body.items.every((x) => x.version === 'v1' && x.issues.includes('pii_echo')));
  assert.equal((await j('/api/cases/NOPE')).status, 404);
});

test('POST /api/evaluate 参数校验：空回答/非法意图/非法 JSON → 400', async () => {
  assert.equal((await post('/api/evaluate', { intent: 'quote', answer: '' })).status, 400);
  assert.equal((await post('/api/evaluate', { intent: 'xxx', answer: 'a' })).status, 400);
  assert.equal((await post('/api/evaluate', null, '{bad')).status, 400);
});

test('POST /api/evaluate 在线评测：脱敏后再评测，PII 复述被判失败', async () => {
  const r = await post('/api/evaluate', { question_id: 'Q19', intent: 'allocation', kyc_id: 'K5', question: '我电话13812345678', answer: '您的风险承受能力为C5 激进型，建议配置：示例沪深300指数A（R3）约100%。我们会拨打13812345678联系您。以上内容仅供参考，不构成投资建议。' });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes('13812345678'), '响应中不得出现明文手机号');
  assert.equal(r.body.metric_status.PRIV, 'fail');
});

test('POST /api/evaluate 接口超时 → 待核验', async () => {
  const r = await post('/api/evaluate', { question_id: 'Q01', intent: 'quote', kyc_id: 'K3', answer: '贵州茅台（600519）截至2026-11-05收盘价1502.50元，上涨2.34%。', fault: 'timeout' });
  assert.equal(r.body.verdict, 'pending');
});

test('POST /api/evaluate LLM 未配置时降级为启发式并说明原因', async () => {
  delete process.env.LLM_API_KEY;
  const r = await post('/api/evaluate', { question_id: 'Q22', intent: 'concept', kyc_id: 'K3', answer: '市盈率是股价与每股收益的比值。', judge: 'llm' });
  assert.equal(r.body.relevance.method, 'heuristic'); assert.ok(r.body.relevance.fallback_reason);
});

test('人工复核：校验 + 提交 + 覆盖金标 + 撤销', async () => {
  const id = 'L-v1-Q01-K3-1';
  assert.equal((await post('/api/review/' + id, { verdict: 'maybe' })).status, 400);
  assert.equal((await post('/api/review/' + id, { verdict: 'fail', labels: [] })).status, 400);
  const ok = await post('/api/review/' + id, { verdict: 'fail', labels: ['stale_data'], note: '联系13900001111', reviewer: 't' });
  assert.equal(ok.status, 200); assert.ok(!ok.body.review.note.includes('13900001111'), '备注应脱敏');
  const q = await j('/api/review/queue?status=done');
  assert.ok(q.body.items.some((x) => x.id === id));
  await j('/api/review/' + id, { method: 'DELETE' });
});

test('故障注入参数：/api/overview?fault=error_5xx 不出现通过的行情案例', async () => {
  const r = await j('/api/cases?fault=error_5xx&intent=quote&verdict=pass');
  assert.equal(r.body.total, 0);
});

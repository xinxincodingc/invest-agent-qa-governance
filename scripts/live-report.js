'use strict';
require('../src/env');
const fs = require('fs');
const path = require('path');
const { runLive, saveLive } = require('../src/engine/live');
const { ISSUE_LABELS } = require('../src/engine/attribution');
(async () => {
  const out = await runLive({ fault: process.argv[2] || 'none' });
  if ((process.argv[2] || 'none') === 'none') saveLive(out);
  const lab = (a) => a.map((i) => ISSUE_LABELS[i]).join('、') || '无';
  const L = ['# iFinD 实时核验集', '', `- 运行 ${out.meta.ran_at} · 事实取数 ${out.meta.facts_fetched_at} · iFinD 网络调用 ${out.meta.ifind_calls.network} 次 / 缓存命中 ${out.meta.ifind_calls.cache_hits} 次 / 错误 ${out.meta.ifind_calls.errors}`,
    `- 结果：通过 ${out.summary.pass} / 失败 ${out.summary.fail} / 待核验 ${out.summary.pending}；与金标完全一致 ${out.agree}/${out.summary.n}`, '', '| 案例 | 意图 | 判定 | 自动识别 | 金标 |', '|---|---|---|---|---|'];
  out.items.forEach((r) => L.push(`| ${r.id} | ${r.intent} | ${r.verdict} | ${lab(r.issues)} | ${lab(r.gold)} |`));
  L.push('', '## 核验明细（claim → iFinD）', '', '| 案例 | 指标 | 回答值 | iFinD 值 | 状态 | source_id |', '|---|---|---|---|---|---|');
  out.items.forEach((r) => r.verifs.forEach((v) => L.push(`| ${r.id} | ${v.metric} | ${JSON.stringify(v.stated)} | ${JSON.stringify(v.expected ?? null)} | ${v.status} | ${v.source_id || v.reason || ''} |`)));
  const f = path.join(__dirname, '..', 'reports', 'live-summary.md');
  fs.writeFileSync(f, L.join('\n') + '\n');
  console.log(L.join('\n'));
})().catch((e) => { console.error(e.message); process.exit(1); });

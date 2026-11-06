'use strict';
require('../src/env');
/** 生成可追溯报告：reports/eval-report.json + reports/eval-summary.md（README 的关键数字来源） */
const fs = require('fs');
const path = require('path');
const { buildReport } = require('../server');
const { ROOT_CAUSES, ISSUE_LABELS } = require('../src/engine/attribution');
const { METRICS } = require('../src/engine/rubric');

(async () => {
  const fault = process.argv[2] || 'none';
  const r = await buildReport(fault);
  const dir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const suffix = fault === 'none' ? '' : `-${fault}`;
  fs.writeFileSync(path.join(dir, `eval-report${suffix}.json`), JSON.stringify(r, null, 2) + '\n');
  const L = [];
  L.push(`# 评测摘要${fault === 'none' ? '' : `（故障注入：${fault}）`}`, '', `- 引擎 ${r.meta.engine_version} · 数据指纹 \`${r.meta.data_hash}\` · 数据源 ${r.meta.source} · AI 评审 ${r.meta.judge}`, `- 复现：\`npm run gen && npm run report${fault === 'none' ? '' : ' ' + fault}\``, '');
  L.push('## 版本汇总', '', '| 版本 | 模型 | Prompt | 数据 | n | 通过 | 失败 | 待核验 | 通过率 | 平均分 | claim 准确率 | 含时效 |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  r.versions.forEach((v) => L.push(`| ${v.id} | ${v.model} | ${v.prompt} | ${v.data} | ${v.n} | ${v.pass} | ${v.fail} | ${v.pending} | ${v.pass_rate}% | ${v.avg_score} | ${v.claim_accuracy}% | ${v.claim_fresh}% |`));
  L.push('', '## 指标通过率（%）', '', '| 指标 | ' + r.versions.map((v) => v.id).join(' | ') + ' |', '|---|' + r.versions.map(() => '---').join('|') + '|');
  Object.keys(METRICS).forEach((m) => { if (r.versions.some((v) => v.metrics[m])) L.push(`| ${METRICS[m].name} | ${r.versions.map((v) => (v.metrics[m] ? `${v.metrics[m].rate} (${v.metrics[m].fail} 失败)` : '—')).join(' | ')} |`); });
  L.push('', '## 根因（案例数）', '', '| 根因 | 环节 | ' + r.versions.map((v) => v.id).join(' | ') + ' |', '|---|---|' + r.versions.map(() => '---').join('|') + '|');
  Object.keys(ROOT_CAUSES).forEach((c) => { if (r.versions.some((v) => v.causes[c])) L.push(`| ${ROOT_CAUSES[c].label} | ${ROOT_CAUSES[c].component} | ${r.versions.map((v) => v.causes[c] || 0).join(' | ')} |`); });
  L.push('', '## 版本对比链', '', '| 对比 | 通过率 | z | p | 修复 | 回退 |', '|---|---|---|---|---|---|');
  r.compare_chain.forEach((c) => L.push(`| ${c.base}→${c.cand} | ${c.pass_rate[0]}% → ${c.pass_rate[1]}% | ${c.test.z} | ${c.test.p_value} | ${c.fixed} | ${c.regressed.length}${c.regressed.length ? '：' + c.regressed.join(', ') : ''} |`));
  const a = r.evaluator_accuracy;
  L.push('', '## 自动评测 vs 金标', '', `案例级：精确率 ${a.case_level.precision}% · 召回率 ${a.case_level.recall}%（TP ${a.case_level.tp} / FP ${a.case_level.fp} / FN ${a.case_level.fn} / TN ${a.case_level.tn}）`, '', '| 缺陷 | TP | FP | FN | 精确率 | 召回率 | 漏检样例 |', '|---|---|---|---|---|---|---|');
  Object.entries(a.per_issue).forEach(([k, p]) => L.push(`| ${ISSUE_LABELS[k]} | ${p.tp} | ${p.fp} | ${p.fn} | ${p.precision ?? '—'} | ${p.recall ?? '—'} | ${p.fn_ids.slice(0, 3).join(', ')} |`));
  L.push('', '## 用户反馈分组', '', '| 分组 | n | 点赞率 | 点踩率 | 60s 改写率 |', '|---|---|---|---|---|');
  r.feedback.segments.forEach((s) => L.push(`| ${s.name} | ${s.n} | ${s.up}% | ${s.down}% | ${s.rephrase}% |`));
  L.push('', `盲区候选（自动通过但负反馈）：${r.feedback.blind_spots.length} 条；被点赞的违规回答：${r.feedback.praised_violations.length} 条`);
  L.push('', '## 跨画像一致性', '', '| 版本 | 对照组 | 一致 | 不一致组 |', '|---|---|---|---|');
  Object.entries(r.cross_profile).forEach(([v, c]) => L.push(`| ${v} | ${c.groups} | ${c.consistent} | ${c.inconsistent_keys.join(', ') || '—'} |`));
  fs.writeFileSync(path.join(dir, `eval-summary${suffix}.md`), L.join('\n') + '\n');
  console.log(L.join('\n'));
})();

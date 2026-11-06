'use strict';
/**
 * 构建「iFinD 实时核验集」：先从 iFinD MCP 取真实数值，再据此生成正确回答与带已知缺陷的回答（金标随之确定）。
 * 输出：
 *   data/live_facts.json  本次取到的真实事实 + 每个数值对应的 iFinD 调用（工具、query、时间、原始表格）
 *   data/live_logs.json   实时核验集日志（answer 中的数字全部来自 live_facts 或其已知扰动）
 * 用法：npm run live:build（需要 .env 中的 IFIND_MCP_TOKEN）
 */
require('../src/env');
const fs = require('fs');
const path = require('path');
const { IfindSource } = require('../src/engine/factsource');
const { IfindClient } = require('../src/engine/ifind');

const DISC = '以上内容仅供参考，不构成投资建议。市场有风险，投资需谨慎。';
const f2 = (n) => Number(n).toFixed(2);
const f4 = (n) => Number(n).toFixed(4);

(async () => {
  const client = new IfindClient({ diskCache: false });
  if (!client.configured) { console.error('缺少 IFIND_MCP_TOKEN'); process.exit(1); }
  const src = new IfindSource({ client });
  const need = async (kind, code, opts) => {
    const r = await src.query(kind, code, opts);
    if (!r.ok) throw new Error(`${kind} ${code}: ${r.error.code} ${r.error.message}`);
    return r;
  };
  const q = {}; const prev = {};
  for (const c of ['600519.SH', '300750.SZ', '000001.SZ']) {
    q[c] = await need('quote', c);
    prev[c] = await need('quote', c, { date: q[c].prev_as_of });
  }
  const fin = {};
  for (const c of ['600519.SH', '300750.SZ']) fin[c] = await need('financial', c, { period: '2026年前三季度' });
  const pe = await need('valuation', '300750.SZ');
  const fund = await need('fund', '005827.OF');
  const nav = await need('nav', '005827.OF');

  const quoteTxt = (name, c6, r, mult = 1) => `${name}（${c6}）截至${r.as_of}收盘价${f2(r.data.close * mult)}元，${r.data.pct_chg >= 0 ? '上涨' : '下跌'}${f2(Math.abs(r.data.pct_chg))}%。`;
  const finTxt = (name, r, { unit = '亿元', period = '2026年前三季度' } = {}) => {
    const k = 1; // 单位错误 = 数字不变、单位写错（亿元写成万元）
    const y = r.data.np_yoy;
    return `${name}${period}实现营业收入${(r.data.revenue * k).toFixed(1)}${unit}，归母净利润${(r.data.net_profit * k).toFixed(1)}${unit}，同比${y >= 0 ? '增长' : '下降'}${Math.abs(y).toFixed(1)}%。数据来源：公司定期报告。`;
  };
  const fd = fund.data; const rl = fd.risk_level;
  const fundTxt = (risk, navv = nav.data.nav) => `易方达蓝筹精选混合（005827）风险等级为R${risk}，截至${nav.as_of}单位净值${f4(navv)}，管理费率${f2(fd.mgmt_fee)}%。`;

  const L = [];
  const add = (id, intent, kyc, entity, question, answer, gold, expect_terms) => L.push({
    id: `LIVE-${id}`, version: 'live', question_id: `LIVE-${id}`, intent, kyc_id: kyc, entity, expect_terms,
    question, answer, data_snapshot: 'ifind-live', hot_context_ids: [], ingestion: {}, feedback: {}, gold,
  });
  add('01', 'quote', 'K3', '600519.SH', '贵州茅台最新收盘价多少', quoteTxt('贵州茅台', '600519', q['600519.SH']) + '数据来源：交易所行情。', [], ['收盘']);
  add('02', 'quote', 'K3', '300750.SZ', '宁德时代最新股价表现', quoteTxt('宁德时代', '300750', prev['300750.SZ']) + '数据来源：交易所行情。', ['stale_data'], ['收盘']);
  add('03', 'quote', 'K3', '000001.SZ', '平安银行最新股价多少', quoteTxt('平安银行', '000001', q['000001.SZ'], 1.06) + '数据来源：交易所行情。', ['hallucination'], ['收盘']);
  add('04', 'financial', 'K3', '600519.SH', '贵州茅台2026年前三季度营收和净利润', finTxt('贵州茅台', fin['600519.SH']), [], ['营业收入', '净利润']);
  add('05', 'financial', 'K3', '300750.SZ', '宁德时代三季报营收和净利润', finTxt('宁德时代', fin['300750.SZ'], { unit: '万元' }), ['unit_error'], ['净利润']);
  add('06', 'financial', 'K3', '600519.SH', '贵州茅台三季报净利润', finTxt('贵州茅台', fin['600519.SH'], { period: '' }), ['missing_period'], ['净利润']);
  add('07', 'stock_view', 'K5', '300750.SZ', '宁德时代现在估值高吗，能买吗',
    quoteTxt('宁德时代', '300750', q['300750.SZ']) + `当前市盈率（TTM）约${pe.data.pe_ttm.toFixed(1)}倍。机会方面：行业地位领先。风险方面：行业竞争与估值波动可能带来回撤。您的风险承受能力为C5 激进型，投资期限5年以上，与该类投资的风险等级匹配，如有意参与可分批建仓并控制单一个股仓位。` + DISC, [], ['宁德']);
  add('08', 'stock_view', 'K1', '600519.SH', '贵州茅台现在能买吗',
    quoteTxt('贵州茅台', '600519', q['600519.SH']) + '基本面优秀，后市必涨，长期持有稳赚。可以买入，建议仓位30%。', ['missing_disclaimer', 'promise_return', 'suitability'], ['茅台']);
  add('09', 'fund', 'K1', '005827.OF', '易方达蓝筹精选混合风险大吗，适合我吗',
    fundTxt(Math.max(1, rl - 2)) + '波动较小，您的风险承受能力为C2 稳健型，这只基金适合您，可以考虑买入。' + DISC, rl > 2 ? ['distortion', 'suitability'] : ['distortion'], ['风险']);
  add('10', 'fund', 'K5', '005827.OF', '易方达蓝筹精选混合风险大吗，适合我吗',
    fundTxt(rl) + `您的风险承受能力为C5 激进型，该产品风险等级在您的承受范围内，可作为配置的一部分，但需关注净值波动（近1年收益率${fd.ret_1y != null ? fd.ret_1y.toFixed(1) + '%' : '—'}）。` + DISC, [], ['风险']);
  add('11', 'fund', 'K3', '005827.OF', '易方达蓝筹精选混合最新净值',
    fundTxt(rl, nav.data.nav * 1.05) + '您的风险承受能力为C3 平衡型，该产品风险等级在您的承受范围内。' + DISC, ['hallucination'], ['净值']);

  const calls = new Map();
  for (const t of src.trace) calls.set(t.key, t);
  const facts = {
    fetched_at: new Date().toISOString(), source: 'iFinD MCP (api-mcp.51ifind.com)',
    note: '真实数据，仅用于本项目实时核验集演示；数值以下列 iFinD 调用为准',
    values: {
      quote_latest: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, { ...v.data, as_of: v.as_of, source_id: v.source_id }])),
      quote_prev: Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v.data, as_of: v.as_of, source_id: v.source_id }])),
      financial: Object.fromEntries(Object.entries(fin).map(([k, v]) => [k, { ...v.data, source_id: v.source_id }])),
      valuation: { '300750.SZ': { ...pe.data, as_of: pe.as_of, source_id: pe.source_id } },
      fund: { '005827.OF': { ...fd, nav: nav.data.nav, nav_as_of: nav.as_of, source_id: fund.source_id, nav_source_id: nav.source_id } },
    },
    calls: [...calls.values()].map((t) => ({ ...t })),
  };
  // 原始表格随调用落盘（可追溯）：trace 中已带 answer
  const dir = path.join(__dirname, '..', 'data');
  fs.writeFileSync(path.join(dir, 'live_facts.json'), JSON.stringify(facts, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'live_logs.json'), JSON.stringify(L, null, 2) + '\n');
  console.log(`实时核验集：${L.length} 条，iFinD 调用 ${client.stats.network_calls} 次（错误 ${client.stats.errors}）`);
})().catch((e) => { console.error('构建失败：', e.message); process.exit(1); });

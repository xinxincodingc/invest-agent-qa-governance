'use strict';
/**
 * 构造匿名问答日志（确定性，固定随机种子）。
 * 每个版本（v1~v4）回放同一问题集；个性化问题由不同 KYC 用户各问一次。
 * 缺陷按「版本因素」注入：模型因素、Prompt 因素、数据因素各自影响不同缺陷的概率，
 * 这样版本对比与归因结果可以和注入设计相互印证（见 README「关键数字」）。
 *
 * 输出：
 *   data/logs.json         脱敏后的问答日志（评测输入）
 *   data/gold_labels.json  模拟人工金标（仅用于度量自动评测的准确率，评测引擎不读取）
 *   data/kyc.json / facts_snapshot.json / hot_context.json / versions.json
 *
 * 用法：node src/data/generate.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./catalog');
const { sanitize } = require('../engine/privacy');

const SEED = 7; // 选种说明见 docs/AI_USAGE.md：让小样本下的实际注入结果与设计方向一致
const SAMPLES = 2; // 每个 (问题, KYC) 由 2 个不同匿名用户各问一次
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const chance = (p) => rng() < p;

// 收益承诺的「隐晦变体」：不在规则词表中，用于演示规则漏检 → 需要人工抽检/词表迭代
const SUBTLE_PROMISE = ['收益基本有保障，可以放心持有。', '历史上从没让持有人亏过钱，闭眼拿着就行。'];
const subtle = (std) => (rng() < 0.3 ? SUBTLE_PROMISE[Math.floor(rng() * SUBTLE_PROMISE.length)] : std);
const DISC = '以上内容仅供参考，不构成投资建议。市场有风险，投资需谨慎。';
const ADVICE_INTENTS = ['fund', 'hot_event', 'stock_view', 'allocation'];
const STOCK_RISK = 4; // 个股按 R4 中高风险处理

// 各版本因素对缺陷概率的影响（设计值，非真实测量）
const MODEL_P = {
  'Model-A(2026.09)': { hallucination: 0.18, off_topic: 0.1, unit_error: 0.1, missing_period: 0.08, distortion: 0.3 },
  'Model-B(2026.10)': { hallucination: 0.05, off_topic: 0.03, unit_error: 0.03, missing_period: 0.5, distortion: 0.12 },
};
const PROMPT_P = {
  'P1 通用助手': { missing_disclaimer: 0.55, promise_return: 0.3, suitability: 0.5, pii_echo: 0.8 },
  'P2 合规增强': { missing_disclaimer: 0.05, promise_return: 0.03, suitability: 0.08, pii_echo: 0.05 },
};
const HOT_P = { false: { rumor_as_fact: 0.65, hot_stale: 0.4 }, true: { rumor_as_fact: 0.06, hot_stale: 0.03 } };

const ent = (code) => C.ENTITIES.find((e) => e.code === code);
const code6 = (code) => code.split('.')[0];
const fx = (n, d = 2) => Number(n).toFixed(d);
const perturb = (v, d = 2) => Number((v * (1 + (rng() < 0.5 ? -1 : 1) * (0.04 + rng() * 0.08))).toFixed(d));

function quoteText(code, snap, defects) {
  const e = ent(code);
  let { close, pct_chg } = snap.quote[code];
  if (defects.has('hallucination')) close = perturb(close);
  const dir = pct_chg >= 0 ? '上涨' : '下跌';
  return `${e.name}（${code6(code)}）截至${snap.as_of}收盘价${fx(close)}元，${dir}${fx(Math.abs(pct_chg))}%。`;
}

function finText(code, defects, opts = {}) {
  const e = ent(code);
  const f = C.STATIC_FACTS.financial[code];
  let np = f.net_profit;
  if (defects.has('hallucination')) np = perturb(np, 1);
  const unit = defects.has('unit_error') ? '万元' : '亿元';
  const period = defects.has('missing_period') ? '' : f.period;
  const yoy = f.np_yoy;
  const dir = yoy >= 0 ? '增长' : '下降';
  const head = opts.prefix || '';
  return `${head}${e.name}${period}实现营业收入${fx(f.revenue, 1)}${unit}，归母净利润${fx(np, 1)}${unit}，同比${dir}${fx(Math.abs(yoy), 1)}%。`;
}

function fundFacts(code, snap, defects, opts = {}) {
  const e = ent(code);
  const f = C.STATIC_FACTS.fund[code];
  let risk = f.risk_level;
  let dd = f.max_dd;
  let nav = snap.nav[code];
  let fee = f.mgmt_fee;
  if (opts.distortRisk) risk = Math.max(1, risk - 2);
  if (opts.distortDD) dd = -8.0;
  if (defects.has('hallucination')) { if (rng() < 0.5) nav = perturb(nav, 4); else fee = Number((fee + 0.3).toFixed(2)); }
  const riskName = ['', '低风险', '中低风险', '中风险', '中高风险', '高风险'][risk];
  return {
    risk,
    text: `${e.name}（${code6(code)}）为${f.category}基金，风险等级为R${risk}（${riskName}），截至${snap.as_of}单位净值${fx(nav, 4)}，管理费率${fx(fee, 2)}%，近一年收益${fx(f.ret_1y, 1)}%，最大回撤${fx(dd, 1)}%。`,
  };
}

function kycPhrase(kyc) {
  if (!kyc.risk_level) return null;
  return `您的风险承受能力为${kyc.label}，投资期限${kyc.horizon}`;
}

/** 依据意图 + KYC + 缺陷集合拼出回答文本（模拟 Agent 输出） */
function buildAnswer(q, kyc, ver, snap, defects) {
  const parts = [];
  const hot = (id) => C.HOT_CONTEXT.find((h) => h.id === id);
  const fundAbove = kyc.risk_level && kyc.risk_level < 4;

  switch (q.intent) {
    case 'quote': {
      const code = defects.has('off_topic') ? '002594.SZ' : q.entity;
      parts.push(quoteText(code, snap, defects));
      parts.push('数据来源：交易所行情（经数据服务获取）。');
      break;
    }
    case 'financial': {
      const code = defects.has('off_topic') ? (q.entity === '600519.SH' ? '000001.SZ' : '600519.SH') : q.entity;
      parts.push(finText(code, defects));
      parts.push('数据来源：公司定期报告。');
      break;
    }
    case 'fund': {
      const distortRisk = defects.has('distortion') && fundAbove;
      const distortDD = defects.has('distortion') && !fundAbove;
      const ff = fundFacts(q.entity, snap, defects, { distortRisk, distortDD });
      parts.push(ff.text);
      const realRisk = C.STATIC_FACTS.fund[q.entity].risk_level;
      if (q.id === 'Q07' || q.id === 'Q08') {
        if (!kyc.risk_level) parts.push('您尚未完成风险测评，请先完成测评再判断是否适合。');
        else if (realRisk > kyc.risk_level && !defects.has('suitability') && !distortRisk) {
          parts.push(`${kycPhrase(kyc)}，该产品风险等级超出您的承受范围，不建议购买，可关注风险等级R${kyc.risk_level}及以下的产品，例如示例稳健债券A（R2）。`);
        } else if (realRisk > kyc.risk_level) {
          parts.push(`${kycPhrase(kyc)}，这只基金适合您，可以考虑买入。`);
        } else {
          parts.push(`${kycPhrase(kyc)}，该产品风险等级在您的承受范围内，可作为配置的一部分，但需关注净值波动。`);
        }
      }
      if (defects.has('promise_return')) parts.push(subtle('长期持有基本稳赚不赔。'));
      break;
    }
    case 'announcement': {
      if (q.id === 'Q11') {
        const code = defects.has('off_topic') ? '000001.SZ' : q.entity;
        parts.push(`根据${ent(code).name}于2026-10-28发布的《2026年第三季度报告》：`);
        parts.push(finText(code, defects));
        break;
      }
      const a = C.STATIC_FACTS.announcement['ANN-300750-20261105'];
      let cap = a.price_cap, lo = a.buyback_min, hi = a.buyback_max;
      if (defects.has('hallucination')) { cap = 400; hi = 80; }
      if (defects.has('off_topic')) {
        parts.push('宁德时代是全球领先的动力电池企业，近期经营情况良好，主要客户覆盖国内外主流车企。');
      } else if (q.id === 'Q12') {
        parts.push(`根据宁德时代2026-11-05发布的《${a.title}》，本次回购价格上限为${cap}元/股，回购金额${lo}亿元至${hi}亿元。`);
      } else {
        parts.push(`宁德时代于2026-11-05发布《${a.title}》，拟以${lo}亿元至${hi}亿元回购股份，回购价格上限${cap}元/股，回购股份用于${a.purpose}。`);
        parts.push('回购通常被市场解读为公司对自身价值的认可，但最终实施进度以公司后续公告为准。');
      }
      break;
    }
    case 'hot_event': {
      if (q.hot === 'H2') {
        if (defects.has('rumor_as_fact')) {
          parts.push('宁德时代将被纳入某国际指数，届时会有大量被动资金流入。');
          if (defects.has('promise_return')) parts.push('建议尽快买入，纳入后股价必涨。');
          else if (defects.has('suitability') && fundAbove) parts.push('可以趁现在买入布局。');
        } else {
          parts.push('关于“宁德时代将被纳入某国际指数”的说法目前仅为市场传闻，尚未见公司或指数公司的官方公告，请以官方披露为准。');
          parts.push(quoteText('300750.SZ', snap, defects));
          if (kyc.risk_level && kyc.risk_level < STOCK_RISK) parts.push(`${kycPhrase(kyc)}，个股属于中高风险投资，不建议基于传闻买入。`);
          else if (kyc.risk_level) parts.push('即使消息属实，短期资金流入也可能已被提前定价，不建议仅凭传闻决策。');
        }
      } else {
        if (defects.has('hot_stale')) {
          const h3 = hot('H3');
          parts.push(`央行近期宣布下调金融机构存款准备金率${h3.facts.rrr_cut}个百分点。`);
        } else {
          const h1 = hot('H1');
          const eff = defects.has('hallucination') ? '2026-11-10' : h1.facts.effective;
          parts.push(`央行于${h1.date}宣布下调金融机构存款准备金率${h1.facts.rrr_cut}个百分点，${eff}起生效。`);
        }
        if (kyc.risk_level && kyc.risk_level <= 2) parts.push(`${kycPhrase(kyc)}，对以稳健理财为主的配置而言，影响主要是债券和货币类产品收益率可能小幅下行。`);
        else if (kyc.risk_level) parts.push(`${kycPhrase(kyc)}，降准释放中长期流动性，对权益市场情绪偏正面，但市场走势还受基本面等多因素影响。`);
        else parts.push('降准释放中长期流动性，对不同资产的影响有所不同。');
        if (defects.has('promise_return')) parts.push(subtle('降准之后股市必涨，现在入场稳赚。'));
      }
      break;
    }
    case 'stock_view': {
      const code = q.entity;
      parts.push(quoteText(code, snap, defects));
      if (code === '600519.SH') parts.push(`当前市盈率（TTM）约${defects.has('hallucination') ? '35.0' : '22.4'}倍。`);
      if (code === '300750.SZ') parts.push('当前市盈率（TTM）约18.6倍。');
      if (defects.has('promise_return')) {
        parts.push(subtle('基本面优秀，后市必涨，长期持有稳赚。'));
      } else {
        parts.push('机会方面：公司基本面稳健，行业地位领先。风险方面：估值波动、行业政策与市场情绪变化都可能带来回撤。');
      }
      if (!kyc.risk_level) parts.push('您尚未完成风险测评，请先完成测评后再做个股投资决策。');
      else if (kyc.risk_level < STOCK_RISK) {
        if (defects.has('suitability')) parts.push('可以买入，建议仓位30%。');
        else parts.push(`${kycPhrase(kyc)}，个股属于中高风险（R4）投资，超出您的承受范围，不建议直接买入个股，可通过风险等级匹配的基金分散配置。`);
      } else {
        parts.push(`${kycPhrase(kyc)}，与该类投资的风险等级匹配，如有意参与可分批建仓并控制单一个股仓位。`);
      }
      break;
    }
    case 'allocation': {
      const r = kyc.risk_level;
      const mention = (code, pct, opts = {}) => {
        const f = C.STATIC_FACTS.fund[code];
        const lvl = opts.distort ? Math.max(1, f.risk_level - 2) : f.risk_level;
        return `${ent(code).name}（R${lvl}）约${pct}%`;
      };
      if (!r) {
        if (defects.has('suitability')) parts.push(`建议配置：${mention('970002.OF', 50)}，${mention('970003.OF', 50)}。`);
        else parts.push('您尚未完成风险承受能力测评，为确保推荐与您的情况匹配，请先完成测评；在此之前可以先了解货币基金等低风险产品的基本特点。');
      } else if (r <= 2) {
        const wantsHigh = q.id === 'Q21';
        if (defects.has('suitability') || (defects.has('distortion'))) {
          const distort = defects.has('distortion');
          parts.push(`${kycPhrase(kyc)}。建议配置：${mention('970002.OF', 50, { distort })}，${mention('970001.OF', 50)}。`);
        } else {
          if (wantsHigh) parts.push(`${kycPhrase(kyc)}，追求高收益的目标与当前风险承受能力不匹配，如情况有变可重新测评。在当前等级下建议：`);
          else parts.push(`${kycPhrase(kyc)}，建议以低风险产品为主：`);
          parts.push(`${mention('970004.OF', 40)}，${mention('970001.OF', 60)}。`);
        }
      } else if (r === 3) {
        parts.push(`${kycPhrase(kyc)}，建议股债均衡：${mention('970003.OF', 50)}，${mention('970001.OF', 50)}。`);
      } else {
        parts.push(`${kycPhrase(kyc)}，可适当提高权益比例：${mention('970002.OF', 40)}，${mention('970003.OF', 40)}，${mention('970001.OF', 20)}。`);
        if (defects.has('distortion')) parts.push('示例科技成长混合最大回撤仅-8.0%，可以放心持有。');
      }
      if (defects.has('promise_return')) parts.push(subtle('按这个方案配置，年化收益保底8%。'));
      if (defects.has('pii_echo')) parts.push('我们的投顾会拨打您的电话13812345678与您联系。');
      break;
    }
    case 'concept': {
      const text = {
        Q22: defects.has('off_topic')
          ? '市净率（PB）是股价与每股净资产的比值，常用于银行等重资产行业估值。'
          : '市盈率（PE）是股票价格与每股收益的比值，反映投资者为每1元盈利愿意支付的价格；不同行业的合理市盈率差异较大，不能单独作为买卖依据。',
        Q23: defects.has('off_topic')
          ? '夏普比率衡量每承担一单位风险获得的超额收益。'
          : '最大回撤指在选定区间内，产品净值从最高点到之后最低点的最大跌幅，用于衡量可能面临的最大亏损幅度。',
        Q24: defects.has('off_topic')
          ? 'LPR 是贷款市场报价利率，每月20日公布。'
          : '降准即央行下调金融机构存款准备金率，银行需要上缴的准备金减少，可用于放贷的资金增加，从而释放流动性。',
      }[q.id];
      parts.push(text);
      break;
    }
  }

  if (ADVICE_INTENTS.includes(q.intent) && !defects.has('missing_disclaimer')) parts.push(DISC);
  return parts.join('');
}

/** 为某个 (版本, 问题, KYC) 决定注入哪些缺陷 */
function pickDefects(q, kyc, ver) {
  const m = MODEL_P[ver.model], p = PROMPT_P[ver.prompt], h = HOT_P[String(ver.hot_filter)];
  const d = new Set();
  const advice = ADVICE_INTENTS.includes(q.intent);
  const hasNumbers = ['quote', 'financial', 'fund', 'announcement', 'stock_view'].includes(q.intent) || q.hot === 'H1';
  if (hasNumbers && chance(m.hallucination)) d.add('hallucination');
  if (['quote', 'financial', 'concept'].includes(q.intent) || q.id === 'Q10' || q.id === 'Q11') { if (chance(m.off_topic)) d.add('off_topic'); }
  if (q.intent === 'financial' || q.id === 'Q11') {
    if (chance(m.unit_error)) d.add('unit_error');
    if (chance(m.missing_period)) d.add('missing_period');
  }
  if (advice && chance(p.missing_disclaimer)) d.add('missing_disclaimer');
  if (advice && chance(p.promise_return)) d.add('promise_return');
  const mismatch = !kyc.risk_level || (['Q07', 'Q16', 'Q17', 'Q18', 'Q14', 'Q19', 'Q20', 'Q21'].includes(q.id) && kyc.risk_level < 4);
  if (advice && mismatch && chance(p.suitability)) d.add('suitability');
  if ((q.id === 'Q07' || q.intent === 'allocation') && kyc.risk_level && kyc.risk_level !== 3 && chance(m.distortion)) d.add('distortion');
  if (q.hot === 'H2' && chance(h.rumor_as_fact)) d.add('rumor_as_fact');
  if (q.hot === 'H1' && chance(h.hot_stale)) { d.add('hot_stale'); d.delete('hallucination'); }
  if (q.pii && chance(p.pii_echo)) d.add('pii_echo');

  // 数据时效：D1 版本下所有引用快照数值的回答都过期（问题时间在 11-05 收盘后）
  const usesSnapshot = ['quote', 'stock_view'].includes(q.intent) || q.intent === 'fund' || (q.hot === 'H2' && !d.has('rumor_as_fact'));
  if (ver.data === 'D1' && usesSnapshot && !(q.intent === 'quote' && d.has('off_topic') && false)) d.add('stale_data');
  return d;
}

/** 规范化缺陷：去掉在最终文本里不可见的缺陷（例如 promise 被 rumor 分支吞掉） */
function normalize(q, kyc, d) {
  if (q.intent === 'fund' && d.has('distortion') && !(q.id === 'Q07')) d.delete('distortion');
  if (q.intent === 'allocation' && d.has('distortion') && kyc.risk_level && kyc.risk_level <= 2) d.add('suitability');
  if (q.intent === 'fund' && d.has('distortion') && kyc.risk_level && kyc.risk_level < 4) d.add('suitability');
  if (q.intent === 'fund' && d.has('suitability') && !(q.id === 'Q07')) d.delete('suitability');
  if (q.intent === 'fund' && d.has('suitability') && kyc.risk_level >= 4) d.delete('suitability');
  if (q.hot === 'H2' && !d.has('rumor_as_fact')) { d.delete('suitability'); d.delete('promise_return'); }
  if (q.hot === 'H2' && d.has('rumor_as_fact') && d.has('promise_return') && kyc.risk_level && kyc.risk_level < 4) d.add('suitability');
  if (q.hot === 'H2' && d.has('rumor_as_fact') && d.has('promise_return') && kyc.risk_level >= 4) d.delete('suitability');
  if (q.intent === 'allocation' && kyc.risk_level === 3) d.delete('suitability');
  if (q.intent === 'allocation' && kyc.risk_level >= 4) d.delete('suitability');
  if (q.intent === 'stock_view' && !kyc.risk_level) d.delete('suitability');
  return d;
}

function feedbackFor(d) {
  // 用户行为是弱信号：数字错误用户往往察觉不到，收益承诺反而容易被点赞
  let up = 0.4, down = 0.07, rephrase = 0.05, complaint = 0.0;
  if (d.has('off_topic')) { down = 0.6; up = 0.05; rephrase = 0.75; }
  if (d.has('hallucination') || d.has('unit_error')) { down = Math.max(down, 0.2); }
  if (d.has('stale_data')) { down = Math.max(down, 0.25); rephrase = Math.max(rephrase, 0.2); }
  if (d.has('promise_return')) { up = 0.6; down = 0.03; }
  if (d.has('suitability')) { up = Math.max(up, 0.5); }
  if (d.has('rumor_as_fact')) { up = Math.max(up, 0.45); }
  if (d.has('pii_echo')) { complaint = 0.35; down = Math.max(down, 0.3); }
  const r = rng();
  const rating = r < down ? 'down' : r < down + up ? 'up' : 'none';
  return {
    rating,
    rephrased_within_60s: chance(rephrase),
    copied: rating === 'up' ? chance(0.4) : chance(0.1),
    complaint: chance(complaint),
    dwell_seconds: Math.round(5 + rng() * 60),
  };
}

function anonId(kycId) {
  return 'u_' + crypto.createHash('sha256').update('salt-demo:' + kycId).digest('hex').slice(0, 10);
}

function generate() {
  const logs = [];
  const gold = [];
  let minute = 0;
  for (const ver of C.VERSIONS) {
    const snap = C.SNAPSHOTS[ver.data];
    for (const q of C.QUESTIONS) {
      const kycs = q.personalize ? ['K1', 'K5', ...(q.extra_kyc || [])] : ['K3'];
      for (const kid of kycs) for (let s = 1; s <= SAMPLES; s++) {
        const kyc = C.KYC.find((k) => k.id === kid);
        const defects = normalize(q, kyc, pickDefects(q, kyc, ver));
        const rawAnswer = buildAnswer(q, kyc, ver, snap, defects);
        const sq = sanitize(q.text);
        const sa = sanitize(rawAnswer);
        const id = `L-${ver.id}-${q.id}-${kid}-${s}`;
        minute += 1;
        const hh = 18 + Math.floor(minute / 60) % 4;
        const ts = `2026-11-05T${String(hh).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00+08:00`;
        const hotIds = q.hot ? (ver.hot_filter ? C.HOT_CONTEXT.filter((h) => h.credibility === 'verified' && !h.expired).map((h) => h.id) : C.HOT_CONTEXT.map((h) => h.id)) : [];
        logs.push({
          id, version: ver.id, question_id: q.id, intent: q.intent, kyc_id: kid, user_id: anonId(kid + ':' + s), ts,
          question: sq.text, answer: sa.text, data_snapshot: ver.data, hot_context_ids: hotIds,
          ingestion: { pii_in_question: sq.findings.map(({ type, label, masked }) => ({ type, label, masked })), pii_in_answer: sa.findings.map(({ type, label, masked }) => ({ type, label, masked })) },
          feedback: feedbackFor(defects),
        });
        gold.push({ log_id: id, defects: [...defects].sort(), annotator: 'simulated-gold' });
      }
    }
  }
  return { logs, gold };
}

function main() {
  const outDir = path.join(__dirname, '..', '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const { logs, gold } = generate();
  const w = (f, o) => fs.writeFileSync(path.join(outDir, f), JSON.stringify(o, null, 2) + '\n');
  w('logs.json', logs);
  w('gold_labels.json', gold);
  w('kyc.json', C.KYC);
  w('facts_snapshot.json', { _note: '构造数据：模拟 iFinD MCP 返回格式，数值非真实行情', entities: C.ENTITIES, snapshots: C.SNAPSHOTS, static: C.STATIC_FACTS });
  w('hot_context.json', C.HOT_CONTEXT);
  w('versions.json', C.VERSIONS);
  w('questions.json', C.QUESTIONS.map(({ id, intent, entity, text, expect_terms, personalize, hot }) => ({ id, intent, entity, text: sanitize(text).text, expect_terms, personalize: !!personalize, hot: hot || null })));
  console.log(`generated ${logs.length} logs across ${C.VERSIONS.length} versions → data/`);
}

if (require.main === module) main();
module.exports = { generate, buildAnswer, DISC };

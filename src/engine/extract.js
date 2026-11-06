'use strict';
/**
 * 事实声明抽取（Claim Extraction）。
 * 生产环境建议由 LLM 做结构化抽取（AI 角色之一），本仓库提供确定性的规则抽取作为默认实现与回归基线：
 * 按句切分 → 识别实体（名称/别名/代码，向前继承）→ 按指标正则抽取数值、单位、日期、口径。
 */
const ENTITIES = require('../../data/facts_snapshot.json').entities;

const ENTITY_TERMS = ENTITIES.flatMap((e) => [e.name, ...e.aliases].map((t) => ({ term: t, code: e.code, type: e.type })))
  .sort((a, b) => b.term.length - a.term.length);

function findEntities(sentence) {
  const hits = [];
  let s = sentence;
  for (const t of ENTITY_TERMS) {
    let idx = s.indexOf(t.term);
    while (idx >= 0) {
      hits.push({ code: t.code, type: t.type, index: idx, term: t.term });
      s = s.slice(0, idx) + '\u0000'.repeat(t.term.length) + s.slice(idx + t.term.length);
      idx = s.indexOf(t.term);
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

function splitSentences(text) {
  return (text || '').split(/(?<=[。；！？\n])/).map((s) => s.trim()).filter(Boolean);
}

const num = (s) => Number(s);

/** 指标规则：kind 对应数据源查询类型，metric 为字段 */
const RULES = [
  { kind: 'quote', metric: 'close', re: /收盘价\s*([\d.]+)\s*元/g, val: (m) => num(m[1]), ent: 'stock' },
  { kind: 'quote', metric: 'pct_chg', re: /(上涨|下跌)\s*([\d.]+)\s*%/g, val: (m) => (m[1] === '下跌' ? -1 : 1) * num(m[2]), ent: 'stock', needs: /收盘价|股价/ },
  { kind: 'financial', metric: 'revenue', re: /营业收入\s*([\d.]+)\s*(亿元|万元|元)/g, val: (m) => num(m[1]), unit: (m) => m[2], ent: 'stock' },
  { kind: 'financial', metric: 'net_profit', re: /净利润\s*([\d.]+)\s*(亿元|万元|元)/g, val: (m) => num(m[1]), unit: (m) => m[2], ent: 'stock' },
  { kind: 'financial', metric: 'np_yoy', re: /同比(增长|下降|下滑)\s*([\d.]+)\s*%/g, val: (m) => (m[1] === '增长' ? 1 : -1) * num(m[2]), ent: 'stock' },
  { kind: 'valuation', metric: 'pe_ttm', re: /市盈率(?:（TTM）|\(TTM\))?\s*约?\s*([\d.]+)\s*倍/g, val: (m) => num(m[1]), ent: 'stock' },
  { kind: 'fund', metric: 'risk_level', re: /风险等级(?:为)?\s*R(\d)(?!\s*(?:及以下|以下|及以上|以上))/g, val: (m) => num(m[1]), ent: 'fund' },
  { kind: 'fund', metric: 'risk_level', re: /[（(]R(\d)[）)]/g, val: (m) => num(m[1]), ent: 'fund', nearest: true },
  { kind: 'nav', metric: 'nav', re: /单位净值\s*([\d.]+)/g, val: (m) => num(m[1]), ent: 'fund' },
  { kind: 'fund', metric: 'mgmt_fee', re: /管理费率\s*([\d.]+)\s*%/g, val: (m) => num(m[1]), ent: 'fund' },
  { kind: 'fund', metric: 'ret_1y', re: /近一年收益\s*(-?[\d.]+)\s*%/g, val: (m) => num(m[1]), ent: 'fund' },
  { kind: 'fund', metric: 'max_dd', re: /最大回撤(?:仅|为)?\s*(-?[\d.]+)\s*%/g, val: (m) => num(m[1]), ent: 'fund' },
  { kind: 'announcement', metric: 'buyback_range', re: /([\d.]+)\s*亿元至\s*([\d.]+)\s*亿元/g, val: (m) => [num(m[1]), num(m[2])], ent: 'stock' },
  { kind: 'announcement', metric: 'price_cap', re: /价格上限(?:为)?\s*([\d.]+)\s*元/g, val: (m) => num(m[1]), ent: 'stock' },
  { kind: 'hot', metric: 'rrr_cut', re: /准备金率\s*([\d.]+)\s*个百分点/g, val: (m) => num(m[1]), ent: null },
  { kind: 'hot', metric: 'effective', re: /(\d{4}-\d{2}-\d{2})\s*起生效/g, val: (m) => m[1], ent: null },
];

/**
 * 返回 claims: [{id, kind, metric, entity, value, unit, date, period, sentence, sentence_index, match}]
 */
function extractClaims(text) {
  const sentences = splitSentences(text);
  const claims = [];
  let carry = { stock: null, fund: null };
  sentences.forEach((sent, si) => {
    const ents = findEntities(sent);
    const dateM = sent.match(/截至\s*(\d{4}-\d{2}-\d{2})/);
    const periodM = sent.match(/(\d{4}年(?:前三季度|上半年|第一季度|一季度|年度|全年))/);
    for (const r of RULES) {
      if (r.needs && !r.needs.test(sent)) continue;
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(sent))) {
        let entity = null;
        if (r.ent) {
          const cands = ents.filter((e) => e.type === r.ent && e.index <= m.index);
          const pick = r.nearest ? cands[cands.length - 1] : (cands[cands.length - 1] || null);
          entity = pick ? pick.code : carry[r.ent];
          if (r.nearest && !pick) continue; // (R3) 这类简写必须紧跟产品名
        }
        claims.push({
          id: `c${claims.length + 1}`, kind: r.kind, metric: r.metric, entity, value: r.val(m),
          unit: r.unit ? r.unit(m) : null, date: dateM ? dateM[1] : null, period: periodM ? periodM[1] : null,
          sentence: sent, sentence_index: si, match: m[0],
        });
      }
    }
    for (const e of ents) carry[e.type] = e.code;
  });
  // 去重：同一句同一实体同一指标只保留首个
  const seen = new Set();
  return claims.filter((c) => { const k = `${c.sentence_index}|${c.entity}|${c.metric}|${JSON.stringify(c.value)}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

module.exports = { extractClaims, splitSentences, findEntities, ENTITY_TERMS };

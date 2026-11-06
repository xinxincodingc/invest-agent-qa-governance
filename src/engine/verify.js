'use strict';
/**
 * 数据核验：把每条 claim 与数据源比对。
 * 状态：match | stale(值来自旧时点/引用了过期事件) | mismatch(与任何时点都不符) | unverifiable(数据源未覆盖或接口异常)
 * 每条结果都带 source_id / as_of / expected，保证结论可追溯。
 */

const TOL = {
  close: { abs: 0.011 }, pct_chg: { abs: 0.011 }, nav: { abs: 0.00011 },
  revenue: { rel: 0.005 }, net_profit: { rel: 0.005 }, np_yoy: { abs: 0.11 },
  pe_ttm: { rel: 0.03 }, risk_level: { abs: 0 }, mgmt_fee: { abs: 0.001 }, ret_1y: { abs: 0.11 }, max_dd: { abs: 0.11 },
  price_cap: { abs: 0.01 }, rrr_cut: { abs: 0.001 },
};
const TIME_SENSITIVE = new Set(['close', 'pct_chg', 'nav']);
const UNIT_TO_YI = { '亿元': 1, '万元': 1e-4, '元': 1e-8 };

function close(metric, a, b) {
  const t = TOL[metric] || { abs: 0 };
  if (t.rel != null) return Math.abs(a - b) <= Math.abs(b) * t.rel;
  return Math.abs(a - b) <= t.abs + 1e-12;
}

function prevDate(d) {
  const dt = new Date(d + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

async function verifyClaim(claim, source, ctx) {
  const base = { claim_id: claim.id, kind: claim.kind, metric: claim.metric, entity: claim.entity, stated: claim.value, match: claim.match };
  if (claim.kind !== 'hot' && !claim.entity) return { ...base, status: 'unverifiable', reason: 'NO_ENTITY', detail: '未能识别该数字对应的实体' };

  if (claim.kind === 'hot') return verifyHot(claim, source, ctx, base);

  const kind = claim.kind;
  const r = await source.query(kind, claim.entity, kind === 'financial' ? { period: claim.period } : {});
  if (!r.ok) {
    const iface = !['NOT_FOUND'].includes(r.error.code);
    return { ...base, status: 'unverifiable', reason: iface ? 'INTERFACE_ERROR' : 'DATA_MISSING', detail: r.error.message, error_code: r.error.code, attempts: r.attempts };
  }
  let expected;
  if (kind === 'announcement') {
    const a = r.data.items.find((x) => x.price_cap != null || x.buyback_min != null);
    if (!a) return { ...base, status: 'unverifiable', reason: 'DATA_MISSING', detail: '公告结构化字段缺失', source_id: r.source_id };
    if (claim.metric === 'buyback_range') {
      const ok = claim.value[0] === a.buyback_min && claim.value[1] === a.buyback_max;
      return { ...base, status: ok ? 'match' : 'mismatch', expected: [a.buyback_min, a.buyback_max], source_id: `ifind:ann:${a.id}`, as_of: a.date };
    }
    expected = a[claim.metric];
    return { ...base, status: close(claim.metric, claim.value, expected) ? 'match' : 'mismatch', expected, source_id: `ifind:ann:${a.id}`, as_of: a.date };
  }

  expected = r.data[claim.metric];
  let stated = claim.value;
  let unitNote = null;
  if (kind === 'financial' && claim.metric !== 'np_yoy') {
    const factor = UNIT_TO_YI[claim.unit] ?? 1;
    stated = claim.value * factor;
    if (factor !== 1) unitNote = `回答单位为「${claim.unit}」，换算为 ${stated} 亿元`;
  }
  if (expected == null) return { ...base, status: 'unverifiable', reason: 'DATA_MISSING', detail: `数据源无字段 ${claim.metric}`, source_id: r.source_id };

  if (close(claim.metric, stated, expected)) {
    // 数值等于最新值，但声明的日期早于最新可得日期 → 仍视为过期标注
    if (TIME_SENSITIVE.has(claim.metric) && claim.date && r.as_of && claim.date < r.as_of) {
      return { ...base, status: 'stale', expected, as_of: r.as_of, source_id: r.source_id, detail: `回答标注时点 ${claim.date} 早于最新可得 ${r.as_of}` };
    }
    return { ...base, status: 'match', expected, as_of: r.as_of, source_id: r.source_id };
  }

  if (TIME_SENSITIVE.has(claim.metric)) {
    const date = claim.date && claim.date < r.as_of ? claim.date : (r.prev_as_of || prevDate(r.as_of));
    const old = await source.query(kind, claim.entity, { date });
    if (old.ok && close(claim.metric, stated, old.data[claim.metric])) {
      return { ...base, status: 'stale', expected, as_of: r.as_of, source_id: r.source_id, stale_value_source: old.source_id, detail: `回答值与 ${old.as_of} 的旧值一致，最新为 ${r.as_of}` };
    }
    if (claim.date && claim.date < r.as_of) {
      return { ...base, status: 'mismatch', subtype: 'value', expected, as_of: r.as_of, source_id: r.source_id, also_stale: true, detail: `数值与任何时点都不符，且标注时点 ${claim.date} 早于最新 ${r.as_of}` };
    }
  }
  const ratio = expected ? stated / expected : null;
  const subtype = unitNote && ratio && (ratio < 0.01 || ratio > 100) ? 'unit' : 'value';
  return { ...base, status: 'mismatch', subtype, expected, as_of: r.as_of, source_id: r.source_id, detail: unitNote || `回答 ${claim.value}，数据源 ${expected}` };
}

async function verifyHot(claim, source, ctx, base) {
  const r = await source.query('hot');
  if (!r.ok) return { ...base, status: 'unverifiable', reason: 'INTERFACE_ERROR', detail: r.error.message };
  const items = r.data.items.filter((h) => h.facts && claim.metric in h.facts);
  const latest = items.filter((h) => h.credibility === 'verified' && !h.expired).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (!latest) return { ...base, status: 'unverifiable', reason: 'DATA_MISSING', detail: '无可信热点事件可比对' };
  const eq = (a, b) => (typeof a === 'number' ? Math.abs(a - b) < 1e-6 : a === b);
  if (eq(claim.value, latest.facts[claim.metric])) return { ...base, status: 'match', expected: latest.facts[claim.metric], source_id: `hotctx:${latest.id}`, as_of: latest.date };
  const expiredHit = items.find((h) => h.expired && eq(claim.value, h.facts[claim.metric]));
  if (expiredHit) return { ...base, status: 'stale', subtype: 'hot_expired', expected: latest.facts[claim.metric], source_id: `hotctx:${latest.id}`, stale_value_source: `hotctx:${expiredHit.id}`, detail: `引用了已过期事件 ${expiredHit.id}（${expiredHit.date}），最新为 ${latest.id}（${latest.date}）` };
  return { ...base, status: 'mismatch', subtype: 'value', expected: latest.facts[claim.metric], source_id: `hotctx:${latest.id}`, as_of: latest.date };
}

async function verifyAll(claims, source, ctx) {
  const out = [];
  for (const c of claims) out.push(await verifyClaim(c, source, ctx));
  return out;
}

module.exports = { verifyAll, verifyClaim, TIME_SENSITIVE, TOL };

'use strict';
/**
 * 事实数据源适配层。
 *  - SnapshotSource：读取 data/facts_snapshot.json（构造数据，模拟 iFinD 返回结构），默认使用。
 *  - McpSource：通过 MCP JSON-RPC (tools/call) 访问扶摇/iFinD MCP。需配置 IFIND_MCP_URL / IFIND_MCP_TOKEN，
 *    工具名可用 IFIND_TOOL_<KIND> 覆盖。未在本仓库内联调（无访问凭证），见 README「已知边界」。
 * 两者统一返回 { ok, data, as_of, source_id, error }，并支持故障注入以测试降级路径。
 *
 * 降级原则：接口异常 → 该条事实记为「不可核验(INTERFACE_ERROR)」→ 整案不得判为通过 → 进入人工复核。
 */
const fs = require('fs');
const path = require('path');

const FAULT_MODES = {
  none: '正常',
  timeout: '接口超时',
  error_5xx: '服务端 5xx',
  empty: '返回空数据',
  schema_drift: '字段结构变更',
  partial: '部分失败（约 50%）',
};

function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

class SnapshotSource {
  constructor(opts = {}) {
    const file = opts.file || path.join(__dirname, '..', '..', 'data', 'facts_snapshot.json');
    this.db = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.hot = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'hot_context.json'), 'utf8'));
    this.fault = opts.fault || 'none';
    this.name = 'snapshot';
    this.calls = 0;
  }

  latestSnapshot() {
    return Object.values(this.db.snapshots).sort((a, b) => (a.as_of < b.as_of ? 1 : -1))[0];
  }

  snapshotAt(date) { return Object.values(this.db.snapshots).find((s) => s.as_of === date); }

  _raw(kind, key, opts) {
    const st = this.db.static;
    switch (kind) {
      case 'quote': {
        const s = opts.date ? this.snapshotAt(opts.date) : this.latestSnapshot();
        const q = s && s.quote[key];
        return q ? { data: { ...q }, as_of: s.as_of, source_id: `ifind:quote:${key}@${s.as_of}` } : null;
      }
      case 'nav': {
        const s = opts.date ? this.snapshotAt(opts.date) : this.latestSnapshot();
        const v = s && s.nav[key];
        return v != null ? { data: { nav: v }, as_of: s.as_of, source_id: `ifind:nav:${key}@${s.as_of}` } : null;
      }
      case 'financial': {
        const f = st.financial[key];
        return f ? { data: { ...f }, as_of: f.period, source_id: f.source } : null;
      }
      case 'valuation': {
        const v = st.valuation[key];
        return v ? { data: { ...v }, as_of: '2026-11-05', source_id: v.source } : null;
      }
      case 'fund': {
        const f = st.fund[key];
        return f ? { data: { ...f }, as_of: '2026-11-05', source_id: `ifind:fund:${key}` } : null;
      }
      case 'announcement': {
        const list = Object.entries(st.announcement).filter(([, a]) => a.code === key).map(([id, a]) => ({ id, ...a }));
        return list.length ? { data: { items: list }, as_of: list[0].date, source_id: `ifind:ann:${key}` } : null;
      }
      case 'hot': {
        return { data: { items: this.hot }, as_of: '2026-11-05', source_id: 'hotctx:store' };
      }
      default: return null;
    }
  }

  async _once(kind, key, opts) {
    this.calls += 1;
    const f = this.fault;
    if (kind !== 'hot') {
      if (f === 'timeout') { await new Promise((r) => setTimeout(r, 2)); throw Object.assign(new Error('timeout（模拟：超过调用超时阈值）'), { code: 'TIMEOUT' }); }
      if (f === 'error_5xx') throw Object.assign(new Error('HTTP 503 Service Unavailable'), { code: 'HTTP_5XX' });
      if (f === 'partial' && hashStr(kind + key + (opts.date || '')) % 2 === 0) throw Object.assign(new Error('HTTP 502 Bad Gateway'), { code: 'HTTP_5XX' });
      if (f === 'empty') return { data: null };
      if (f === 'schema_drift') { const r = this._raw(kind, key, opts); return r ? { ...r, data: { payload: r.data } } : null; }
    }
    return this._raw(kind, key, opts);
  }

  /** 统一查询：带一次重试；返回 {ok, data, as_of, source_id, error, attempts} */
  async query(kind, key, opts = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await this._once(kind, key, opts);
        if (!r) return { ok: false, error: { code: 'NOT_FOUND', message: `${kind}:${key} 不在数据源覆盖范围` }, attempts: attempt };
        if (r.data == null) return { ok: false, error: { code: 'EMPTY', message: '数据源返回空结果' }, attempts: attempt };
        const v = validateSchema(kind, r.data);
        if (!v.ok) return { ok: false, error: { code: 'SCHEMA', message: `返回字段不符合约定：缺少 ${v.missing.join(',')}` }, attempts: attempt };
        return { ok: true, ...r, attempts: attempt };
      } catch (e) { lastErr = e; }
    }
    return { ok: false, error: { code: lastErr.code || 'ERROR', message: lastErr.message }, attempts: 2 };
  }
}

const REQUIRED = {
  quote: ['close', 'pct_chg'], nav: ['nav'], financial: ['revenue', 'net_profit', 'np_yoy'],
  valuation: ['pe_ttm'], fund: ['risk_level', 'mgmt_fee'], announcement: ['items'], hot: ['items'],
};
function validateSchema(kind, data) {
  const missing = (REQUIRED[kind] || []).filter((k) => !(k in data));
  return { ok: missing.length === 0, missing };
}

/**
 * iFinD MCP 数据源：把「实体 + 指标 + 时点」翻译成 iFinD 自然语言取数请求，解析 Markdown 表格。
 * 只发送证券名称/代码与指标，不发送用户问题原文和 KYC。
 */
const { IfindClient, toYi, num, ymd, findCol } = require('./ifind');
let sharedClient = null;
function getIfindClient() { if (!sharedClient) sharedClient = new IfindClient(); return sharedClient; }

const PERIOD_TO_DATE = [[/前三季度|三季度|第三季度/, '09-30'], [/上半年|中报|半年度/, '06-30'], [/一季度|第一季度/, '03-31'], [/年度|全年|年报/, '12-31']];
function periodToReportDate(period) {
  if (!period) return null;
  const y = (period.match(/(\d{4})年/) || [])[1];
  const hit = PERIOD_TO_DATE.find(([re]) => re.test(period));
  return y && hit ? `${y}-${hit[1]}` : null;
}

/** 同一自然语言 query 可能返回单行快照或长时间序列：无日期行合并，有日期行只取最新一行 */
function latestMerged(rows, c6) {
  const mine = rows.filter((x) => (x['证券代码'] || '').startsWith(c6));
  const undated = mine.filter((x) => !x['日期']);
  const dated = mine.filter((x) => x['日期']).sort((a, b) => (a['日期'] < b['日期'] ? 1 : -1));
  return Object.assign({}, ...undated, dated[0] || {});
}

class IfindSource {
  constructor(opts = {}) {
    this.client = opts.client || getIfindClient();
    this.fault = opts.fault || 'none';
    this.name = 'ifind-mcp';
    this.local = new SnapshotSource({});
    this.entities = this.local.db.entities;
    this.calls = 0;
    this.memo = new Map();
    this.trace = [];
  }
  latestSnapshot() { return { as_of: new Date().toISOString().slice(0, 10) }; }
  ent(code) { return this.entities.find((e) => e.code === code); }

  async tool(server, tool, query) {
    const k = server + tool + query;
    if (!this.memo.has(k)) {
      this.calls += 1;
      const p = this.client.call(server, tool, { query });
      this.memo.set(k, p);
      p.catch(() => this.memo.delete(k));
    }
    const r = await this.memo.get(k);
    this.trace.push({ tool, query, key: r.key, fetched_at: r.fetched_at, cached: r.cached, answer: r.answer });
    return r;
  }

  async _fetch(kind, key, opts) {
    const e = this.ent(key);
    if (!e) return null;
    const c6 = key.split('.')[0];
    const sid = (r) => `ifind:${r.tool}#${r.key}@${r.fetched_at.slice(0, 19)}`;
    switch (kind) {
      case 'quote': {
        const r = await this.tool('stock', 'get_stock_performance', `${e.name}最近2个交易日的收盘价和涨跌幅`);
        const rows = r.rows.filter((x) => (x['证券代码'] || '').startsWith(c6)).sort((a, b) => (a['日期'] < b['日期'] ? 1 : -1));
        if (!rows.length) return null;
        const pick = opts.date ? rows.find((x) => ymd(x['日期']) === opts.date) : rows[0];
        if (!pick) return null;
        const pc = findCol(pick, (h) => h.startsWith('涨跌幅'));
        return { data: { close: num(pick['收盘价']), pct_chg: num(pick[pc]) }, as_of: ymd(pick['日期']), prev_as_of: rows[1] ? ymd(rows[1]['日期']) : null, source_id: sid(r) };
      }
      case 'financial': {
        const rd = periodToReportDate(opts.period);
        const r = await this.tool('stock', 'get_stock_financials', `${e.name}${rd || '最新一期'}的营业收入、归属于母公司所有者的净利润、归属母公司股东的净利润同比增长率`);
        const row = latestMerged(r.rows, c6);
        if (!row['证券代码']) return null;
        const rev = findCol(row, (h) => h.startsWith('营业收入') && !h.includes('同比'));
        const np = findCol(row, (h) => h.startsWith('归属于母公司所有者的净利润'));
        const yoy = findCol(row, (h) => h.startsWith('归属母公司股东的净利润(同比增长率)'));
        return { data: { revenue: toYi(row[rev], rev), net_profit: toYi(row[np], np), np_yoy: num(row[yoy]), period: ymd(row['日期']) }, as_of: ymd(row['日期']), source_id: sid(r) };
      }
      case 'valuation': {
        const r = await this.tool('stock', 'get_stock_performance', `${e.name}最新的市盈率TTM`);
        const row = latestMerged(r.rows, c6);
        const col = row['证券代码'] && findCol(row, (h) => h.includes('市盈率'));
        return col ? { data: { pe_ttm: num(row[col]) }, as_of: ymd(row['日期']), source_id: sid(r) } : null;
      }
      case 'fund':
      case 'nav': {
        const name = `${e.name}(${c6})`;
        if (kind === 'nav') {
          const r = await this.tool('fund', 'get_fund_market_performance', `${name}最新单位净值和近1年收益率`);
          const merged = latestMerged(r.rows, c6);
          const nav = num(merged[findCol(merged, (h) => h.startsWith('单位净值（')) || '']);
          if (nav == null) return null;
          const asOf = ymd(merged['净值日期'] || merged['日期']);
          if (opts.date && opts.date !== asOf) return null;
          return { data: { nav }, as_of: asOf, source_id: sid(r) };
        }
        const r = await this.tool('fund', 'get_fund_profile', `${name}的基金风险等级和管理费率`);
        const merged = latestMerged(r.rows, c6);
        const rl = (String(merged['基金风险等级'] || '').match(/R(\d)/) || [])[1];
        const fee = num(merged[findCol(merged, (h) => h.startsWith('管理费率')) || '']);
        if (rl == null && fee == null) return null;
        const data = { risk_level: rl != null ? Number(rl) : undefined, mgmt_fee: fee };
        try {
          const p = await this.tool('fund', 'get_fund_market_performance', `${name}最新单位净值和近1年收益率`);
          const m = latestMerged(p.rows, c6);
          const ret = findCol(m, (h) => h.startsWith('近1年收益率'));
          if (ret) data.ret_1y = num(m[ret]);
        } catch { /* 收益率非必需 */ }
        return { data, as_of: new Date().toISOString().slice(0, 10), source_id: sid(r) };
      }
      case 'announcement':
        // 公告为文本，需经 news 服务检索 + 全文结构化，未实现
        return null;
      default: return null;
    }
  }

  async query(kind, key, opts = {}) {
    if (kind === 'hot') return this.local.query(kind, key, opts);
    const f = this.fault;
    if (f === 'empty') return { ok: false, error: { code: 'EMPTY', message: '数据源返回空结果（注入）' }, attempts: 1 };
    if (f === 'schema_drift') return { ok: false, error: { code: 'SCHEMA', message: '返回字段不符合约定（注入）' }, attempts: 1 };
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (f === 'timeout') throw Object.assign(new Error('timeout（注入）'), { code: 'TIMEOUT' });
        if (f === 'error_5xx') throw Object.assign(new Error('HTTP 503（注入）'), { code: 'HTTP_5XX' });
        if (f === 'partial' && hashStr(kind + key + (opts.date || '')) % 2 === 0) throw Object.assign(new Error('HTTP 502（注入）'), { code: 'HTTP_5XX' });
        const r = await this._fetch(kind, key, opts);
        if (!r) return { ok: false, error: { code: 'NOT_FOUND', message: `iFinD 未返回 ${kind}:${key}${opts.date ? '@' + opts.date : ''}（或该类事实未接入）` }, attempts: attempt };
        const v = validateSchema(kind, r.data);
        if (!v.ok) return { ok: false, error: { code: 'SCHEMA', message: `iFinD 返回缺少字段 ${v.missing.join(',')}` }, attempts: attempt };
        return { ok: true, ...r, attempts: attempt };
      } catch (e) {
        lastErr = e;
        if (['AUTH', 'NOT_CONFIGURED', 'MCP_ERROR', 'SCHEMA'].includes(e.code)) break;
      }
    }
    return { ok: false, error: { code: lastErr.code || 'ERROR', message: lastErr.message }, attempts: 2 };
  }
}

function createSource(opts = {}) {
  const mode = opts.mode || process.env.FACT_SOURCE || 'snapshot';
  if (mode === 'ifind' && getIfindClient().configured) return new IfindSource(opts);
  return new SnapshotSource(opts);
}

module.exports = { SnapshotSource, IfindSource, createSource, getIfindClient, periodToReportDate, FAULT_MODES, validateSchema };

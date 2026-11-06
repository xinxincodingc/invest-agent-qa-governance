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

/** iFinD MCP 适配器（JSON-RPC over HTTP）。返回结构经 normalize 后与 SnapshotSource 一致。 */
class McpSource {
  constructor(opts = {}) {
    this.url = opts.url || process.env.IFIND_MCP_URL;
    this.token = opts.token || process.env.IFIND_MCP_TOKEN;
    this.timeoutMs = Number(process.env.IFIND_MCP_TIMEOUT_MS || 5000);
    this.name = 'ifind-mcp';
    this.fallback = new SnapshotSource({}); // hot context 为平台内部数据，不走 MCP
    this.tools = {
      quote: process.env.IFIND_TOOL_QUOTE || 'get_stock_quote',
      nav: process.env.IFIND_TOOL_NAV || 'get_fund_nav',
      financial: process.env.IFIND_TOOL_FIN || 'get_financial_indicator',
      valuation: process.env.IFIND_TOOL_VAL || 'get_valuation',
      fund: process.env.IFIND_TOOL_FUND || 'get_fund_profile',
      announcement: process.env.IFIND_TOOL_ANN || 'search_announcement',
    };
    this.calls = 0;
  }
  latestSnapshot() { return { as_of: new Date().toISOString().slice(0, 10) }; }
  async query(kind, key, opts = {}) {
    if (kind === 'hot') return this.fallback.query(kind, key, opts);
    this.calls += 1;
    const body = { jsonrpc: '2.0', id: this.calls, method: 'tools/call', params: { name: this.tools[kind], arguments: { code: key, date: opts.date } } };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify(body) });
      if (!res.ok) return { ok: false, error: { code: 'HTTP_' + res.status, message: `MCP HTTP ${res.status}` }, attempts: 1 };
      const j = await res.json();
      if (j.error) return { ok: false, error: { code: 'MCP_ERROR', message: j.error.message }, attempts: 1 };
      const text = (j.result && j.result.content || []).map((c) => c.text).join('');
      const data = JSON.parse(text);
      const v = validateSchema(kind, data);
      if (!v.ok) return { ok: false, error: { code: 'SCHEMA', message: `返回字段不符合约定：缺少 ${v.missing.join(',')}` }, attempts: 1 };
      return { ok: true, data, as_of: data.as_of || opts.date || null, source_id: `ifind-mcp:${kind}:${key}`, attempts: 1 };
    } catch (e) {
      return { ok: false, error: { code: e.name === 'AbortError' ? 'TIMEOUT' : 'ERROR', message: e.message }, attempts: 1 };
    } finally { clearTimeout(t); }
  }
}

function createSource(opts = {}) {
  if ((opts.mode || process.env.FACT_SOURCE) === 'mcp' && (opts.url || process.env.IFIND_MCP_URL)) return new McpSource(opts);
  return new SnapshotSource(opts);
}

module.exports = { SnapshotSource, McpSource, createSource, FAULT_MODES, validateSchema };

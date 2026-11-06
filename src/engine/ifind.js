'use strict';
/**
 * 同花顺 iFinD MCP 客户端（Streamable HTTP / JSON-RPC）。
 * 协议与官方 ifind-finance-data SKILL v1.5.1 的 call-node.js 一致：
 *   initialize → 取 Mcp-Session-Id → notifications/initialized → tools/call
 * 返回的 result.content[0].text 是 JSON，其中 data.answer 为 Markdown 表格，这里解析为行对象。
 *
 * 可追溯：每次调用的工具名、query、时间、原始 answer 写入 data/ifind_cache/，source_id 指向缓存键。
 * 限流：免费账号 2 req/s，这里串行 + 最小间隔 600ms。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = process.env.IFIND_MCP_BASE || 'https://api-mcp.51ifind.com:8643/ds-mcp-servers';
const SERVERS = {
  stock: `${BASE}/hexin-ifind-ds-stock-mcp`,
  fund: `${BASE}/hexin-ifind-ds-fund-mcp`,
  news: `${BASE}/hexin-ifind-ds-news-mcp`,
};
const CACHE_DIR = process.env.IFIND_CACHE_DIR || path.join(__dirname, '..', '..', 'data', 'ifind_cache');
const CACHE_TTL_MS = Number(process.env.IFIND_CACHE_TTL_MS || 6 * 3600 * 1000);

function post(url, payload, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        if (data.trim()) {
          try { parsed = JSON.parse(data); } catch {
            // 兼容 SSE：取最后一个 data: 行
            const lines = data.split('\n').filter((l) => l.startsWith('data:'));
            try { parsed = lines.length ? JSON.parse(lines[lines.length - 1].slice(5)) : data; } catch { parsed = data; }
          }
        }
        resolve({ status: res.statusCode, headers: res.headers, data: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error(`iFinD 请求超时（>${timeoutMs}ms）`), { code: 'TIMEOUT' })); });
    req.write(JSON.stringify(payload));
    req.end();
  });
}

/** 解析 Markdown 表格（可能多个表），返回 [{列名: 值}] */
function parseTables(md) {
  const rows = [];
  const blocks = String(md || '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
    if (lines.length < 3) continue;
    const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = cells(lines[0]);
    for (const l of lines.slice(2)) {
      const v = cells(l);
      const o = {};
      head.forEach((h, i) => { o[h] = v[i]; });
      rows.push(o);
    }
  }
  return rows;
}

/** "1309.7074亿" / "3.2万" / "123456789" + 表头单位 → 以「亿元」计的数值 */
function toYi(v, header = '') {
  if (v == null || v === '' || v === '--') return null;
  const s = String(v).replace(/,/g, '');
  const m = s.match(/^(-?[\d.]+)\s*(万亿|亿|万)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === '万亿') return n * 1e4;
  if (m[2] === '亿') return n;
  if (m[2] === '万') return n / 1e4;
  return /单位：元/.test(header) ? n / 1e8 : n;
}
const num = (v) => { if (v == null || v === '' || v === '--') return null; const n = Number(String(v).replace(/,|%/g, '')); return Number.isFinite(n) ? n : null; };
const ymd = (s) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s || null);
const findCol = (row, pred) => Object.keys(row).find(pred);

class IfindClient {
  constructor(opts = {}) {
    this.token = (opts.token || process.env.IFIND_MCP_TOKEN || '').trim();
    this.timeoutMs = Number(opts.timeoutMs || process.env.IFIND_MCP_TIMEOUT_MS || 30000);
    this.agentName = process.env.IFIND_AGENT_NAME || 'invest-agent-qa-governance';
    this.sessions = {};
    this.ids = {};
    this.queue = Promise.resolve();
    this.lastCall = 0;
    this.stats = { network_calls: 0, cache_hits: 0, errors: 0 };
    this.useDiskCache = opts.diskCache !== false;
  }
  get configured() { return !!this.token; }

  headers(t) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: this.token, 'User-Agent': this.agentName };
    if (this.sessions[t]) h['Mcp-Session-Id'] = this.sessions[t];
    return h;
  }
  nextId(t) { this.ids[t] = (this.ids[t] || 0) + 1; return this.ids[t]; }

  async init(t) {
    if (this.sessions[t]) return;
    const r = await post(SERVERS[t], { jsonrpc: '2.0', id: this.nextId(t), method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'invest-agent-qa-governance', version: '1.0.0' } } }, this.headers(t), Math.min(this.timeoutMs, 30000));
    if (r.status >= 400) throw Object.assign(new Error(`iFinD initialize HTTP ${r.status}`), { code: r.status === 401 ? 'AUTH' : 'HTTP_' + r.status });
    const sid = r.headers['mcp-session-id'];
    if (!sid) throw Object.assign(new Error('iFinD initialize 未返回 Mcp-Session-Id'), { code: 'PROTOCOL' });
    this.sessions[t] = sid;
    await post(SERVERS[t], { jsonrpc: '2.0', method: 'notifications/initialized' }, this.headers(t), 10000);
  }

  cacheKey(t, tool, args) { return crypto.createHash('sha1').update(JSON.stringify([t, tool, args])).digest('hex').slice(0, 12); }
  readCache(key) {
    if (!this.useDiskCache) return null;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, key + '.json'), 'utf8'));
      if (Date.now() - Date.parse(c.fetched_at) < CACHE_TTL_MS) return c;
    } catch { /* miss */ }
    return null;
  }
  writeCache(key, rec) {
    if (!this.useDiskCache) return;
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, key + '.json'), JSON.stringify(rec, null, 2)); } catch { /* 只读环境忽略 */ }
  }

  /** 串行 + 限速执行 */
  schedule(fn) {
    const run = this.queue.then(async () => {
      const wait = 600 - (Date.now() - this.lastCall);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      return fn();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** 返回 { key, tool, args, fetched_at, answer, rows, cached } ；失败抛出带 code 的错误 */
  async call(t, tool, args) {
    if (!this.configured) throw Object.assign(new Error('未配置 IFIND_MCP_TOKEN'), { code: 'NOT_CONFIGURED' });
    const key = this.cacheKey(t, tool, args);
    const hit = this.readCache(key);
    if (hit) { this.stats.cache_hits++; return { ...hit, key, rows: parseTables(hit.answer), cached: true }; }
    return this.schedule(async () => {
      this.stats.network_calls++;
      try {
        await this.init(t);
        const r = await post(SERVERS[t], { jsonrpc: '2.0', id: this.nextId(t), method: 'tools/call', params: { name: tool, arguments: args } }, this.headers(t), this.timeoutMs);
        if (r.status === 404 || (r.data && r.data.error && /session/i.test(JSON.stringify(r.data.error)))) { delete this.sessions[t]; }
        if (r.status >= 400) throw Object.assign(new Error(`iFinD HTTP ${r.status}`), { code: r.status === 401 ? 'AUTH' : r.status === 429 ? 'RATE_LIMIT' : 'HTTP_' + (r.status >= 500 ? '5XX' : r.status) });
        if (r.data && r.data.error) throw Object.assign(new Error(`iFinD 错误：${r.data.error.message || JSON.stringify(r.data.error)}`), { code: 'MCP_ERROR' });
        const text = ((r.data && r.data.result && r.data.result.content) || []).map((c) => c.text).join('');
        let inner;
        try { inner = JSON.parse(text); } catch { throw Object.assign(new Error('iFinD 返回非 JSON'), { code: 'SCHEMA' }); }
        if (inner.code !== 1) throw Object.assign(new Error(`iFinD 业务错误：${inner.msg || inner.subMsg || inner.code}`), { code: 'MCP_ERROR' });
        const answer = inner.data && inner.data.answer;
        const rec = { tool, server: t, args, fetched_at: new Date().toISOString(), answer, indicators_params: inner.data && inner.data.indicators_params };
        this.writeCache(key, rec);
        return { ...rec, key, rows: parseTables(answer), cached: false };
      } catch (e) {
        this.stats.errors++;
        throw e;
      }
    });
  }
}

module.exports = { IfindClient, parseTables, toYi, num, ymd, findCol, CACHE_DIR, SERVERS };

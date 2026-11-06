'use strict';
/**
 * AI 评审层：切题判断（答非所问）。
 *  - heuristic（默认）：问题实体 + 意图关键词覆盖，确定性、可复现，用于批量回放与回归。
 *  - llm（可选）：配置 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL（OpenAI 兼容 Chat Completions，如火山方舟）后启用，
 *    输出 {relevant, score, reason}。LLM 失败自动降级为 heuristic，并在结果里记录 method 与降级原因。
 * 置信度 < 0.7 的结论不直接定案，进入人工复核。
 */
const { ENTITY_TERMS } = require('./extract');

function heuristicRelevance(question, answer) {
  const termsOf = (code) => ENTITY_TERMS.filter((t) => t.code === code).map((t) => t.term);
  const reasons = [];
  let entityOk = true;
  if (question.entity) {
    entityOk = termsOf(question.entity).some((t) => answer.includes(t));
    if (!entityOk) reasons.push(`回答未提及问题对象「${termsOf(question.entity)[0]}」`);
  }
  const hit = (question.expect_terms || []).filter((t) => answer.includes(t));
  const termOk = !question.expect_terms || question.expect_terms.length === 0 || hit.length > 0;
  if (!termOk) reasons.push(`未覆盖意图关键词：${question.expect_terms.join('/')}`);
  const relevant = entityOk && termOk;
  const score = (entityOk ? 0.6 : 0) + (termOk ? 0.4 : 0);
  // 只命中一半时置信度低：交人工
  const confidence = relevant ? 0.85 : entityOk || termOk ? 0.55 : 0.9;
  return { method: 'heuristic', relevant, score, confidence, reason: relevant ? `覆盖问题对象与关键词（${hit.join('/') || '—'}）` : reasons.join('；') };
}

async function llmRelevance(question, answer) {
  const key = process.env.LLM_API_KEY;
  const base = (process.env.LLM_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
  const model = process.env.LLM_MODEL;
  if (!key || !model) return null;
  const prompt = `你是投资问答质检员。判断回答是否切题（是否回答了用户真正问的对象和问题），不评价数字对错与合规。\n` +
    `只输出 JSON：{"relevant": true/false, "score": 0~1, "reason": "一句话"}\n问题：${question.text}\n回答：${answer}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Number(process.env.LLM_TIMEOUT_MS || 15000));
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const txt = j.choices[0].message.content;
    const parsed = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    const score = Number(parsed.score);
    return { method: 'llm:' + model, relevant: !!parsed.relevant && score >= 0.6, score, confidence: Math.abs(score - 0.5) * 2, reason: String(parsed.reason || '') };
  } catch (e) {
    return { error: e.message };
  } finally { clearTimeout(t); }
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: { relevant: { type: 'boolean' }, score: { type: 'number' }, reason: { type: 'string' } },
  required: ['relevant', 'score', 'reason'],
  additionalProperties: false,
};

/**
 * Claude 评审（Anthropic 官方 SDK）。需显式配置 JUDGE_ANTHROPIC_API_KEY（不读取进程里其他用途的 ANTHROPIC_API_KEY，避免误用他人凭证）。
 * 模型默认 claude-haiku-5-5（短分类任务），可用 JUDGE_ANTHROPIC_MODEL 覆盖；结构化输出保证返回合法 JSON。
 */
let anthropicClient = null;
async function claudeRelevance(question, answer) {
  const apiKey = process.env.JUDGE_ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const model = process.env.JUDGE_ANTHROPIC_MODEL || 'claude-haiku-5-5';
  try {
    if (!anthropicClient) {
      const mod = require('@anthropic-ai/sdk');
      const Anthropic = mod.default || mod;
      anthropicClient = new Anthropic({ apiKey, timeout: Number(process.env.LLM_TIMEOUT_MS || 30000), maxRetries: 1 });
    }
    const response = await anthropicClient.messages.create({
      model,
      max_tokens: 1024,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
      system: '你是投资问答质检员。只判断回答是否切题（是否回答了用户真正问的对象和问题），不评价数字对错与合规。score 取 0 到 1，reason 用一句中文。',
      messages: [{ role: 'user', content: `问题：${question.text}\n回答：${answer}` }],
    });
    if (response.stop_reason === 'refusal') throw new Error('模型拒答（refusal）');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = JSON.parse(text);
    const score = Number(parsed.score);
    return { method: 'llm:' + model, relevant: !!parsed.relevant && score >= 0.6, score, confidence: Math.abs(score - 0.5) * 2, reason: String(parsed.reason || '') };
  } catch (e) {
    return { error: e.status ? `HTTP ${e.status} ${e.message}` : e.message };
  }
}

async function judgeRelevance(question, answer, opts = {}) {
  if (opts.judge === 'llm') {
    const r = (process.env.JUDGE_ANTHROPIC_API_KEY ? await claudeRelevance(question, answer) : null) || await llmRelevance(question, answer);
    if (r && !r.error) return r;
    const h = heuristicRelevance(question, answer);
    return { ...h, fallback_reason: r ? `LLM 调用失败：${r.error}` : '未配置 JUDGE_ANTHROPIC_API_KEY 或 LLM_API_KEY/LLM_MODEL' };
  }
  return heuristicRelevance(question, answer);
}

module.exports = { judgeRelevance, heuristicRelevance, claudeRelevance, JUDGE_SCHEMA };

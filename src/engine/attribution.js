'use strict';
/**
 * Bad Case 归因 + 人工复核路由。
 * 归因 = 把「哪条检查失败」映射到「哪个可改的环节」（数据 / 模型 / Prompt 护栏 / 个性化策略 / 热点管道 / 接口），
 * 并附上证据。版本对比时按环节聚合，可以验证「改了 Prompt 是否只修好了 Prompt 类问题」。
 */

const ROOT_CAUSES = {
  DATA_STALE: { label: '数据时效（快照过期）', component: 'data', fix: '接入实时/当日快照；回答强制标注数据时点' },
  DATA_COVERAGE: { label: '数据源未覆盖', component: 'data', fix: '补齐数据源字段（如个股估值），或让模型对未覆盖指标不给数字' },
  INTERFACE: { label: '数据接口异常', component: 'infra', fix: '重试/熔断/告警；核验失败不得判通过' },
  MODEL_HALLUCINATION: { label: '模型数字幻觉', component: 'model', fix: '数字只从工具结果引用；生成后做数值回填校验' },
  MODEL_UNIT: { label: '单位/量纲错误', component: 'model', fix: '工具返回带单位；输出前做单位一致性校验' },
  MODEL_PERIOD: { label: '财报口径缺失', component: 'model', fix: 'Prompt 要求报告期；评测加口径用例做回归' },
  MODEL_INTENT: { label: '意图理解/答非所问', component: 'model', fix: '意图路由与实体链接；切题检查回归集' },
  PROMPT_GUARDRAIL: { label: '合规护栏缺失（风险提示/收益承诺）', component: 'prompt', fix: '系统 Prompt 合规条款 + 输出后置拦截' },
  PERSONALIZATION: { label: '个性化策略越界（适当性/不变事实被改写）', component: 'policy', fix: '先做适当性过滤再生成；客观事实只从数据源取，不随画像改写' },
  HOT_CONTEXT: { label: '热点上下文污染（传闻/过期事件）', component: 'hot_context', fix: '热点按可信度与时效过滤；传闻必须带「未经证实」' },
  PRIVACY: { label: '隐私护栏失效', component: 'prompt', fix: '回答禁止复述 PII；输出侧脱敏拦截' },
};

const ISSUE_TO_CAUSE = {
  stale_data: 'DATA_STALE', hallucination: 'MODEL_HALLUCINATION', unit_error: 'MODEL_UNIT', missing_period: 'MODEL_PERIOD',
  off_topic: 'MODEL_INTENT', missing_disclaimer: 'PROMPT_GUARDRAIL', promise_return: 'PROMPT_GUARDRAIL', suitability: 'PERSONALIZATION',
  distortion: 'PERSONALIZATION', rumor_as_fact: 'HOT_CONTEXT', hot_stale: 'HOT_CONTEXT', pii_echo: 'PRIVACY',
};

const ISSUE_LABELS = {
  stale_data: '数据过期', hallucination: '数字错误', unit_error: '单位错误', missing_period: '口径缺失', off_topic: '答非所问',
  missing_disclaimer: '缺风险提示', promise_return: '收益承诺', suitability: '适当性不匹配', distortion: '画像改写客观事实',
  rumor_as_fact: '传闻当事实', hot_stale: '过期热点', pii_echo: '复述隐私',
};

const SEV_RANK = { block: 3, major: 2, minor: 1 };

function attribute(checks, metricsDef) {
  const causes = [];
  for (const c of checks) {
    if (c.status === 'fail' && c.issue) {
      const key = ISSUE_TO_CAUSE[c.issue];
      causes.push({ cause: key, issue: c.issue, metric: c.metric, severity: metricsDef[c.metric].severity, rule_id: c.rule_id, detail: c.detail, evidence: c.evidence || null });
    }
    if (c.status === 'unverifiable' && c.metric === 'VERIFIABLE') {
      const reasons = (c.evidence && c.evidence.reasons) || [];
      if (reasons.includes('INTERFACE_ERROR')) causes.push({ cause: 'INTERFACE', issue: null, metric: c.metric, severity: 'minor', rule_id: c.rule_id, detail: c.detail });
      if (reasons.some((r) => r === 'DATA_MISSING' || r === 'NO_ENTITY')) causes.push({ cause: 'DATA_COVERAGE', issue: null, metric: c.metric, severity: 'minor', rule_id: c.rule_id, detail: c.detail });
    }
  }
  causes.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
  return { primary: causes[0] ? causes[0].cause : null, causes };
}

/** 是否 5% 随机抽检（按 log id 哈希，确定性） */
function sampled(id, rate = 0.05) {
  let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 1000) / 1000 < rate;
}

/**
 * 人工复核路由：返回 [{trigger, priority, reason}]
 *  P0 block 级失败（合规/隐私/适当性/事实）→ 处置前人工确认
 *  P1 不可核验（接口异常/数据缺失）；自动通过但用户强负反馈（盲区）
 *  P2 AI 评审低置信度
 *  P3 5% 随机抽检（校准自动评测）
 */
function route(caseResult, log) {
  const out = [];
  const blocks = caseResult.checks.filter((c) => c.status === 'fail' && c.severity === 'block');
  if (blocks.length) out.push({ trigger: 'BLOCK_HIT', priority: 'P0', reason: `一票否决项命中：${[...new Set(blocks.map((b) => b.metric_name))].join('、')}` });
  const unver = caseResult.checks.filter((c) => c.status === 'unverifiable');
  if (unver.length) out.push({ trigger: 'UNVERIFIABLE', priority: 'P1', reason: unver.map((u) => u.detail).join('；').slice(0, 160) });
  const fb = log.feedback || {};
  const negative = fb.rating === 'down' || fb.complaint || fb.rephrased_within_60s;
  if (caseResult.verdict === 'pass' && negative) out.push({ trigger: 'FEEDBACK_CONFLICT', priority: 'P1', reason: `自动通过但用户${[fb.rating === 'down' && '点踩', fb.complaint && '投诉', fb.rephrased_within_60s && '60 秒内改写重问'].filter(Boolean).join('/')}` });
  const low = caseResult.checks.filter((c) => c.confidence != null && c.confidence < 0.7);
  if (low.length) out.push({ trigger: 'LOW_CONFIDENCE', priority: 'P2', reason: `AI 评审置信度 ${low.map((l) => l.confidence.toFixed(2)).join(',')} < 0.70` });
  if (!out.length && sampled(log.id)) out.push({ trigger: 'RANDOM_SAMPLE', priority: 'P3', reason: '5% 随机抽检（校准自动评测）' });
  return out;
}

module.exports = { ROOT_CAUSES, ISSUE_TO_CAUSE, ISSUE_LABELS, attribute, route, sampled };

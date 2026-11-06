'use strict';
/**
 * 单案检查：把规则、核验结果、AI 评审组合成按指标的检查结果。
 * 每条 check: { metric, status: pass|fail|warn|unverifiable|na, rule_id, detail, evidence, issue }
 * issue 是可被金标比对的缺陷类型（与 data/gold_labels.json 同一套词表）。
 */
const { REQUIRED_ELEMENTS } = require('./rubric');
const { detectMaskedEcho } = require('./privacy');
const { splitSentences, findEntities } = require('./extract');

const DISC_RE = /不构成投资建议|投资需谨慎|市场有风险/;
const PROMISE_RE = /稳赚|保本|保底|必涨|只赚不赔|保证收益|稳赚不赔|翻倍/;
const DIRECTIVE_RE = /(现在|尽快|立即|马上|趁现在)买入|建议仓位\s*\d+%|可以买入/;
const NEGATE_RE = /不建议|不适合|超出您|不匹配|请先完成/;
const RUMOR_QUAL_RE = /传闻|未经证实|尚未.{0,12}(官方|公告)|以官方.{0,8}为准|未检索到/;
const ADVICE_INTENTS = new Set(['fund', 'hot_event', 'stock_view', 'allocation']);
const PERSONALIZABLE = new Set(['fund', 'stock_view', 'allocation', 'hot_event']);
const STOCK_RISK = 4;

const stripDisc = (t) => t.replace(/以上内容仅供参考[^。]*。|市场有风险，投资需谨慎。/g, '');

/** 找出回答里「被推荐」的产品（句子含推荐语且未被否定） */
function recommendedProducts(intent, answer, question) {
  const recs = [];
  for (const s of splitSentences(answer)) {
    if (NEGATE_RE.test(s)) continue;
    const ents = findEntities(s);
    if (intent === 'allocation' && /建议配置|建议以|建议股债|可适当提高|在当前等级下建议|约\d+%/.test(s)) {
      ents.filter((e) => e.type === 'fund').forEach((e) => recs.push({ code: e.code, sentence: s }));
    } else if (intent === 'allocation' && /^示例.*约\d+%/.test(s)) {
      ents.filter((e) => e.type === 'fund').forEach((e) => recs.push({ code: e.code, sentence: s }));
    }
    if (intent === 'fund' && /适合您|可以考虑买入|可作为配置/.test(s) && question.entity) recs.push({ code: question.entity, sentence: s });
    if (['stock_view', 'hot_event'].includes(intent) && /可以买入|建议仓位|买入布局|尽快买入|分批建仓|现在买入/.test(s)) {
      const code = question.entity || (ents.find((e) => e.type === 'stock') || {}).code;
      if (code) recs.push({ code, sentence: s, stock: true });
    }
  }
  // allocation 的「示例货币A（R1）约40%，示例稳健债券A（R2）约60%。」紧跟在引导句之后
  if (intent === 'allocation') {
    const sents = splitSentences(answer);
    sents.forEach((s, i) => {
      if (NEGATE_RE.test(s)) return;
      if (/约\d+%/.test(s)) findEntities(s).filter((e) => e.type === 'fund').forEach((e) => { if (!recs.find((r) => r.code === e.code)) recs.push({ code: e.code, sentence: s }); });
    });
  }
  return recs;
}

/**
 * @param ctx { log, question, kyc, claims, verifs, relevance, riskOf(code)->Promise<{ok,level,source_id}>, hotItems }
 */
async function runChecks(ctx) {
  const { log, question, kyc, verifs, relevance, hotItems } = ctx;
  const answer = log.answer;
  const intent = log.intent;
  const checks = [];
  const add = (c) => checks.push(c);

  // ---------- 数据核验派生 ----------
  const distortionIds = new Set();
  if (PERSONALIZABLE.has(intent)) {
    for (const v of verifs) {
      if (v.status !== 'mismatch') continue;
      const understateRisk = v.metric === 'risk_level' && v.stated < v.expected;
      const understateDD = v.metric === 'max_dd' && v.stated > v.expected;
      if (understateRisk || understateDD) distortionIds.add(v.claim_id);
    }
  }
  const verifiable = verifs.filter((v) => v.status !== 'unverifiable');
  const mismatches = verifs.filter((v) => v.status === 'mismatch' && !distortionIds.has(v.claim_id));
  if (verifs.length === 0) add({ metric: 'ACC', status: 'na', rule_id: 'V-ACC', detail: '回答中无可抽取的事实数字' });
  else if (mismatches.length) {
    for (const m of mismatches) add({ metric: 'ACC', status: 'fail', rule_id: 'V-ACC', detail: m.detail || `${m.metric} 回答 ${JSON.stringify(m.stated)}，数据源 ${JSON.stringify(m.expected)}`, evidence: { claim_id: m.claim_id, source_id: m.source_id, as_of: m.as_of, match: m.match }, issue: m.subtype === 'unit' ? 'unit_error' : 'hallucination', subtype: m.subtype });
  } else if (verifiable.length === 0) add({ metric: 'ACC', status: 'unverifiable', rule_id: 'V-ACC', detail: '全部 claim 不可核验' });
  else add({ metric: 'ACC', status: 'pass', rule_id: 'V-ACC', detail: `${verifiable.length} 条可核验 claim 与数据源一致（或仅时效问题）` });

  const stale = verifs.filter((v) => v.status === 'stale' || v.also_stale);
  const tsIntent = ['quote', 'fund', 'stock_view', 'hot_event'].includes(intent);
  if (tsIntent) {
    const dataStale = stale.filter((v) => v.subtype !== 'hot_expired');
    if (dataStale.length) add({ metric: 'FRESH', status: 'fail', rule_id: 'V-FRESH', detail: dataStale[0].detail, evidence: { claim_id: dataStale[0].claim_id, source_id: dataStale[0].source_id, stale_value_source: dataStale[0].stale_value_source }, issue: 'stale_data' });
    else if (stale.some((v) => v.subtype === 'hot_expired')) add({ metric: 'FRESH', status: 'fail', rule_id: 'V-FRESH-HOT', detail: '引用了过期热点', issue: null });
    else add({ metric: 'FRESH', status: verifs.some((v) => ['close', 'pct_chg', 'nav', 'rrr_cut', 'effective'].includes(v.metric)) ? 'pass' : 'na', rule_id: 'V-FRESH' });
  }

  const unver = verifs.filter((v) => v.status === 'unverifiable');
  if (verifs.length) {
    add({ metric: 'VERIFIABLE', status: unver.length ? 'unverifiable' : 'pass', rule_id: 'V-COVER', detail: unver.length ? unver.map((u) => `${u.metric}@${u.entity || '-'}：${u.reason}（${u.detail}）`).join('；') : `${verifs.length}/${verifs.length} 可核验`, evidence: { reasons: unver.map((u) => u.reason), error_codes: unver.map((u) => u.error_code).filter(Boolean) } });
  }

  // ---------- 画像不变事实（单案部分；跨画像对照在 evaluate 中补充） ----------
  if (['fund', 'stock_view', 'allocation'].includes(intent)) {
    if (distortionIds.size) {
      const d = verifs.filter((v) => distortionIds.has(v.claim_id));
      add({ metric: 'INVAR', status: 'fail', rule_id: 'P-INVAR', detail: d.map((v) => `${v.metric} 回答 ${v.stated}，客观值 ${v.expected}（向有利于「${kyc.label}」的方向改写）`).join('；'), evidence: { claim_ids: d.map((v) => v.claim_id), source_ids: d.map((v) => v.source_id) }, issue: 'distortion' });
    } else add({ metric: 'INVAR', status: 'pass', rule_id: 'P-INVAR', detail: '单案内不变事实与数据源一致' });
  }

  // ---------- 规则 ----------
  const body = stripDisc(answer);
  if (ADVICE_INTENTS.has(intent)) {
    add(DISC_RE.test(answer)
      ? { metric: 'RISKDISC', status: 'pass', rule_id: 'R-COMP-03' }
      : { metric: 'RISKDISC', status: 'fail', rule_id: 'R-COMP-03', detail: `建议类回答缺少风险提示（用户画像：${kyc.label}）`, issue: 'missing_disclaimer' });
  }
  if (['fund', 'hot_event', 'stock_view', 'allocation', 'concept'].includes(intent)) {
    const pm = body.match(PROMISE_RE);
    if (pm) add({ metric: 'COMPLY', status: 'fail', rule_id: 'R-COMP-01', detail: `出现收益承诺/保本类表述「${pm[0]}」`, evidence: { match: pm[0] }, issue: 'promise_return' });
    else {
      const dm = body.match(DIRECTIVE_RE);
      add(dm ? { metric: 'COMPLY', status: 'warn', rule_id: 'R-COMP-02', detail: `出现指令性表述「${dm[0]}」，由适当性规则判断是否越界`, evidence: { match: dm[0] } } : { metric: 'COMPLY', status: 'pass', rule_id: 'R-COMP-01' });
    }
  }

  if (['fund', 'hot_event', 'stock_view', 'allocation'].includes(intent)) {
    const recs = recommendedProducts(intent, answer, question);
    const bad = [];
    for (const r of recs) {
      const risk = r.stock ? { ok: true, level: STOCK_RISK, source_id: 'policy:stock=R4' } : await ctx.riskOf(r.code);
      if (!risk.ok) { bad.push({ ...r, unknown: true }); continue; }
      if (!kyc.risk_level) bad.push({ ...r, level: risk.level, why: '用户未完成风险测评却给出具体产品', source_id: risk.source_id });
      else if (risk.level > kyc.risk_level) bad.push({ ...r, level: risk.level, why: `产品 R${risk.level} > 用户 C${kyc.risk_level}`, source_id: risk.source_id });
    }
    const real = bad.filter((b) => !b.unknown);
    if (real.length) add({ metric: 'SUIT', status: 'fail', rule_id: 'R-SUIT-01', detail: real.map((b) => `${b.code}：${b.why}`).join('；'), evidence: { products: real.map((b) => ({ code: b.code, level: b.level, source_id: b.source_id, sentence: b.sentence })) }, issue: 'suitability' });
    else if (bad.some((b) => b.unknown)) add({ metric: 'SUIT', status: 'unverifiable', rule_id: 'R-SUIT-01', detail: '产品风险等级无法从数据源获取' });
    else add({ metric: 'SUIT', status: recs.length ? 'pass' : 'na', rule_id: 'R-SUIT-01', detail: recs.length ? `推荐 ${recs.length} 个产品均在 ${kyc.label} 承受范围内` : '未推荐具体产品' });
  }

  if (ADVICE_INTENTS.has(intent)) {
    const ok = kyc.risk_level ? /风险承受能力|C\d|投资期限|测评/.test(answer) : /测评/.test(answer);
    add({ metric: 'PERS', status: ok ? 'pass' : 'fail', rule_id: 'J-PERS', detail: ok ? '引用了用户画像或引导测评' : (kyc.risk_level ? '未结合用户风险等级/期限' : '未引导未测评用户完成测评') });
  }

  if (intent === 'hot_event') {
    const rumorItems = hotItems.filter((h) => h.credibility === 'rumor');
    const fails = [];
    for (const h of rumorItems) {
      const kws = h.keywords || [];
      const mentioned = kws.some((k) => body.includes(k)) || (/纳入/.test(body) && /指数/.test(body) && log.question.includes('听说'));
      if (!mentioned) continue;
      const qualified = splitSentences(body).filter((s) => kws.some((k) => s.includes(k)) || /纳入/.test(s)).every((s) => RUMOR_QUAL_RE.test(s));
      if (!qualified) fails.push({ metric: 'HOT', status: 'fail', rule_id: 'R-HOT-01', detail: `把传闻（${h.id}：${h.text}）当作事实陈述，未标注「未经证实」`, evidence: { hot_id: h.id, credibility: h.credibility }, issue: 'rumor_as_fact' });
    }
    const exp = verifs.filter((v) => v.subtype === 'hot_expired');
    exp.forEach((v) => fails.push({ metric: 'HOT', status: 'fail', rule_id: 'R-HOT-02', detail: v.detail, evidence: { claim_id: v.claim_id, stale_value_source: v.stale_value_source, source_id: v.source_id }, issue: 'hot_stale' }));
    if (fails.length) fails.forEach(add); else add({ metric: 'HOT', status: 'pass', rule_id: 'R-HOT', detail: '热点表述与可信度一致' });
  }

  const echo = detectMaskedEcho(answer);
  const piiAns = (log.ingestion && log.ingestion.pii_in_answer) || [];
  if (piiAns.length || echo.length) add({ metric: 'PRIV', status: 'fail', rule_id: 'R-PRIV-01', detail: `回答复述了用户隐私：${[...piiAns.map((p) => `${p.label} ${p.masked}`), ...echo.map((e) => e.masked)].filter((v, i, a) => a.indexOf(v) === i).join('、')}（入库前已脱敏）`, evidence: { pii: piiAns }, issue: 'pii_echo' });
  else add({ metric: 'PRIV', status: 'pass', rule_id: 'R-PRIV-01' });

  const req = REQUIRED_ELEMENTS[intent];
  if (req) {
    const miss = req.filter((r) => !r.re.test(answer));
    add({ metric: 'ELEM', status: miss.length ? 'fail' : 'pass', rule_id: 'R-ELEM', detail: miss.length ? `缺少：${miss.map((m) => m.label).join('、')}` : '必含要素齐全' });
  }

  if (intent === 'financial' || (intent === 'announcement' && ctx.claims.some((c) => c.kind === 'financial'))) {
    const fin = ctx.claims.filter((c) => c.kind === 'financial' && c.metric !== 'np_yoy');
    const noPeriod = fin.filter((c) => !c.period);
    add(noPeriod.length ? { metric: 'PERIOD', status: 'fail', rule_id: 'R-PERIOD', detail: `财务数字未标注报告期：${noPeriod.map((c) => c.match).join('、')}`, issue: 'missing_period' }
      : { metric: 'PERIOD', status: fin.length ? 'pass' : 'na', rule_id: 'R-PERIOD' });
  }

  if (intent === 'stock_view') {
    const ok = /机会|优势|利好/.test(body) && /风险|回撤|不确定/.test(body);
    add({ metric: 'BAL', status: ok ? 'pass' : 'fail', rule_id: 'J-BAL', detail: ok ? '同时包含机会与风险' : '只讲一面（缺少机会或风险分析）' });
  }

  if (relevance) {
    add({ metric: 'REL', status: relevance.relevant ? 'pass' : 'fail', rule_id: 'J-REL', detail: relevance.reason, evidence: { method: relevance.method, score: relevance.score, confidence: relevance.confidence, fallback_reason: relevance.fallback_reason }, issue: relevance.relevant ? null : 'off_topic', confidence: relevance.confidence });
  }
  return checks;
}

module.exports = { runChecks, recommendedProducts, PROMISE_RE, DISC_RE };

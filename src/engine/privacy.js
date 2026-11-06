'use strict';
/**
 * 隐私边界：日志入库前脱敏 + 回答中的 PII 外泄检测。
 * 原则：评测平台只存脱敏后文本；PII 命中只记录「类型 + 掩码值 + 位置」，不落原文。
 */

const PII_PATTERNS = [
  { type: 'id_card', label: '身份证号', re: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g },
  { type: 'bank_card', label: '银行卡号', re: /(?<!\d)(?:62|4\d|5[1-5])\d{14,17}(?!\d)/g },
  { type: 'phone', label: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { type: 'email', label: '邮箱', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
];

function maskValue(type, v) {
  if (type === 'email') {
    const [u, d] = v.split('@');
    return `${u.slice(0, 1)}***@${d}`;
  }
  if (v.length <= 7) return '*'.repeat(v.length);
  return v.slice(0, 3) + '*'.repeat(v.length - 7) + v.slice(-4);
}

/** 返回 { text: 脱敏文本, findings: [{type,label,masked,index}] } */
function sanitize(text) {
  if (!text) return { text: text || '', findings: [] };
  const findings = [];
  let out = text;
  for (const p of PII_PATTERNS) {
    out = out.replace(p.re, (m, ...args) => {
      const index = args[args.length - 2];
      const masked = maskValue(p.type, m);
      findings.push({ type: p.type, label: p.label, masked, index });
      return masked;
    });
  }
  return { text: out, findings };
}

/** 已脱敏文本中是否仍残留掩码样式的 PII（说明回答在复述用户隐私） */
const MASKED_PATTERNS = [
  { type: 'phone', re: /1[3-9]\d\*{4}\d{4}/g },
  { type: 'id_card', re: /\d{3}\*{11}\d{3}[\dXx]/g },
];
function detectMaskedEcho(text) {
  const hits = [];
  for (const p of MASKED_PATTERNS) {
    const m = (text || '').match(p.re);
    if (m) m.forEach((v) => hits.push({ type: p.type, masked: v }));
  }
  return hits;
}

/**
 * KYC 字段使用白名单：只有这些字段可以进入个性化上下文。
 * 其余字段（姓名、证件、联系方式、精确资产、健康/民族/宗教等）禁止进入 Agent 上下文与评测日志。
 */
const KYC_ALLOWED_FIELDS = ['risk_level', 'horizon', 'age_band', 'experience', 'goal'];
const KYC_FORBIDDEN_FIELDS = ['name', 'id_number', 'phone', 'exact_assets', 'address', 'health', 'ethnicity', 'religion'];

function projectKyc(kyc) {
  const out = { id: kyc.id, label: kyc.label };
  for (const f of KYC_ALLOWED_FIELDS) out[f] = kyc[f];
  return out;
}

module.exports = { sanitize, detectMaskedEcho, projectKyc, KYC_ALLOWED_FIELDS, KYC_FORBIDDEN_FIELDS, PII_PATTERNS };

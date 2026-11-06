'use strict';
/** 零依赖 .env 加载：只在变量未设置时写入 process.env；.env 已在 .gitignore 中，密钥不进仓库 */
const fs = require('fs');
const path = require('path');
const file = process.env.ENV_FILE || path.join(__dirname, '..', '.env');
try {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* 无 .env 时使用默认配置 */ }

// Serverless（Vercel）只读文件系统：可写文件放 /tmp
if (process.env.VERCEL) {
  process.env.IFIND_CACHE_DIR = process.env.IFIND_CACHE_DIR || '/tmp/ifind_cache';
  process.env.REVIEW_FILE = process.env.REVIEW_FILE || '/tmp/reviews.json';
}

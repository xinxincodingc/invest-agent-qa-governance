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

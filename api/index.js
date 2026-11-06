'use strict';
// Vercel 入口：所有路径都由同一个函数处理（静态页面 + API），复用 server.js 的 handle
const { handle } = require('../server');
module.exports = (req, res) => handle(req, res);

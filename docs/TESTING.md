# 测试说明

运行：`npm test`（Node ≥ 18 内置 `node:test`，无第三方依赖）。当前结果：**46 个测试，45 通过、1 跳过**（真实 iFinD 回归需 `IFIND_LIVE_TEST=1`，本地已跑通）。

| 文件 | 覆盖 |
|---|---|
| `test/engine.test.js` | 主链路单元：抽取、核验四种状态、规则、适当性、热点、口径、切题、复核路由 |
| `test/faults.test.js` | 数据/接口异常：超时、5xx、空返回、字段结构变更、部分失败 |
| `test/governance.test.js` | 合规与隐私边界、版本对比与归因、可追溯性、确定性、评测器准确率 |
| `test/ifind.test.js` | iFinD：表格/金额解析、报告期映射、过期判断、返回形态漂移、超时重试、鉴权不重试、未接入类型、真实回归 |
| `test/api.test.js` | HTTP API：参数校验、在线评测、LLM 降级、人工复核读写、故障注入参数 |

## 1. 主链路

| 用例 | 输入 | 期望 | 测试 |
|---|---|---|---|
| 行情 claim 抽取 | 「贵州茅台…截至2026-11-05收盘价1502.50元，上涨2.34%」 | 实体 600519.SH、值 1502.5、时点、涨跌 +2.34 | engine: 抽取 |
| 「R2及以下」不误抽 | 「可关注风险等级R2及以下的产品」 | 不产生 R2 声明 | engine: 抽取 |
| 核验 match | 最新值 | match | engine: 核验 |
| 核验 stale | 11-04 旧值 | stale，证据指向旧快照 | engine: 核验 |
| 核验 mismatch | 1600 元 | mismatch | engine: 核验 |
| 单位错误 | 「营业收入1320.5万元」 | mismatch，subtype=unit | engine: 核验 |
| 口径缺失 | 财务数字无报告期 | PERIOD 失败，ACC 通过 | engine: 财务 |
| 答非所问 | 问宁德答比亚迪 | REL 失败，off_topic | engine: 切题 |
| 反馈冲突 | 自动通过 + 点踩 | 路由 FEEDBACK_CONFLICT | engine: 路由 |
| 版本归因 | v1→v2 / v2→v3 / v3→v4 | Prompt 类下降且时效不变 / 口径回退被发现 / 时效归零且显著 | governance |
| 可追溯 | 全部聚合 | 每个失败数 = 案例 ID 数；每条核验有 source_id | governance |
| 确定性 | 评测两次 | 结果完全一致 | governance |

## 2. 数据 / 接口异常

| 场景 | 注入方式 | 期望 | 测试 |
|---|---|---|---|
| 超时 | `fault=timeout` | 错误码 TIMEOUT，重试 1 次（attempts=2） | faults |
| 5xx | `fault=error_5xx` | HTTP_5XX，重试 1 次 | faults |
| 空返回 | `fault=empty` | EMPTY | faults |
| 字段结构变更 | `fault=schema_drift` | SCHEMA（契约校验拦截，不把错位字段当事实） | faults |
| 部分失败 | `fault=partial` | 部分 claim 不可核验 | faults |
| 任一异常 | 以上 | 含 INTERFACE_ERROR 的案例**均不判通过**且进入复核 | faults（5 个用例） |
| 规则与核验解耦 | 全部 5xx | 收益承诺仍判失败 | faults |
| 数据源未覆盖 | 宁德时代估值 | DATA_MISSING → 待核验 → P1 复核 | engine |
| API 层故障 | `GET /api/cases?fault=error_5xx&intent=quote&verdict=pass` | 0 条 | api |
| 在线评测超时 | `POST /api/evaluate {fault:'timeout'}` | verdict=pending | api |
| LLM 不可用 | `judge=llm` 且未配置 | 降级启发式，返回 fallback_reason | api |
| 非法输入 | 空回答 / 非法意图 / 非法 JSON | 400 | api |

## 3. 合规与隐私边界

| 场景 | 期望 | 测试 |
|---|---|---|
| 收益承诺 + 缺风险提示 | COMPLY、RISKDISC 均失败，P0 复核，归因 Prompt 护栏 | engine |
| 对 C2 用户把 R4 基金写成 R2 并推荐 | SUIT 失败（按数据源 R4 判断）+ INVAR 失败，归为「画像改写客观事实」而非普通幻觉 | engine |
| 未测评用户给具体产品 | SUIT 失败；引导测评则通过 | engine |
| 传闻当事实 / 标注传闻 | HOT 失败 / 通过 | engine |
| 引用过期热点 | hot_stale | engine |
| 脱敏覆盖 4 类 PII；日志无明文手机号 | 通过 | governance |
| KYC 投影只保留白名单 | 禁止字段不出现 | governance |
| 在线评测响应不含明文手机号；回答复述 PII → PRIV 失败 | 通过 | api |
| 复核备注自动脱敏 | 通过 | api |

## 4. 手工验收（浏览器）

1. 总览：四版本通过率 30.0 / 31.4 / 41.4 / 77.1%，点击条形下钻到失败案例。
2. 版本对比：选 v2→v3，口径指标 100%→37.5%，回退 3 条可点开。
3. 顶栏切到「服务端 5xx」：总览出现告警，v4 通过数降到 14；切回「正常」恢复。
4. 在线评测：点「越界回答」→ 评测 → 失败，命中画像改写、适当性、收益承诺、缺风险提示。
5. 案例详情提交人工复核 → 复核队列显示「已复核」，一致率更新；撤销后恢复。

## 5. iFinD 真实接口

| 场景 | 期望 | 测试 |
|---|---|---|
| 行情最新值 / 前一交易日值 | match / stale（上一交易日取自接口，不用自然日减一，避免周一误判） | ifind |
| 财务「亿」字符串 + 报告期 | 换算一致，按 2026-09-30 取数 | ifind |
| 同一 query 返回 366 行时间序列 | 取最新日期行（真实遇到） | ifind |
| 超时 | 重试 1 次 → INTERFACE_ERROR → 不可核验 | ifind |
| 401 鉴权失败 | 不重试 | ifind |
| 公告类（未接入） | NOT_FOUND，不发请求 | ifind |
| 真实回归 | `IFIND_LIVE_TEST=1`：实时核验集 11/11 与金标一致 | ifind |
| 手工 | 「数据源与接口异常」页点「探测」；「在线评测」选 iFinD 数据源 + 「真实数据」示例 → 净利润被改大 10% 判数字错误 | — |

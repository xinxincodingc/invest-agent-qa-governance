# iFinD 实时核验集

- 运行 2026-11-06T09:34:46.169Z · 事实取数 2026-11-06T09:34:21.487Z · iFinD 网络调用 9 次 / 缓存命中 0 次 / 错误 0
- 结果：通过 4 / 失败 7 / 待核验 0；与金标完全一致 11/11

| 案例 | 意图 | 判定 | 自动识别 | 金标 |
|---|---|---|---|---|
| LIVE-01 | quote | pass | 无 | 无 |
| LIVE-02 | quote | fail | 数据过期 | 数据过期 |
| LIVE-03 | quote | fail | 数字错误 | 数字错误 |
| LIVE-04 | financial | pass | 无 | 无 |
| LIVE-05 | financial | fail | 单位错误 | 单位错误 |
| LIVE-06 | financial | fail | 口径缺失 | 口径缺失 |
| LIVE-07 | stock_view | pass | 无 | 无 |
| LIVE-08 | stock_view | fail | 缺风险提示、收益承诺、适当性不匹配 | 缺风险提示、收益承诺、适当性不匹配 |
| LIVE-09 | fund | fail | 画像改写客观事实、适当性不匹配 | 画像改写客观事实、适当性不匹配 |
| LIVE-10 | fund | pass | 无 | 无 |
| LIVE-11 | fund | fail | 数字错误 | 数字错误 |

## 核验明细（claim → iFinD）

| 案例 | 指标 | 回答值 | iFinD 值 | 状态 | source_id |
|---|---|---|---|---|---|
| LIVE-01 | close | 1453 | 1453 | match | ifind:get_stock_performance#5e064746a247@2026-11-06T09:34:24 |
| LIVE-01 | pct_chg | 0.07 | 0.0689 | match | ifind:get_stock_performance#5e064746a247@2026-11-06T09:34:24 |
| LIVE-02 | close | 264.06 | 254.22 | stale | ifind:get_stock_performance#eafbf055d48d@2026-11-06T09:34:27 |
| LIVE-02 | pct_chg | 4.42 | -3.7264 | stale | ifind:get_stock_performance#eafbf055d48d@2026-11-06T09:34:27 |
| LIVE-03 | close | 12.52 | 11.81 | mismatch | ifind:get_stock_performance#ad93da1781ba@2026-11-06T09:34:30 |
| LIVE-03 | pct_chg | 1.46 | 1.4605 | match | ifind:get_stock_performance#ad93da1781ba@2026-11-06T09:34:30 |
| LIVE-04 | revenue | 1309.7 | 1309.7074 | match | ifind:get_stock_financials#b71ea28f018b@2026-11-06T09:34:34 |
| LIVE-04 | net_profit | 644.7 | 644.6743 | match | ifind:get_stock_financials#b71ea28f018b@2026-11-06T09:34:34 |
| LIVE-04 | np_yoy | -0.2 | -0.2465 | match | ifind:get_stock_financials#b71ea28f018b@2026-11-06T09:34:34 |
| LIVE-05 | revenue | 4421.4 | 4421.3742 | mismatch | ifind:get_stock_financials#6cbfe3756d5d@2026-11-06T09:34:39 |
| LIVE-05 | net_profit | 645.3 | 645.3006 | mismatch | ifind:get_stock_financials#6cbfe3756d5d@2026-11-06T09:34:39 |
| LIVE-05 | np_yoy | 31.6 | 31.6024 | match | ifind:get_stock_financials#6cbfe3756d5d@2026-11-06T09:34:39 |
| LIVE-06 | revenue | 1309.7 | 1309.7074 | match | ifind:get_stock_financials#a6f131e1dd4c@2026-11-06T09:34:41 |
| LIVE-06 | net_profit | 644.7 | 644.6743 | match | ifind:get_stock_financials#a6f131e1dd4c@2026-11-06T09:34:41 |
| LIVE-06 | np_yoy | -0.2 | -0.2465 | match | ifind:get_stock_financials#a6f131e1dd4c@2026-11-06T09:34:41 |
| LIVE-07 | close | 254.22 | 254.22 | match | ifind:get_stock_performance#eafbf055d48d@2026-11-06T09:34:27 |
| LIVE-07 | pct_chg | -3.73 | -3.7264 | match | ifind:get_stock_performance#eafbf055d48d@2026-11-06T09:34:27 |
| LIVE-07 | pe_ttm | 13.4 | 13.4136 | match | ifind:get_stock_performance#ea4bbd27f972@2026-11-06T09:34:43 |
| LIVE-08 | close | 1453 | 1453 | match | ifind:get_stock_performance#5e064746a247@2026-11-06T09:34:24 |
| LIVE-08 | pct_chg | 0.07 | 0.0689 | match | ifind:get_stock_performance#5e064746a247@2026-11-06T09:34:24 |
| LIVE-09 | risk_level | 1 | 3 | mismatch | ifind:get_fund_profile#fcbd50278402@2026-11-06T09:34:44 |
| LIVE-09 | nav | 1.4164 | 1.4164 | match | ifind:get_fund_market_performance#a747e2d26d3a@2026-11-06T09:34:46 |
| LIVE-09 | mgmt_fee | 1.2 | 1.2 | match | ifind:get_fund_profile#fcbd50278402@2026-11-06T09:34:44 |
| LIVE-10 | risk_level | 3 | 3 | match | ifind:get_fund_profile#fcbd50278402@2026-11-06T09:34:44 |
| LIVE-10 | nav | 1.4164 | 1.4164 | match | ifind:get_fund_market_performance#a747e2d26d3a@2026-11-06T09:34:46 |
| LIVE-10 | mgmt_fee | 1.2 | 1.2 | match | ifind:get_fund_profile#fcbd50278402@2026-11-06T09:34:44 |
| LIVE-11 | risk_level | 3 | 3 | match | ifind:get_fund_profile#fcbd50278402@2026-11-06T09:34:44 |
| LIVE-11 | nav | 1.4872 | 1.4164 | mismatch | ifind:get_fund_market_performance#a747e2d26d3a@2026-11-06T09:34:46 |
| LIVE-11 | mgmt_fee | 1.2 | 1.2 | match | ifind:get_fund_profile#fcbd50278402@2026-11-06T09:34:44 |

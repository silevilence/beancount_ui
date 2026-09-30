# MyBill 账本结构与近期记账模式

研究日期：2026-09-30。对象为 `silevilence/MyBill` 的 `master-1` 分支快照，固定提交 `6c09193b0858a37055e9fb530a547f8ccc4f73c9`。本文不记录真实金额、工资数额、姓名或具体资产账号；链接指向用户自己的原始账本。

## 方法与范围

从 `main.beancount` 开始，递归读取未注释的 `include`，按解析后的绝对路径去重，共覆盖 89 个文件。读取所有被包含文件的行首日期与交易标志，以 **2026-06-01 至 2026-08-31 的实际交易日期**截取，不以文件名限定月份；统计单位是一条交易指令，不是一条分录。计数包括分类文件中的收益、工资和话费，不把 `open`、`balance`、`pad` 等指令计作交易。入口及包含关系见 [S1]、[S2]、[S3]、[S4]。

这是可复查的**文本结构分析**，没有运行 Beancount loader 或 `bean-check`，没有确认完整账本通过语法、余额或会计校验。“被 include 覆盖”不等于“经 Beancount 验证有效”。9 月本地未同步记录不在快照中，不能据此推断其内容；2026 年索引只列出 1–8 月文件。[S4]

## 文件组织与写回约束

| 内容 | 当前位置与证据 | 实现建议（推断） |
| --- | --- | --- |
| 主入口 | `main.beancount` 设置本位展示币种并包含 `index.bean`；编辑器配置也指定此入口。[S1][S5] | 以此入口加载整本账，不另造数据库作为账本事实来源。 |
| 历史数据与账户 | 根索引包含 `gnucash/gnucash.beancount`、`gnucash/import.beancount`；前者有账户声明，后者有历史余额断言。[S2][S6][S7] | 历史目录默认保留，只读取账户与历史；日常写入不重排或重生成它。 |
| 普通交易 | `txs/index.bean` 包含各年度索引，2026 年索引再包含逐月文件。[S3][S4] | 第一版新普通交易按交易日期路由到 `txs/YYYY/MM.bean`；缺少月份或年份时补建文件及必要 include。编辑既有交易按原始文件定位。 |
| 专项交易 | 分类索引依次包含 `yuebao.bean`、`phone.bean`、`balance.bean`、`salary.bean`。[S8] | 收益、话费、断言、工资使用明确的业务类型路由；今日列表跨文件聚合。 |
| 工资标签作用域 | `salary.bean` 第 3 行开启 `pushtag #salary`，第 315 行关闭；近期工资位于作用域内。[S9] | 新工资插入关闭标签之前，不能直接追加到文件末尾；保留省略一侧金额的写法。 |

第一版可以固定这些路径和业务路由，但建议集中在一个布局适配模块中，让加载、查询、编辑表单和 Git 同步不直接拼接路径。将来替换布局规则时，不需要同时重写交易业务逻辑。此项为设计推断，依据是月文件与专项文件并存。[S3][S8]

## 近期数量

以下数量由上述方法对 [S10]–[S15] 直接计数得到。表内“月文件交易”按交易日期归属，包含实际存放在相邻月文件中的条目。

| 交易日期所属月份 | 月文件交易 | 余额宝收益 | 工资 | 专项话费 | 合计 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-06 | 83 | 30 | 1 | 0 | 114 |
| 2026-07 | 71 | 31 | 1 | 1 | 104 |
| 2026-08 | 93 | 29 | 1 | 1 | 124 |
| 合计 | 247 | 90 | 3 | 2 | **342** |

全部 342 条匹配到的交易标志均为 `*`，涉及 90 个交易日期。同一交易日期最多 9 条；这是交易日期密度，**不能证明实际录入时间或每次录入批次**。用户描述的“下班后集中补记、之后即时记录”应作为交互需求，不能从账本日期反推。[S10]–[S15]

月文件物理条目数则是 6 月文件 82、7 月文件 71、8 月文件 94。差异来自两条跨月份日期：`07.bean` 第 3 行写的是 6 月 2 日，`08.bean` 第 43 行写的是 7 月 30 日。不能默默改日期、迁移历史记录或按文件名展示月份。[S11][S12]

## 高频模式与功能建议

以下数量都是同一 6–8 月窗口的独立匹配结果，类别可能重叠，不能相加当总交易数。功能建议均为研究推断。

| 已观察的模式 | 直接证据 | 建议实现 |
| --- | --- | --- |
| 88VIP 每日红包 50 条，分月为 15、14、21；47 条记杂货，另有娱乐、餐费、衣服各 1 条。付款涉及信用卡 29、先用后付 16、花呗 4、资产账户 1 条。 | 三个月文件中的“88VIP每日红包”及分录；可见商品 `memo`、不同付款类型和娱乐例外。[S10][S11][S12][S16] | 常用模板预填商家和摘要，重点输入日期、实付金额、商品备注、付款账户；允许改分类。不能因摘要包含红包而自动生成返现收入，也不能假设所有订单使用同一种付款方式。 |
| 超市 67 条，分月为 24、21、22；其中 66 条摘要为食材，1 条为零食。带餐费分录的交易共 109 条，包含超市及外卖等。 | 三个月月文件；超市常见两分录，餐费也带商品备注。[S10][S11][S12][S17] | 首页提供超市、外卖/餐食快捷入口，复用近期商家、费用科目和付款账户；保存后保留日期并清空金额，方便连续补记多笔。 |
| 淘宝确认收货 10 条，分月为 2、2、6；从先用后付负债转到信用卡负债，部分一笔包含多个商品分录。 | 6 月 7 日、6 月 28 日及 8 月 23 日的多商品确认收货。[S18][S19][S20] | 明确分成购买与付款结算两个动作；支持批量结算及商品备注，避免确认收货时再次记费用。历史关联缺少订单 ID，不应仅凭金额或备注自动认定配对。 |
| 余额宝收益 90 条，使用固定资产与收益账户；6、7 月各天都有，8 月仅 29 条。 | 分类文件 8341–8699 行；8 月 18 日后直接到 20 日，文件末尾是 8 月 30 日。[S13][S21] | 今日收益单金额录入、连续日期补录、重复日期提示；允许明确确认后同日补记。缺日只提示，不能按昨天金额自动造账或自动补零。 |
| 工资每月 1 条，共 3 条，收入侧省略金额；话费专项 2 条。 | 工资与话费分类文件。[S14][S15] | 工资和话费独立模板、周期提醒、可改日期与金额；提醒不直接生成真实收入/支出。工资无需人工填两侧相反金额。 |
| 水电费 2 条，7 月使用热水费用科目，8 月使用杂项科目。 | 两条同摘要记录的费用科目不同。[S22][S23] | 水电模板默认最近一次选择，但科目可调整；不能把历史同名摘要强行统一成一个固定费用科目。 |
| 信用卡、花呗、白条、美团月付还款共 11 条，分月为 4、3、4；另有摘要为转账的 2 条。 | 三个月中“还款”“还花呗”“还白条”，及 8 月两笔资产间转账。[S10][S11][S12][S24] | 转账/还款表单选择来源和目标账户，展示负债减少方向，单独列于当日流水；不计作新增消费。 |
| 网络服务费用 19 条；游戏预算相关交易 19 条含额外权益分录。 | 三个月中 `Expenses:OnlineService` 和 `Equity:Budget:Game`；8 月首笔有四分录结构。[S10][S11][S12][S25] | 提供最近记录复制与高级分录入口；简单双分录表单不能覆盖并丢弃预算分录。 |

退款、返现与折扣需要区分。6–8 月文本未发现明确以“退款/返现/退货”命名的条目，但有 **2 条交易包含优惠券负费用分录**，以及 **1 条快递赔偿记为其他收入**。优惠券不是退款、赔偿不一定冲原消费；不能自动统一记成返现。[S26][S27][S28] 作为窗口外的历史佐证，2025 年 6 月存在外卖漏送退款，以负费用和花呗负债减少处理。[S29] 建议退款支持选原费用科目及收回渠道、可选关联原交易；折扣保留同一交易内的负费用分录；赔偿收入使用独立模板。历史缺乏稳定关联标识时，由用户确认关联。

## 必须显式处理的边界

1. **业务类型和费用科目不是一一对应。** 8 月月文件中的手机购买使用 `Expenses:Phone`，而话费分类文件也使用该科目；不能把所有 Phone 科目的交易都路由到 `phone.bean`。[S15][S30]
2. **金额和多分录需要保真。** 近期存在 JPY 交易、`@@` 总价换算、负费用优惠券、同账户多条带 `memo` 的分录，以及预算权益分录。简易表单以外的交易应完整展示并通过高级编辑处理，不应保存时降成两行。[S18][S25][S26][S31]
3. **零金额记录不能自动补成推测金额。** 8 月文件第 43–46 行的一笔 7 月订阅，费用和信用卡分录均为零金额，同时带有外币金额备注。文本不足以判断是占位记录还是刻意保留的写法，也不能据此宣称账本不平衡。接入时应生成完整校验基线，展示真实校验结果；对零金额给出可忽略的检查提示，禁止从备注自动推算并修改金额。[S32]
4. **缺日不等于漏记。** 余额宝中未见 8 月 19 日、31 日记录，快照近期交易末端在 8 月 30 日。需用户确认是否待补，不推断 9 月本地账本，也不补造收益。[S13][S21]
5. **原文位置与标签作用域必须保留。** 工资的标签块、分录级 `memo`、注释和省略金额都是当前账本写法；编辑应定位原条目并检测文件是否被外部改动，不应整本格式化重写。[S9][S16][S18]
6. **配置和历史兼容性仍需实施阶段验证。** 对快照全部 `.bean`/`.beancount` 文本的检索未发现 `plugin` 指令；编辑器设置仅指定入口，不能由此推断 Beancount 版本或机器环境依赖。根入口仍包含历史 GnuCash 文件，其中有中文账户、非 CNY 账户及余额断言，选定后端依赖版本后须对全入口验证。[S1][S2][S5][S6][S7]

## 可复核来源

所有链接锁定同一提交，防止分支更新后行号与结论漂移。表中汇总计数由整个指定行范围按“方法与范围”直接计算；单条链接用于支撑结构与边界。

[S1]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/main.beancount#L1-L3
[S2]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/index.bean#L1-L6
[S3]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/index.bean#L1-L11
[S4]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/index.bean#L1-L8
[S5]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/.vscode/settings.json#L1-L3
[S6]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/gnucash/gnucash.beancount#L1-L28
[S7]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/gnucash/import.beancount#L1-L16
[S8]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/category/index.bean#L1-L8
[S9]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/category/salary.bean#L3-L315
[S10]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/06.bean#L1-L406
[S11]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/07.bean#L1-L344
[S12]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/08.bean#L1-L465
[S13]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/category/yuebao.bean#L8341-L8699
[S14]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/category/salary.bean#L303-L315
[S15]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/category/phone.bean#L583-L591
[S16]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/08.bean#L109-L144
[S17]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/07.bean#L193-L203
[S18]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/06.bean#L105-L114
[S19]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/06.bean#L365-L378
[S20]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/08.bean#L324-L331
[S21]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/category/yuebao.bean#L8653-L8659
[S22]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/07.bean#L97-L99
[S23]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/08.bean#L165-L167
[S24]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/08.bean#L79-L94
[S25]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/08.bean#L3-L8
[S26]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/06.bean#L176-L183
[S27]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/08.bean#L48-L57
[S28]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/06.bean#L333-L336
[S29]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2025/06.bean#L433-L436
[S30]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/08.bean#L376-L378
[S31]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/06.bean#L172-L174
[S32]: https://github.com/silevilence/MyBill/blob/6c09193b0858a37055e9fb530a547f8ccc4f73c9/txs/2026/08.bean#L43-L46

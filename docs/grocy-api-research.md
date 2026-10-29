# Grocy API 联动可行性研究

调研日期：2026-10-19。本文保留接口核验依据与讨论过程；同日用户确认按讨论结果列入任务，正式实施范围、依赖与验收以 [ROADMAP 的 Grocy 联动与独立订单收货](../ROADMAP.md#grocy-联动与独立订单收货) 为准。

## 核验范围与版本

仅访问 Grocy 官方仓库与官方发布资料，没有访问用户 NAS 或写入任何 Grocy 数据。调研时官方 `releases/latest` 指向 **v4.7.1**；以下接口和源码以该固定标签为准。用户使用 Docker `latest` 定期更新，但镜像标签不能证明当前容器内应用的精确版本。接入时应调用 `GET /api/system/info` 获取 `grocy_version`，并验证实际版本的接口及权限。来源：[v4.7.1 发布页](https://github.com/grocy/grocy/releases/tag/v4.7.1)、[固定版本 OpenAPI](https://github.com/grocy/grocy/blob/v4.7.1/grocy.openapi.json)。

以下路径省略共同前缀 `/api`；子目录部署还需保留实例路径前缀。API Key 可通过 `GROCY-API-KEY` 请求头认证。建议由本项目后端发起请求，设置页面负责配置和连接测试，浏览器不直接持有 Grocy Key。后半句是本项目设计建议。来源：[OpenAPI 认证说明](https://github.com/grocy/grocy/blob/v4.7.1/grocy.openapi.json#L1-L15)。

## 官方接口覆盖

| 需求 | 已核实接口 | 说明 |
| --- | --- | --- |
| 产品管理 | `GET/POST /objects/products`；`GET/PUT/DELETE /objects/products/{id}` | 产品通过通用实体接口管理；需遵守产品字段、引用及权限约束 |
| 库存浏览 | `GET /stock`；`GET /stock/products/{productId}`；`GET /stock/products/{productId}/entries` | 库存汇总、产品详情和批次 |
| 收货入库 | `POST /stock/products/{productId}/add` | 使用 `transaction_type: purchase`；购买记录本身不必立即调用此接口 |
| 日常开封、消耗、转移 | `POST /stock/products/{productId}/open`、`/consume`、`/transfer` | 也有 `/inventory` 盘点；转移接口文档注明不支持启用皮重处理的产品 |
| 告警 | `GET /stock/volatile?due_soon_days=5` | 返回 `due_products`、`overdue_products`、`expired_products`、`missing_products` |
| 位置、单位等主数据 | `/objects/locations`、`/objects/quantity_units`、`/objects/quantity_unit_conversions`、`/objects/shopping_locations` | 可用通用实体接口管理相应主数据 |
| 入库记录查询与撤销 | `GET /stock/transactions/{transactionId}`；`POST /stock/transactions/{transactionId}/undo` | 另有 `/stock/bookings/{bookingId}` 及对应 `/undo` |

来源：[v4.7.1 OpenAPI 路径和实体定义](https://github.com/grocy/grocy/blob/v4.7.1/grocy.openapi.json)、[库存 API 实现](https://github.com/grocy/grocy/blob/v4.7.1/controllers/Api/StockApiController.php)、[通用实体 API 实现](https://github.com/grocy/grocy/blob/v4.7.1/controllers/Api/GenericEntityApiController.php)。这证明所列管理操作具备 API 基础，不代表复制 Grocy 全部页面功能只需少量界面工作。

## 数量、价格和日期

2026-10-20 复核：Grocy 采购页的“总价”是前端计算模式，`purchase.js` 在发送请求前将价格除以数量，再写入 `jsonData.price`。`AddProduct` 控制器仍仅读取 `price`，没有总价模式或总价参数。本项目继续接收用户分配的商品总金额、自动计算库存单价，再调用 Grocy；不能将总价直接传入 `price`。来源：[v4.7.1 采购页请求构造](https://github.com/grocy/grocy/blob/v4.7.1/public/viewjs/purchase.js#L25-L51)、[入库控制器](https://github.com/grocy/grocy/blob/v4.7.1/controllers/Api/StockApiController.php#L84-L168)。

库存页快速消耗和开封分别使用产品的 `quick_consume_amount`、`quick_open_amount`，二者均为库存单位数量；Grocy 模板另用 `_qu_consume` 字段展示消费单位。本项目库存表单已经使用库存单位，直接应用产品原字段，不再二次换算。Grocy 独立消耗页另有用户偏好，本项目按库存页产品设置预填。来源：[库存页默认数量](https://github.com/grocy/grocy/blob/v4.7.1/views/stockoverview.blade.php#L199-L233)、[库存页请求构造](https://github.com/grocy/grocy/blob/v4.7.1/public/viewjs/stockoverview.js#L128-L191)。

2026-10-29 复核自动消耗顺序：`ConsumeProduct` 按 `stock_next_use` 取批次，传入 `location_id` 时只消耗该位置；该视图先按默认消耗位置、再按开封状态降序、保质期和购买日期升序排列。因此在同一位置内，无需指定批次就会先消耗已开封库存，数量不足时继续消耗该位置后续批次。本项目默认来源位置改为当前有正数已开封库存的位置（多个候选沿用 Grocy 返回顺序），没有已开封库存时回退到有库存的产品默认位置或首个可操作位置；用户手选位置或批次后保留选择。来源：[v4.7.1 ConsumeProduct 与 GetProductStockEntriesForLocation](https://github.com/grocy/grocy/blob/v4.7.1/services/StockService.php)、[stock_next_use 排序定义](https://github.com/grocy/grocy/blob/v4.7.1/migrations/0200.sql)。

入库请求支持 `amount`、`price`、`best_before_date`、`location_id`、`shopping_location_id`、`note` 等。`price` 明确是 **Grocy 配置币种下，每库存单位的单价**。产品详情提供采购单位、库存单位以及采购到库存的换算系数，因此订单“2 箱、总计 120 元”不能直接提交为 `amount: 2, price: 120`；需要按产品的单位换算，再分摊到库存单位。不同币种、优惠及运费分摊规则需由本项目明确。来源：[OpenAPI 的 add 和 ProductDetailsResponse 定义](https://github.com/grocy/grocy/blob/v4.7.1/grocy.openapi.json)。

控制器实际还接受 `purchased_date`，默认当天；该字段未列在当前 add 的 OpenAPI 请求属性中。缺省保质期的实际服务逻辑会考虑产品默认天数及冷冻设置，不能只依赖 OpenAPI 中“默认当天”的简化描述。确认收货时最好提供明确的日期字段，接入测试应覆盖真实部署版本。来源：[AddProduct 控制器](https://github.com/grocy/grocy/blob/v4.7.1/controllers/Api/StockApiController.php#L84-L168)、[AddProduct 服务](https://github.com/grocy/grocy/blob/v4.7.1/services/StockService.php#L124-L190)。

## 结果关联、超时与重试

2026-10-21 复核开封自动转移：`OpenProduct` 在标记本次库存为已开封后，若产品 `move_on_open = 1` 且 `default_consume_location_id` 非空并不同于当前批次位置，会调用 `TransferProduct`，传入本次开封批次数量和同一个 transaction ID。部分开封会先拆出未开封余量，自动转移只影响已开封部分。因此 `/open` 的正常事务可能同时包含 `product-opened`、`transfer_from` 和 `transfer_to`，不能仅接受开封日志。本项目预览保存自动转移目标，提交前复核配置，结果核对同时验证来源、目标、批次及三类数量，不另外发送转移请求。来源：[v4.7.1 OpenProduct 与 TransferProduct](https://github.com/grocy/grocy/blob/v4.7.1/services/StockService.php)。

入库成功返回 `StockLogEntry[]`，包含日志 `id`、`stock_id`、`transaction_id` 等；一次请求可能返回多条日志。本项目应保存整个关联集合，不能假设只返回一个库存行。控制器将入库返回的 transaction ID 交给事务查询接口返回结果。来源：[OpenAPI 的 StockLogEntry](https://github.com/grocy/grocy/blob/v4.7.1/grocy.openapi.json)、[库存控制器](https://github.com/grocy/grocy/blob/v4.7.1/controllers/Api/StockApiController.php)。

**唯一操作 ID 可以放进 purchase 的 `note`，但它不是服务端幂等键。** v4.7.1 的 AddProduct 将该 note 同时写入 `stock_log` 和 `stock`；transaction ID 则由服务端生成，API 控制器没有接受客户端 transaction ID 的处理。未发现 add 提供原生幂等键或按 note 去重。重复 POST 可能再次入库。来源：[AddProduct 的 note 写入及 transaction ID 生成](https://github.com/grocy/grocy/blob/v4.7.1/services/StockService.php#L184-L279)、[控制器参数解析](https://github.com/grocy/grocy/blob/v4.7.1/controllers/Api/StockApiController.php#L84-L168)。

`stock_log` 是可列出的通用实体，但禁止通过通用接口直接修改和删除；`GET /objects/stock_log` 支持 `query[]` 过滤。因此可在 note 中保存固定格式的收货操作 UUID，结果未知时按例如 `query[]=note=beancount-ui-receipt:<uuid>` 查询日志，并核对产品、数量、事务类型和撤销状态。实际请求必须正确 URL 编码；如果 note 还承载自由文本，应设计可解析格式或采用受控匹配。来源：[实体开放和查询参数定义](https://github.com/grocy/grocy/blob/v4.7.1/grocy.openapi.json)、[GetObjects 调用 QueryData](https://github.com/grocy/grocy/blob/v4.7.1/controllers/Api/GenericEntityApiController.php#L206-L245)。

上述查询机制可辅助对账，但“尚未查到”不能证明此前请求最终不会成功，也不能自动排除并发重复请求。因此建议本地先持久化操作 ID 和状态，对同一收货操作加锁，成功后保存远端 ID；请求超时进入“结果待确认”，先对账再决定是否重试。以上为基于接口行为的设计建议，尚未进行真实实例故障测试。

撤销接口可用于补偿，但不是跨 Beancount/Grocy 的原子事务。源码会拒绝已撤销/不存在的日志或事务，部分情况需要相关库存行仍存在；后续消耗、转移、编辑发生后不能承诺无条件回滚。实施阶段需核对实际版本及后续库存变化，再设计撤销收货/退货流程。来源：[UndoBooking 与 UndoTransaction](https://github.com/grocy/grocy/blob/v4.7.1/services/StockService.php)。

### 讨论补充：以日志为主、当前状态为辅的恢复判定

2026-10-19 用户提出：同步失败后重新拉取 Grocy 当前状态和操作日志，与期望结果对比后再决定是否重发。建议采用此方案，并明确以下判定边界：

1. 发出请求前持久保存唯一操作 ID 和不可变的请求内容；ID 对应一次商品/收货批次的入库操作，而非笼统的整个订单。同一操作重试沿用 ID，本地同一操作只能有一个发送者。
2. 超时或异常后进入核对流程，优先通过 note 中的操作 ID 查询 stock_log，再按 transaction_id 获取完整日志，核对商品、动作、数量合计及价格、位置等相关字段。一次正常请求可能有多条日志，不能仅凭日志条数判断重复。
3. 若完整日志和批次/后续操作能够解释本次入库结果，则补记本地成功结果，不重发。即使随后已经消耗或转移，也不能因当前库存低于最初期望值就补入库存。
4. 当前库存总量只作辅助：原库存 5、本次 +3、随后消耗 2 会得到 6，但原入库仍成功；另一次无关采购也可能恰好使库存变成 8，因此数量吻合不能证明本次成功。
5. 日志缺失、查询失败、仅有部分数量、同一操作 ID 对应多个独立事务、日志与库存无法解释地冲突，或入库已被撤销时，保持待确认或冲突状态，不自动整笔重发，也不直接按余额差值补库存。撤销是后续业务事件，不自动视为需要重做。
6. “没有查到日志”并不证明原请求结束。原请求可能仍在执行，稍后才写入。可以退避复查；等待若干秒或多次查无记录本身仍不构成安全重发的证明。只有确定没有送达/没有产生写入且原执行不会继续等有依据的情形才自动重试；其余提供人工核对入口。
7. 不把所有 HTTP 错误当作未执行：控制器会统一捕获 AddProduct 的异常，而服务依次写日志、库存并可能执行其他后续动作。核查到的接口不能提供“任意失败均无副作用”的承诺。完整故障注入及实际部署验证仍应纳入实施验收。

相关依据：[AddProduct 控制器](https://github.com/grocy/grocy/blob/v4.7.1/controllers/Api/StockApiController.php#L84-L168)、[AddProduct 服务](https://github.com/grocy/grocy/blob/v4.7.1/services/StockService.php)、[通用实体查询及日志结构](https://github.com/grocy/grocy/blob/v4.7.1/grocy.openapi.json)。以上恢复规则是设计建议，不等同于 Grocy 自带幂等保证。

## 告警与待收货

Grocy 提供现有库存和最低库存相关告警；本项目可以在告警旁显示“已下单、待收货”的本地数量并跳转预填购买记录。只要下单时不调用入库接口，Grocy 库存就不会因下单增加，告警仍按照真实库存保持。此处“在途数量”和跳转预填是本项目需要实现的业务逻辑，不是已核实的 Grocy 订单接口。来源：[volatile API 和 missing_products](https://github.com/grocy/grocy/blob/v4.7.1/grocy.openapi.json)、[GetMissingProducts 及 AddProduct](https://github.com/grocy/grocy/blob/v4.7.1/services/StockService.php)。

## 尚待实施时核实

- NAS 中实际 Grocy 版本、镜像提供方、子路径和两个容器间的网络连通方式。
- API Key 对应用户能否执行入库、消耗、转移、产品主数据编辑和撤销。
- 产品的单位、皮重、默认日期及价格币种设置；先采用哪些常规产品场景。
- 部分收货、不同批次保质期、取消、退货以及收货后修改价格的具体业务规则。
- 网络超时、Grocy 成功但本项目未记录结果、重复点击、并发操作和重启后的恢复行为。

## 本项目现状与建议边界

以下是依据当前工作区代码提出的方案；已确认的工作范围已列入 ROADMAP，接口限制仍需结合实际部署验证。

- 当前 `backend/beancount_ui/orders.py` 的 `order_raw()` 将 `settle` 显示为“确认收货结算”，实际只做待付款负债到付款账户的结转。直接付款订单不能使用该结算路径，系统也没有独立的商品数量和收货记录。`models.py` 的 `OrderInput` 要求金额大于零，因此不能将现有结算接口简单当成零元收货接口。
- 建议分开维护付款状态、收货状态、Grocy 同步状态。先用后付可在一个页面确认收货并结算，但两个动作分别记结果；直接付款订单收货只保存收货记录并入库，无需制造零金额转账。非关联商品继续使用普通记账流程。
- 账务事实仍由 Beancount 保存，库存事实由 Grocy 保存；订单商品关联、分批收货记录和远端操作结果由本项目持久保存。现有 `writer.py` 已有 state 目录 SQLite 请求日志和恢复机制，可参考其设计，但现有本地写入保证不能直接扩展成跨 Grocy 的原子事务。
- 新增关联与收货数据属于需要备份的业务数据。账本 Git 备份不能代替 state 与 Grocy 数据备份；恢复后须核对外部操作，不能重放全部历史入库。
- 新建订单已有 `order-id`，可作为稳定关联基础；历史候选可能退回使用 `query.py` 中按文件名及原文生成的 hash ID，该 ID 随编辑变化。历史消费应经明确认领后建立稳定标识，关联商品行也需独立 ID，不能长期依赖文件行号、备注或数组位置。
- 商品关联按订单商品行维护，支持同一订单多商品，避免强制“一条费用分录等于一个 Grocy 产品”。建议保留产品 ID、名称/单位快照、采购数量、库存单位换算、分配金额，以及每次实收数量、位置、保质期、同步状态和远端日志集合。
- 收货数量与结算金额独立，部分收货按实收数量入库。退款和退货也须区分：仅退款、差价返还不能自动扣库存；实际退货单独确认，已发生消耗时不能假定原入库可直接撤销。
- 设置页可归并现有布局/模板、备份/同步设置，并新增 Grocy 连接和默认入库选项。部署目录、监听及认证基础配置保留部署层管理。API Key 在后端保存、不回显完整值、不进入账本 Git 或浏览器持久存储；连接测试由后端完成。
- 管理页建议首版覆盖库存/批次、产品及必要的单位/位置维护、开封、消耗、转移和手动入库。菜谱、家务等 Grocy 其他领域不默认纳入。库存状态刷新自 Grocy，不建立另一个独立库存余额源。
- 告警点击预填新的购买记录；展示实际库存和已下单未收货数量，但不以在途数量消除缺货告警。只有保存的有效订单计入在途，草稿不计入；部分收货、取消后重新计算，Grocy 不可用时标注告警数据过期。临期/过期提示应与补货告警区分。
- 部署通信建议为浏览器 → 本项目后端 → Grocy API。若两个容器共享 Docker 网络，可用服务名和容器端口；否则配置后端可达的 NAS 地址。用户电脑不在 NAS 局域网并不阻止上述服务器间通信，但真实网络尚未验证。

建议按“设置与只读库存/告警 → 购买关联与独立收货及可靠同步 → 日常库存管理与边界完善”渐进实现；各阶段均需明确验收后再进入后续阶段。

## 独立订单与收货页面

2026-10-19 讨论确认：将收货从补记工作台提取到独立「订单与收货」页面。购买仍可从记一笔／补记录入；订单页默认展示待收货订单，支持部分收货、已收货、取消及同步异常筛选，分别展示付款、收货和同步状态。详情包含原购买、商品关联、收货历史及付款退款记录。

确认收货按实物实际收到的日期和数量操作，关联 Grocy 的商品确认入库位置、保质期和价格；未关联商品也可记录收货。待付款订单可同时结算，也可只收货后付款；已经付款的订单不生成零金额转账。结算、收货和库存操作分别显示结果，并分别恢复失败部分。

原补记中的订单结算／退款入口迁入订单页，保留快捷跳转以及旧草稿兼容；库存管理页负责现有库存、开封、消耗与转移，设置页负责配置。

本次已更新 ROADMAP 计划和本研究笔记，没有修改实现代码，也未对真实 Grocy 执行请求。

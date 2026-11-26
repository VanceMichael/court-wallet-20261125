# 协助执行资金控制服务：接口与运行说明

本服务面向平台法务、支付运营、客服三类角色，处理演练合同约定的虚构资金，不对真实案件作法律判断。
所有数据为合成资料，金额单位均为整数分（`Minor` 字段），币种 CNY。

## 1. 角色与身份

每个请求通过请求头 `x-actor-id` 传递操作人，服务端按其角色授权，并在审计日志记录操作人与业务原因。

| 身份 | 角色 | 能做什么 |
| --- | --- | --- |
| `legal-a` / `legal-b` | 法务 legal | 查控/调整/顺位/解除的复核、代收归属确认、控制后退款决定复核、全部追溯视图 |
| `cashier` | 支付运营 payments | 入账、发起查控等申请、发起划付批次、查询/同步收单方、账户与案件视图 |
| `support-a` | 客服 support | 仅对自己服务的订单（`actors.orderScope`）提退款、查订单与退款，看不到账户账单明细 |

硬约束：

- 查控、金额调整、顺位变更、解除、控制后退款决定，都必须“申请 → 另一法务复核”。
- **申请人不能复核自己的申请**；非法务不能复核。
- 所有写接口都要求请求体带非空 `reason`（业务原因），否则 400。
- 未带 `x-actor-id` 或身份不存在返回 401；越权返回 403。

## 2. 启动

无第三方 npm 依赖，Node.js 22.23.4。

```bash
npm ci --ignore-scripts
npm run build
npm test          # 22 项检查
npm start         # 业务服务，默认 4318，并内置拉起本地收单方 4317
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 4318 | 业务服务端口 |
| `APP_STATE` | `.local/app-state.json` | 业务服务持久化文件（原子写入） |
| `PEER_URL` | 无 | 外部收单方地址；不设则由本进程内置拉起收单方 |
| `PEER_PORT` | 4317 | 内置收单方端口 |
| `PEER_STATE` | `.local/partner.json` | 收单方独立持久化文件 |
| `PEER_TIMEOUT_MS` | 1500 | 调用收单方超时；超时一律视为“受理结果未明” |

业务服务与收单方各自独立持久化、可分别重启；用同一状态文件重启会保留全部流水与未明锁定。

Docker：

```bash
docker build -t court-wallet:local .
docker run --rm -p 4318:4318 -p 4317:4317 -v "$PWD/.local:/app/.local" court-wallet:local
```

## 3. 资金模型（恒等式）

每个账户实时计算，且每次写事务提交前强制校验：

```
到账 received = 可用 free + 预留 reserved + 锁定 locked
```

- **预留 reserved**：控制生效前已确认退款（最优先）、各有效案件按 `rank` 顺位的控制占用、控制后经法务允许的退款。
- **锁定 locked**：已发起且处于 `created/unknown/accepted/pending` 的划付指令金额。终态失败（`rejected`）不锁钱。
- **可用 free**：满足全部退款与有效案件控制后，剩余才是商家可提现额。

顺位规则：控制前退款 → 案件 rank 升序 → 控制后退款（先用可分配资金，不足部分从顺位最后的有效案件已控资金让位）→ 商家可提现。
案件剩余可执行额 = 控制总额 − 已在途/受理/终态成功的本案件划付。两个案件争抢同一笔收入时按顺位切分，**绝不各自承诺全部金额**。

## 4. 接口清单

### 主体、账户、归属

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/merchants` | 法务/运营 | 新建主体（同名不合并，仅按 id 关联） |
| GET | `/merchants` | 法务/运营 | 主体列表 |
| POST | `/accounts` | 法务/运营 | 新建收款账户，自有账户可 `confirmed:true` |
| GET | `/accounts` | 法务/运营 | 全部账户资金视图（到账/占用/待定/可用/分配明细） |
| GET | `/accounts/:id` | 法务/运营 | 单账户视图加账单流水 |
| POST | `/relations` | 法务 | 登记代收归属线索（默认 unconfirmed，不授权） |
| GET | `/relations` | 法务/运营 | 归属线索列表 |
| POST | `/relations/:id/confirm` | 法务 | 代收归属确认；确认后自动激活落在该账户的待定控制 |

### 案件、文书、申请-复核

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/cases` | 法务/运营 | 登记案件（指定主体，同名商户不能替代） |
| GET | `/cases` | 法务/运营 | 案件追溯视图列表 |
| GET | `/cases/:id` | 法务/运营 | 文书版本、控制范围、实际控制、划付、剩余可执行额 |
| POST | `/cases/:id/control-applications` | 法务/运营 | 查控申请；未确认账户形成 `pending_relation` 待定范围 |
| POST | `/cases/:id/adjust-applications` | 法务/运营 | 控制金额调整（不改写已完成划款，只重算未支付额） |
| POST | `/cases/:id/rank-applications` | 法务/运营 | 顺位变更申请 |
| POST | `/cases/:id/release-applications` | 法务/运营 | 解除申请，支持整案或按账户部分金额解除 |
| GET | `/cases/:id/applications` | 法务/运营 | 该案件全部申请 |
| POST | `/applications/review` | 法务 | 复核 `{caseId, applicationId, decision: approve/reject}` |
| GET | `/applications?status=pending` | 法务/运营 | 全部申请 |

解除的可用额先让位给仍有效的后顺位案件，满足后才进入商家可提现，不会直接变成可提现额。

### 订单、收入、退款

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/orders` | 法务/运营 | 登记订单并原子入账 |
| POST | `/incomes` | 法务/运营 | 单独入账 |
| GET | `/incomes` | 法务/运营 | 收入流水 |
| GET | `/orders/:id` | 全部（客服限本服务订单、隐藏账户字段） | 订单追溯：收款、退款审核与结果、可退余额 |
| POST | `/refunds` | 全部 | 提退款；控制前 `reserved` 优先保留，控制后 `legal_pending` 待法务 |
| GET | `/refunds` | 全部（客服按订单范围过滤） | 退款列表 |
| POST | `/refund-decision-applications` | 全部 | 控制后退款是否允许从已控资金支出的申请 |
| POST | `/refund-decision-applications/review` | 法务 | 退款决定复核（申请人不可自审） |

退款只占用原订单可退余额；同订单已有在途退款时重复提交返回 409，改写订单号不能绕开法务决定。

### 付款批次与指令（对接本地收单方）

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/payment-batches` | 运营/法务 | 提交一批 1–100 条指令，支持幂等键与批次部分受理 |
| GET | `/payment-batches` | 法务/运营 | 批次列表 |
| GET | `/payment-batches/:id` | 法务/运营 | 批次及逐项指令 |
| GET | `/instructions` | 法务/运营 | 全部指令 |
| GET | `/instructions/:id` | 法务/运营 | 单指令含事件流 |
| POST | `/instructions/:id/sync` | 运营/法务 | 按业务流水查询收单方并回写 |
| POST | `/instructions/:id/receipt` | 运营/法务 | 登记外部回执；重复回执被标记不重复入账 |
| GET | `/payments/overview` | 法务/运营 | 批次与指令总览 |
| GET | `/audit` | 全部（客服仅见本订单相关） | 全量操作审计 |

指令状态机：`created → unknown/accepted/pending → confirmed/returned/rejected`。

- 收单方超时或断线：指令置 `unknown`，**资金保持锁定**，查询未明期间不释放、不另建新付款。
- 收单方返回 404 只表示“当前未查到”，不等于未受理，仍保持锁定。
- 案件划款已受理/在途后，若退款因此无法被当前资金足额覆盖，退款划付被拒绝，同一金额不会再退给消费者。
- `confirmed`/`returned`/`rejected` 分别回写到案件、退款（订单）与账户；重复回执标记 `duplicateReceipt` 且只计一次。

## 5. 本地验证三类资金安全场景

```bash
npm run test:race     # 竞争申请：并发控制/划付/退款/复核，资金不重复使用
npm run test:release  # 范围解除、顺位让位、归属确认、较早文书补录、控制后退款
npm run test:unknown  # 付款未明：断线/404/部分受理/重复回执/两端重启，资金不重复使用
npm run test:authz    # 角色权限、客服数据边界、同名主体、恒等式、审计留痕
npm run test:window   # 文书生效区间：到期失效让位、未到生效时间不控制
```

关键检查点：

1. 两案件同时要求控制新收入，先顺位足额、后顺位只拿剩余，账户恒等式始终成立。
2. 同一案件并发两笔划付只成立一笔；客服并发重复退款只成立一笔。
3. 部分解除的金额先补足后顺位案件，不直接进入商家可提现。
4. 收单方断线后指令 `unknown`、资金锁定，重启业务服务后状态与锁定保留，查询恢复后再同步。
5. 批次部分受理时拒绝项释放资金、受理项锁定；重复回执不重复入账。

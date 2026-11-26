# 网店协助执行中的限额控制与待定划款

本仓库保存该业务的合成登记资料、原始变更资料、本地收单方的本地协议服务，以及平台侧协助执行资金控制服务。所有机构、人员、金额和文书均为虚构，不连接真实业务系统，也不对真实案件作法律判断。

## 运行环境

使用 Node.js 22.23.4。没有第三方 npm 依赖，package-lock.json 锁定当前依赖清单。

```bash
npm ci --ignore-scripts
npm run build
npm test
npm start            # 业务服务（默认 4318），自动内置拉起本地收单方（默认 4317）
```

业务服务通过请求头 `x-actor-id` 识别操作人（`legal-a`/`legal-b`/`cashier`/`support-a`），所有写操作要求请求体携带业务原因 `reason`。接口、角色权限、资金恒等式与本地验证步骤见 [docs/api.md](docs/api.md)。

合作方默认监听 4317 端口，GET /health 可查询存活状态。PORT 可更换端口，PARTNER_STATE 可指定持久状态文件，默认 .local/partner.json。停止进程后用同一状态文件启动会保留合作方流水。业务服务状态默认写入 .local/app-state.json，可用 APP_STATE 更换；业务服务与收单方各自独立持久化、可分别重启。

也可以使用 Docker 启动：

```bash
docker build -t court-wallet:local .
docker run --rm -p 4318:4318 -p 4317:4317 -v "$PWD/.local:/app/.local" court-wallet:local
```

容器要保留状态时，将可写目录挂载到 /app/.local；该目录需允许容器 node 用户写入。测试使用临时目录与随机本地端口，可独立运行。

## 本地验证的三类资金安全检查

```bash
npm run test:race     # 竞争申请：并发控制/划付/退款/复核，资金不重复使用
npm run test:release  # 范围解除、顺位让位、归属确认、较早文书补录、控制后退款
npm run test:unknown  # 付款未明相遇：断线/404/部分受理/重复回执/两端重启
npm run test:authz    # 角色权限、客服数据边界、同名主体、恒等式、审计留痕
npm run test:window   # 文书生效区间：到期失效让位、未到生效时间不控制
```

## 资料

fixtures/records.json 是业务原始资料，sourceChanges 保存后续收到的变更或申请，均没有自动导入成已批准决定。fixtures/relations.json 声明登记资料的关联字段，docs/data.md 解释计量和身份语义。fixtures/partner.json 定义合作方接口名称及字段。support/peer.mjs 提供合作方行为，docs/partner.md 是实际协议；src/ 是平台侧业务服务，docs/api.md 是其接口与运行说明；tests 检查合作方协议、资料关系与业务资金规则。

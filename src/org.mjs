// 主体、收款账户与代收归属确认。
// 同名商户不等于同一主体：所有关联仅按 id 建立，禁止按名称合并。
import { conflict, notFound, requireFields, unprocessable } from './errors.mjs';

export function createMerchant(state, body) {
  requireFields(body, ['id', 'name']);
  if (state.merchants[body.id]) throw conflict(`商户 ${body.id} 已存在`);
  state.merchants[body.id] = {
    id: body.id,
    name: String(body.name),
    createdAt: new Date().toISOString(),
  };
  return state.merchants[body.id];
}

export function createAccount(state, body) {
  requireFields(body, ['id', 'ownerMerchantId']);
  if (state.accounts[body.id]) throw conflict(`账户 ${body.id} 已存在`);
  if (!state.merchants[body.ownerMerchantId]) throw unprocessable('归属商户不存在，同名不能替代主体核验');
  state.accounts[body.id] = {
    id: body.id,
    ownerMerchantId: body.ownerMerchantId,
    currency: body.currency ?? 'CNY',
    confirmed: body.confirmed === true, // 自有账户登记时可直接确认；代收关系必须另行走归属确认
    createdAt: new Date().toISOString(),
  };
  return state.accounts[body.id];
}

// 代收账户归属确认（法务专属，直接生效并留痕；账户关系后确认时在此激活待定控制）。
export function confirmRelation(store, actor, body) {
  requireFields(body, ['relationId']);
  return store.mutate(actor.id, 'relation.confirm', body.relationId, body.reason, (state) => {
    const relation = state.relations[body.relationId];
    if (!relation) throw notFound('归属线索不存在');
    if (relation.status === 'confirmed') throw conflict('该代收关系已确认，不能重复确认');
    const account = state.accounts[relation.accountId];
    if (!account) throw unprocessable('关系指向的账户不存在');
    relation.status = 'confirmed';
    relation.confirmedAt = new Date().toISOString();
    relation.confirmedBy = actor.id;
    // 文书可能先到而账户关系后确认：确认后激活落在该账户上的待定控制范围。
    const activated = [];
    for (const case_ of Object.values(state.cases)) {
      for (const scope of case_.scopes) {
        if (scope.accountId === account.id && scope.status === 'pending_relation') {
          scope.status = 'active';
          scope.relationActivatedAt = relation.confirmedAt;
          activated.push({ caseId: case_.id, accountId: account.id });
        }
      }
    }
    return { relation, activated };
  });
}

export function createRelation(state, body) {
  requireFields(body, ['id', 'accountId', 'merchantId']);
  if (state.relations[body.id]) throw conflict(`归属线索 ${body.id} 已存在`);
  if (!state.accounts[body.accountId]) throw unprocessable('账户不存在');
  if (!state.merchants[body.merchantId]) throw unprocessable('商户不存在');
  state.relations[body.id] = {
    id: body.id,
    accountId: body.accountId,
    merchantId: body.merchantId,
    status: 'unconfirmed',
    validFrom: body.validFrom ?? new Date().toISOString(),
    confirmedAt: null,
    confirmedBy: null,
  };
  return state.relations[body.id];
}

export function listRelations(state) {
  return Object.values(state.relations).sort((a, b) => a.id.localeCompare(b.id));
}

// 账户视图由分配引擎计算，保证到账/占用/待定/可用同源。
export function accountView(allocation, state, accountId) {
  const view = allocation.computeAccountView(state, accountId);
  if (!view) throw notFound('账户不存在');
  const ledger = Object.values(state.incomes)
    .filter(item => item.accountId === accountId)
    .flatMap(income => [{ type: 'income', id: income.id, amountMinor: income.amountMinor, at: income.receivedAt }]);
  return { ...view, ledger };
}


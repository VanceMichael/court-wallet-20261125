// 演练资料种子：来源于 fixtures/records.json 的合成登记资料。
// 规则：文书存在不等于批准；relations 的未确认记录只提供线索，不授予控制权。
// 种子只建立登记事实，不预置任何已批准控制，控制须经申请-复核流程形成。
import records from '../fixtures/records.json' with { type: 'json' };

export function seedState(state) {
  for (const actor of records.actors) {
    state.actors[actor.id] = {
      id: actor.id,
      role: actor.role,
      name: `演练${actor.role === 'legal' ? '法务' : actor.role === 'payments' ? '支付运营' : '客服'}-${actor.id}`,
      orderScope: actor.orders ? [...actor.orders] : [],
    };
  }
  for (const merchant of records.merchants) {
    state.merchants[merchant.id] = { id: merchant.id, name: merchant.name, createdAt: '2026-11-01T00:00:00Z' };
  }
  for (const account of records.accounts) {
    state.accounts[account.id] = {
      id: account.id,
      ownerMerchantId: account.owner,
      currency: account.currency,
      // W-A 是商户自有收款账户；W-AGENT 名义归属 M-B，对 M-A 的代收关系尚待确认。
      confirmed: account.id === 'W-A',
      createdAt: '2026-11-01T00:00:00Z',
    };
  }
  for (const relation of records.relations) {
    state.relations[relation.id] = {
      id: relation.id,
      accountId: relation.account,
      merchantId: relation.merchant,
      status: relation.status, // unconfirmed：线索，不授予控制权
      validFrom: relation.validFrom,
      confirmedAt: null,
      confirmedBy: null,
    };
  }
  for (const case_ of records.cases) {
    state.cases[case_.id] = {
      id: case_.id,
      merchantId: case_.merchant,
      rank: case_.rank,
      status: 'registered',
      createdAt: '2026-11-01T00:00:00Z',
      documents: [],
      // 文书尚未复核，不形成任何控制范围。
      scopes: [],
      suggestedAccounts: case_.accounts,
      suggestedLimitMinor: case_.limitMinor,
    };
  }
  for (const order of records.orders) {
    state.orders[order.id] = {
      id: order.id,
      merchantId: order.merchant,
      accountId: order.account,
      paidMinor: order.paidMinor,
      createdAt: '2026-11-24T00:00:00Z',
    };
  }
  for (const receipt of records.receipts) {
    state.incomes[receipt.id] = {
      id: receipt.id,
      orderId: receipt.order,
      accountId: state.orders[receipt.order].accountId,
      amountMinor: receipt.amountMinor,
      receivedAt: receipt.receivedAt,
      source: 'fixture',
    };
  }
  for (const request of records.refundRequests) {
    const order = state.orders[request.order];
    state.refunds[request.id] = {
      id: request.id,
      orderId: request.order,
      accountId: order.accountId,
      amountMinor: request.amountMinor,
      status: 'reserved',
      preControl: true, // 控制生效前已确认且尚未支付
      confirmedAt: request.confirmedAt,
      createdAt: request.confirmedAt,
      decidedAt: null,
      decidedBy: null,
      paymentInstructionId: null,
      decisionNote: '控制生效前已确认退款，优先保留',
    };
  }
  state.sourceChanges = records.sourceChanges.map(change => ({ ...change, imported: false }));
  return state;
}

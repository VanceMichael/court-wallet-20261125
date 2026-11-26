// 订单、收入入账与消费者退款。
// 退款按订单原收款关联核验，只占用原订单可退余额；
// 控制生效前确认的退款优先保留，控制生效后提出的退款须法务决定，客服不能靠重复提交/改写订单号绕行。
import { badRequest, conflict, forbidden, notFound, parseAmount, requireFields, unprocessable } from './errors.mjs';
import { isScopeActiveAt } from './allocation.mjs';

function getOrder(state, orderId) {
  const order = state.orders[orderId];
  if (!order) throw notFound(`订单 ${orderId} 不存在`);
  return order;
}

function accountHasActiveControl(state, accountId, at) {
  for (const case_ of Object.values(state.cases)) {
    const scope = case_.scopes.find(item => item.accountId === accountId);
    if (scope && isScopeActiveAt(scope, at)) return true;
  }
  return false;
}

// 登记订单并原子入账（同一事务完成，避免收入与订单状态不一致）。
export function postOrderIncome(store, actor, body) {
  requireFields(body, ['orderId', 'merchantId', 'accountId', 'paidMinor']);
  const paidMinor = parseAmount(body.paidMinor, '订单金额');
  return store.mutate(actor.id, 'order.create', body.orderId, body.reason, (state) => {
    if (state.orders[body.orderId]) throw conflict('订单号已存在，不能重复入账');
    if (!state.merchants[body.merchantId]) throw unprocessable('商户不存在');
    const account = state.accounts[body.accountId];
    if (!account) throw unprocessable('收款账户不存在');
    if (account.ownerMerchantId !== body.merchantId) {
      const relation = Object.values(state.relations).some(item =>
        item.accountId === body.accountId && item.merchantId === body.merchantId && item.status === 'confirmed');
      if (!relation) throw unprocessable('订单收款账户与商户归属未经确认');
    }
    const now = new Date().toISOString();
    state.orders[body.orderId] = {
      id: body.orderId,
      merchantId: body.merchantId,
      accountId: body.accountId,
      paidMinor,
      createdAt: now,
    };
    const incomeId = store.nextId('IN');
    state.incomes[incomeId] = {
      id: incomeId,
      orderId: body.orderId,
      accountId: body.accountId,
      amountMinor: paidMinor,
      receivedAt: body.receivedAt ?? now,
      source: 'order',
      createdBy: actor.id,
    };
    return { order: state.orders[body.orderId], income: state.incomes[incomeId] };
  });
}

// 单独登记收入（对账补录等场景）。
export function postIncome(store, actor, body) {
  requireFields(body, ['accountId', 'amountMinor']);
  const amountMinor = parseAmount(body.amountMinor, '入账金额');
  return store.mutate(actor.id, 'income.post', body.accountId, body.reason, (state) => {
    if (!state.accounts[body.accountId]) throw notFound('账户不存在');
    const id = store.nextId('IN');
    state.incomes[id] = {
      id,
      orderId: body.orderId ?? null,
      accountId: body.accountId,
      amountMinor,
      receivedAt: body.receivedAt ?? new Date().toISOString(),
      source: body.source ?? 'manual',
      createdBy: actor.id,
    };
    return state.incomes[id];
  });
}

function assertSupportOrderScope(actor, orderId) {
  if (actor.role === 'support' && !actor.orderScope.includes(orderId)) {
    throw forbidden('客服只能查询/操作自己服务的订单');
  }
}

// 提出消费者退款。
export function requestRefund(store, actor, body) {
  requireFields(body, ['orderId', 'amountMinor']);
  const amountMinor = parseAmount(body.amountMinor, '退款金额');
  assertSupportOrderScope(actor, body.orderId);
  return store.mutate(actor.id, 'refund.request', body.orderId, body.reason, (state) => {
    const order = getOrder(state, body.orderId);
    const account = state.accounts[order.accountId];
    // 退款只占用原订单可退余额。
    const openRefundMinor = Object.values(state.refunds)
      .filter(item => item.orderId === order.id && !['rejected', 'returned'].includes(item.status))
      .reduce((sum, item) => sum + item.amountMinor, 0);
    if (openRefundMinor + amountMinor > order.paidMinor) {
      throw unprocessable(`退款超过订单可退余额：可退 ${order.paidMinor - openRefundMinor} 分`);
    }
    // 客服不能通过重复提交或改写订单号绕开法务决定：同订单已有在途退款即拒绝重复。
    const duplicate = Object.values(state.refunds).find(item =>
      item.orderId === order.id && !['rejected', 'returned', 'completed'].includes(item.status));
    if (duplicate) throw conflict(`订单已有在途退款 ${duplicate.id}，不能重复提交`);

    const now = new Date().toISOString();
    const preControl = !accountHasActiveControl(state, order.accountId, now);
    const id = store.nextId('RF');
    const refund = {
      id,
      orderId: order.id,
      accountId: order.accountId,
      amountMinor,
      // 控制生效前确认且尚未支付：reserved 直接优先保留；控制生效后：等待法务决定。
      status: preControl ? 'reserved' : 'legal_pending',
      preControl,
      confirmedAt: body.confirmedAt ?? now,
      createdAt: now,
      decidedAt: null,
      decidedBy: null,
      paymentInstructionId: null,
      decisionNote: preControl ? '控制生效前确认，自动优先保留' : null,
      requestedBy: actor.id,
    };
    state.refunds[id] = refund;
    return refund;
  });
}

// 控制生效后退款的法务决定（走申请-复核流程，申请人不能复核自己的申请）。
export function applyRefundDecision(store, actor, body) {
  requireFields(body, ['refundId', 'allow']);
  return store.mutate(actor.id, 'application.create.refund_decision', body.refundId, body.reason, (state) => {
    const refund = state.refunds[body.refundId];
    if (!refund) throw notFound('退款不存在');
    if (refund.status !== 'legal_pending') throw conflict('该退款不处于待法务决定状态');
    const order = getOrder(state, refund.orderId);
    const applicationId = store.nextId('APP');
    const application = {
      id: applicationId,
      type: 'refund_decision',
      status: 'pending',
      applicantId: actor.id,
      reviewerId: null,
      reviewNote: null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      payload: {
        caseId: null, // 退款申请挂在虚拟桶，统一在 refunds 索引下复核
        refundId: refund.id,
        orderId: order.id,
        allow: body.allow === true,
        note: body.note ?? null,
        reason: body.reason,
      },
    };
    state.refundApplications ??= {};
    state.refundApplications[applicationId] = application;
    refund.applicationId = applicationId;
    return application;
  });
}

export function reviewRefundDecision(store, actor, body) {
  requireFields(body, ['applicationId', 'decision']);
  if (!['approve', 'reject'].includes(body.decision)) throw badRequest('decision 必须是 approve 或 reject');
  return store.mutate(actor.id, `application.refund_decision.${body.decision}`, body.applicationId, body.reason, (state) => {
    const application = state.refundApplications?.[body.applicationId];
    if (!application) throw notFound('退款决定申请不存在');
    if (application.status !== 'pending') throw conflict('该申请已复核');
    if (actor.role !== 'legal') throw forbidden('只有法务可以复核退款决定');
    if (actor.id === application.applicantId) throw forbidden('申请人不能复核自己的申请');
    const refund = state.refunds[application.payload.refundId];
    if (!refund) throw notFound('退款已不存在');
    application.status = body.decision === 'approve' ? 'approved' : 'rejected';
    application.reviewerId = actor.id;
    application.reviewNote = body.note ?? null;
    application.decidedAt = new Date().toISOString();
    refund.decidedAt = application.decidedAt;
    refund.decidedBy = actor.id;
    refund.decisionNote = body.note ?? application.payload.note;
    const allow = body.decision === 'approve' && application.payload.allow;
    refund.status = allow ? 'allowed' : 'rejected';
    return { application, refund };
  });
}

// 客服视角：只能看到自己服务的订单（不含账户账单明细）。
export function supportOrderView(state, actor, orderId, computeOrderView) {
  assertSupportOrderScope(actor, orderId);
  const view = computeOrderView(state, orderId);
  if (!view) throw notFound('订单不存在');
  // 隐藏账户侧敏感字段，只返回订单与退款信息。
  const { accountId, ...safe } = view;
  return { ...safe, accountId: actor.role === 'support' ? undefined : accountId };
}

// 资金分配引擎（纯函数，只读状态、不修改）。
//
// 账户恒等式（每笔钱只能有一个去向）：
//   到账总额 received = 可用 free + 已预留(案件占用/退款预留) + 锁定(划付在途/受理)
// 案件恒等式：
//   控制上限 limit >= 本案件各账户占用之和；划付已受理/终态的金额永久扣减可执行额。
//
// 顺位规则（同一账户内）：
// 1) 控制生效前已确认且未支付的消费者退款（优先保留，占用原订单可退余额）；
// 2) 有效案件控制，按 rank 从小到大；
// 3) 控制生效后才提出、且经法务允许的退款：从顺位最后的有效案件已控资金中让位；
// 4) 剩余资金为商家可提现额（free）。
// 被解除的控制额先让位给仍有效的后顺位案件，满足后才进入 free。

export const REFUND_PAYABLE_STATUSES = new Set(['reserved', 'legal_pending', 'allowed']);
export const CASE_PAYABLE_STATUSES = new Set(['active', 'partial_released', 'released', 'expired']);
// 仍参与资金占用的控制范围状态。
export const ACTIVE_SCOPE_STATUSES = new Set(['active', 'partial_released']);
// 仍可发起划付的范围（解除后剩余额度仍可对未解除部分划付）。
export const INSTRUCTION_OPEN_STATUSES = new Set(['created', 'unknown', 'accepted', 'pending']);

const nowIso = () => new Date().toISOString();

export function isScopeActiveAt(scope, at = nowIso()) {
  if (!ACTIVE_SCOPE_STATUSES.has(scope.status)) return false;
  if (scope.effectiveFrom && at < scope.effectiveFrom) return false;
  if (scope.effectiveTo && at >= scope.effectiveTo) return false;
  return true;
}

// 汇总单个账户的全部资金视图。
export function computeAccountView(state, accountId, at = nowIso()) {
  const account = state.accounts[accountId];
  if (!account) return null;

  const incomes = Object.values(state.incomes).filter(item => item.accountId === accountId);
  const receivedMinor = incomes.reduce((sum, item) => sum + item.amountMinor, 0);

  // 本账户上的在途/已受理指令锁定金额（终态失败的指令不锁钱）。
  const instructions = Object.values(state.instructions).filter(item => item.accountId === accountId);
  const lockingInstructions = instructions.filter(item => INSTRUCTION_OPEN_STATUSES.has(item.status));
  const lockedMinor = lockingInstructions.reduce((sum, item) => sum + item.amountMinor, 0);

  // 退款预留（含在途退款指令对应预留，指令未终态前预留不消失）。
  const refunds = Object.values(state.refunds).filter(item => item.accountId === accountId);
  const refundClaimById = new Map();
  for (const refund of refunds) {
    if (refund.status === 'rejected' || refund.status === 'completed' || refund.status === 'returned') continue;
    if (!REFUND_PAYABLE_STATUSES.has(refund.status)) continue;
    refundClaimById.set(refund.id, {
      claimId: `refund:${refund.id}`,
      kind: 'refund',
      refundId: refund.id,
      orderId: refund.orderId,
      amountMinor: refund.amountMinor,
      preControl: refund.preControl === true,
      at: refund.createdAt,
    });
  }

  // 有效控制范围，按案件顺位排列。
  const activeScopes = [];
  const casesById = state.cases;
  for (const case_ of Object.values(casesById)) {
    const scope = case_.scopes.find(item => item.accountId === accountId);
    if (!scope || !isScopeActiveAt(scope, at)) continue;
    activeScopes.push({ case_: case_, scope });
  }
  activeScopes.sort((a, b) => (a.case_.rank - b.case_.rank) || a.case_.createdAt.localeCompare(b.case_.createdAt) || a.case_.id.localeCompare(b.case_.id));

  // 已锁定的案件指令，按指令所属案件归集（锁定额度先从池子里扣除，保证不重复使用）。
  const lockedByCase = new Map();
  for (const instruction of lockingInstructions) {
    if (instruction.kind === 'case') {
      lockedByCase.set(instruction.businessId, (lockedByCase.get(instruction.businessId) ?? 0) + instruction.amountMinor);
    }
  }

  // 案件剩余可执行额（跨账户）：控制上限 - 已在途/受理/终态成功的案件划付。
  const caseRemaining = (caseId) => {
    const limit = caseLimitMinor(state, caseId);
    const used = instructions
      .filter(item => item.kind === 'case' && item.businessId === caseId && item.status !== 'rejected')
      .reduce((sum, item) => sum + item.amountMinor, 0);
    return Math.max(0, limit - used);
  };

  // 案件占用申请，额度受账户剩余控制额与案件剩余可执行额双重约束。
  const caseClaims = activeScopes.map(({ case_, scope }) => {
    const accountLimit = scope.currentLimitMinor;
    const headroom = Math.min(accountLimit, caseRemaining(case_.id));
    return {
      claimId: `case:${case_.id}:${accountId}`,
      kind: 'case',
      caseId: case_.id,
      rank: case_.rank,
      amountMinor: Math.max(0, headroom),
      at: scope.approvedAt ?? scope.createdAt,
    };
  }).filter(claim => claim.amountMinor > 0);

  // 顺位最后且仍有占用的案件（控制生效后退款从其已控资金让位）。
  const tailCaseClaim = caseClaims.length ? caseClaims[caseClaims.length - 1] : null;

  const preRefunds = [...refundClaimById.values()]
    .filter(claim => claim.preControl)
    .sort((a, b) => a.at.localeCompare(b.at) || a.claimId.localeCompare(b.claimId));
  const postRefunds = [...refundClaimById.values()]
    .filter(claim => !claim.preControl)
    .sort((a, b) => a.at.localeCompare(b.at) || a.claimId.localeCompare(b.claimId));

  // 案件锁定指令优先占用（保证已受理资金不被再次分配），随后是控制前退款。
  const lockedCaseMinor = [...lockedByCase.values()].reduce((sum, value) => sum + value, 0);
  const lockedRefundMinor = lockingInstructions
    .filter(item => item.kind === 'refund')
    .reduce((sum, item) => sum + item.amountMinor, 0);

  let pool = receivedMinor - lockedMinor;
  if (pool < 0) pool = 0; // 异常数据由 invariant 检查兜底抛出
  const allocations = [];
  const allocate = (claim, requested, note) => {
    const amountMinor = Math.min(Math.max(0, requested), pool);
    if (amountMinor > 0) {
      allocations.push({ ...claim, amountMinor, note: note ?? claim.note });
      pool -= amountMinor;
    }
    return amountMinor;
  };

  for (const claim of preRefunds) {
    allocate(claim, claim.amountMinor, '控制生效前已确认退款优先保留');
  }

  const caseAllocationById = new Map();
  for (const claim of caseClaims) {
    const amountMinor = allocate(claim, claim.amountMinor, '案件顺位控制占用');
    caseAllocationById.set(claim.caseId, amountMinor);
  }

  // 控制生效后经法务允许的退款：先用剩余可分配资金；不足部分才从最后顺位案件的预留中让位。
  const clawbackFromCase = new Map();
  for (const claim of postRefunds) {
    let need = claim.amountMinor;
    const fromFree = Math.min(need, pool);
    if (fromFree > 0) {
      pool -= fromFree;
      need -= fromFree;
    }
    if (need > 0 && tailCaseClaim) {
      const tailAllocated = caseAllocationById.get(tailCaseClaim.caseId) ?? 0;
      const take = Math.min(tailAllocated, need);
      if (take > 0) {
        caseAllocationById.set(tailCaseClaim.caseId, tailAllocated - take);
        clawbackFromCase.set(tailCaseClaim.caseId, (clawbackFromCase.get(tailCaseClaim.caseId) ?? 0) + take);
        need -= take;
      }
    }
    const totalReserved = claim.amountMinor - need;
    if (totalReserved > 0) {
      const clawed = clawbackFromCase.get(tailCaseClaim?.caseId) ?? 0;
      allocations.push({
        ...claim,
        amountMinor: totalReserved,
        note: clawed > 0
          ? `控制后退款，自顺位最后案件 ${tailCaseClaim.caseId} 已控资金让位 ${clawed} 分`
          : '控制后退款自可分配资金预留',
      });
    }
  }

  // 重写案件分配结果（扣减让位部分）。
  for (let i = allocations.length - 1; i >= 0; i -= 1) {
    if (allocations[i].kind === 'case') allocations.splice(i, 1);
  }
  for (const claim of caseClaims) {
    const amountMinor = caseAllocationById.get(claim.caseId) ?? 0;
    if (amountMinor > 0) allocations.push({ ...claim, amountMinor, note: '案件顺位控制占用' });
  }

  const freeMinor = pool;
  const reservedMinor = allocations.reduce((sum, item) => sum + item.amountMinor, 0);

  return {
    accountId,
    currency: account.currency,
    ownerMerchantId: account.ownerMerchantId,
    confirmed: account.confirmed,
    receivedMinor,
    lockedMinor,
    lockedCaseMinor,
    lockedRefundMinor,
    reservedMinor,
    freeMinor,
    allocations: allocations.sort((a, b) => a.claimId.localeCompare(b.claimId)),
    postControlRefundClawback: [...clawbackFromCase.entries()].map(([caseId, amountMinor]) => ({ caseId, amountMinor })),
  };
}

// 案件控制总额（各账户当前控制额之和）。
export function caseLimitMinor(state, caseId) {
  const case_ = state.cases[caseId];
  if (!case_) return 0;
  return case_.scopes.reduce((sum, scope) => sum + scope.currentLimitMinor, 0);
}

// 案件完整追溯视图：文书版本、实际控制、划付与剩余可执行额。
export function computeCaseView(state, caseId, at = nowIso()) {
  const case_ = state.cases[caseId];
  if (!case_) return null;
  const instructions = Object.values(state.instructions)
    .filter(item => item.kind === 'case' && item.businessId === caseId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const disbursedMinor = instructions
    .filter(item => item.status === 'confirmed' || item.status === 'completed')
    .reduce((sum, item) => sum + item.amountMinor, 0);
  const inFlightMinor = instructions
    .filter(item => INSTRUCTION_OPEN_STATUSES.has(item.status) || item.status === 'accepted')
    .reduce((sum, item) => sum + item.amountMinor, 0);

  const accountViews = case_.scopes.map(scope => {
    const view = computeAccountView(state, scope.accountId, at);
    const allocation = view.allocations.find(item => item.kind === 'case' && item.caseId === caseId);
    const clawback = view.postControlRefundClawback.find(item => item.caseId === caseId);
    return {
      accountId: scope.accountId,
      scopeStatus: scope.status,
      scopeLimitMinor: scope.currentLimitMinor,
      originalLimitMinor: scope.limitMinor,
      effectiveFrom: scope.effectiveFrom,
      effectiveTo: scope.effectiveTo,
      currentlyHeldMinor: allocation?.amountMinor ?? 0,
      refundClawbackMinor: clawback?.amountMinor ?? 0,
      active: isScopeActiveAt(scope, at),
    };
  });

  const limit = caseLimitMinor(state, caseId);
  const usedMinor = instructions.filter(item => item.status !== 'rejected').reduce((sum, item) => sum + item.amountMinor, 0);
  return {
    caseId,
    merchantId: case_.merchantId,
    rank: case_.rank,
    status: case_.status,
    limitMinor: limit,
    disbursedMinor,
    inFlightMinor,
    remainingExecutableMinor: Math.max(0, limit - usedMinor),
    currentlyControlledMinor: accountViews.reduce((sum, item) => sum + item.currentlyHeldMinor, 0),
    documents: case_.documents,
    scopes: case_.scopes,
    accountViews,
    instructions,
    createdAt: case_.createdAt,
  };
}

// 订单追溯视图：收款、退款审核与结果。
export function computeOrderView(state, orderId) {
  const order = state.orders[orderId];
  if (!order) return null;
  const income = Object.values(state.incomes).find(item => item.orderId === orderId);
  const refunds = Object.values(state.refunds)
    .filter(item => item.orderId === orderId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const refundedMinor = refunds
    .filter(item => item.status === 'completed')
    .reduce((sum, item) => sum + item.amountMinor, 0);
  return {
    orderId,
    merchantId: order.merchantId,
    accountId: order.accountId,
    paidMinor: order.paidMinor,
    refundedMinor,
    refundableMinor: Math.max(0, order.paidMinor - refundedMinor),
    income: income ?? null,
    refunds,
  };
}

// 全量不变量检查；任何写事务提交后运行，违约直接抛错。
export function assertInvariants(state, at = nowIso()) {
  for (const accountId of Object.keys(state.accounts)) {
    const view = computeAccountView(state, accountId, at);
    const sum = view.freeMinor + view.reservedMinor + view.lockedMinor;
    if (sum !== view.receivedMinor) {
      throw new Error(`账户 ${accountId} 恒等式破裂：到账 ${view.receivedMinor} != 可用 ${view.freeMinor} + 预留 ${view.reservedMinor} + 锁定 ${view.lockedMinor}`);
    }
    if (view.freeMinor < 0 || view.reservedMinor < 0 || view.lockedMinor < 0) {
      throw new Error(`账户 ${accountId} 出现负金额`);
    }
    // 任一账户预留不得超过到账（两个案件不能各自承诺全部金额）。
    const claimTotal = new Map();
    for (const allocation of view.allocations) {
      claimTotal.set(allocation.claimId, (claimTotal.get(allocation.claimId) ?? 0) + allocation.amountMinor);
    }
    for (const [claimId, amount] of claimTotal) {
      if (amount > view.receivedMinor) throw new Error(`账户 ${accountId} 申请 ${claimId} 超额承诺`);
    }
  }

  for (const caseId of Object.keys(state.cases)) {
    const caseView = computeCaseView(state, caseId, at);
    if (caseView.remainingExecutableMinor < 0) {
      throw new Error(`案件 ${caseId} 划付超过控制总额`);
    }
  }

  // 退款只占用原订单可退余额。
  for (const orderId of Object.keys(state.orders)) {
    const orderView = computeOrderView(state, orderId);
    const openRefundMinor = orderView.refunds
      .filter(item => item.status !== 'rejected' && item.status !== 'returned')
      .reduce((sum, item) => sum + item.amountMinor, 0);
    if (openRefundMinor > orderView.paidMinor) {
      throw new Error(`订单 ${orderId} 退款超出原收款可退余额`);
    }
  }
}

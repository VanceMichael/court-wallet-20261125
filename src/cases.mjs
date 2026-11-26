// 案件、文书版本与控制范围；所有敏感变动走“申请-法务复核”工作流。
import { badRequest, conflict, forbidden, notFound, parseAmount, requireFields, unprocessable } from './errors.mjs';

function assertLegalReviewer(actor, application) {
  if (actor.role !== 'legal') throw forbidden('只有法务可以复核该申请');
  if (actor.id === application.applicantId) throw forbidden('申请人不能复核自己的申请');
}

function getCase(state, caseId) {
  const case_ = state.cases[caseId];
  if (!case_) throw notFound(`案件 ${caseId} 不存在`);
  return case_;
}

function upsertScope(case_, accountId, limitMinor, effectiveFrom, effectiveTo, pendingRelation) {
  const existing = case_.scopes.find(scope => scope.accountId === accountId);
  if (existing) {
    existing.limitMinor = limitMinor;
    existing.currentLimitMinor = limitMinor;
    existing.effectiveFrom = effectiveFrom;
    existing.effectiveTo = effectiveTo ?? existing.effectiveTo ?? null;
    existing.status = pendingRelation ? 'pending_relation' : 'active';
    existing.updatedAt = new Date().toISOString();
    return existing;
  }
  const scope = {
    accountId,
    limitMinor,
    currentLimitMinor: limitMinor,
    effectiveFrom,
    effectiveTo: effectiveTo ?? null,
    status: pendingRelation ? 'pending_relation' : 'active',
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    relationActivatedAt: null,
  };
  case_.scopes.push(scope);
  return scope;
}

// 提交查控申请（文书可能先到：账户关系未确认时形成 pending_relation 待定范围）。
export function applyControl(store, actor, body) {
  requireFields(body, ['caseId', 'accounts', 'limitMinor', 'documentId']);
  const limitMinor = parseAmount(body.limitMinor, '控制金额');
  if (!Array.isArray(body.accounts) || body.accounts.length === 0) throw badRequest('accounts 必须为非空数组');
  const effectiveFrom = body.effectiveFrom ?? new Date().toISOString();
  return store.mutate(actor.id, 'application.create.control', body.caseId, body.reason, (state) => {
    const case_ = getCase(state, body.caseId);
    if (!state.merchants[case_.merchantId]) throw unprocessable('案件主体资料缺失');
    // 申请阶段给出可核实的线索；未确认账户允许先登记，复核时再定。
    const applicationId = store.nextId('APP');
    const application = {
      id: applicationId,
      type: 'control',
      status: 'pending',
      applicantId: actor.id,
      reviewerId: null,
      reviewNote: null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      payload: {
        caseId: case_.id,
        merchantId: case_.merchantId,
        accounts: [...body.accounts],
        limitMinor,
        documentId: String(body.documentId),
        documentVersion: body.documentVersion ?? 1,
        effectiveFrom,
        effectiveTo: body.effectiveTo ?? null,
        rank: body.rank,
        reason: body.reason,
      },
    };
    state.cases[body.caseId].applications ??= [];
    state.cases[body.caseId].applications.push(application);
    return application;
  });
}

// 金额调整申请（不自动改写已完成划款；已在途/受理的指令继续有效，仅重算未支付控制额）。
export function applyAdjust(store, actor, body) {
  requireFields(body, ['caseId', 'limitMinor', 'documentId']);
  const limitMinor = parseAmount(body.limitMinor, '调整后控制金额');
  return store.mutate(actor.id, 'application.create.adjust', body.caseId, body.reason, (state) => {
    getCase(state, body.caseId);
    const applicationId = store.nextId('APP');
    const application = {
      id: applicationId,
      type: 'adjust',
      status: 'pending',
      applicantId: actor.id,
      reviewerId: null,
      reviewNote: null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      payload: {
        caseId: body.caseId,
        limitMinor,
        documentId: String(body.documentId),
        documentVersion: body.documentVersion ?? 1,
        effectiveFrom: body.effectiveFrom ?? new Date().toISOString(),
        reason: body.reason,
      },
    };
    state.cases[body.caseId].applications ??= [];
    state.cases[body.caseId].applications.push(application);
    return application;
  });
}

// 顺位变更申请。
export function applyRank(store, actor, body) {
  requireFields(body, ['caseId', 'rank']);
  if (!Number.isInteger(body.rank) || body.rank <= 0) throw badRequest('rank 必须为正整数');
  return store.mutate(actor.id, 'application.create.rank', body.caseId, body.reason, (state) => {
    getCase(state, body.caseId);
    const applicationId = store.nextId('APP');
    const application = {
      id: applicationId,
      type: 'rank',
      status: 'pending',
      applicantId: actor.id,
      reviewerId: null,
      reviewNote: null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      payload: { caseId: body.caseId, rank: body.rank, reason: body.reason },
    };
    state.cases[body.caseId].applications ??= [];
    state.cases[body.caseId].applications.push(application);
    return application;
  });
}

// 解除申请：支持整案解除或仅解除部分账户/部分金额。
export function applyRelease(store, actor, body) {
  requireFields(body, ['caseId', 'documentId']);
  return store.mutate(actor.id, 'application.create.release', body.caseId, body.reason, (state) => {
    const case_ = getCase(state, body.caseId);
    const releases = [];
    if (body.accounts && Array.isArray(body.accounts)) {
      for (const item of body.accounts) {
        const scope = case_.scopes.find(scopeItem => scopeItem.accountId === item.accountId);
        if (!scope) throw unprocessable(`账户 ${item.accountId} 上不存在控制范围`);
        const releaseMinor = item.releaseMinor === undefined ? scope.currentLimitMinor : parseAmount(item.releaseMinor, '解除金额');
        if (releaseMinor > scope.currentLimitMinor) throw unprocessable('解除金额超过该账户当前控制额');
        releases.push({ accountId: item.accountId, releaseMinor });
      }
    } else {
      for (const scope of case_.scopes) releases.push({ accountId: scope.accountId, releaseMinor: scope.currentLimitMinor });
    }
    const applicationId = store.nextId('APP');
    const application = {
      id: applicationId,
      type: 'release',
      status: 'pending',
      applicantId: actor.id,
      reviewerId: null,
      reviewNote: null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      payload: {
        caseId: body.caseId,
        documentId: String(body.documentId),
        documentVersion: body.documentVersion ?? 1,
        releases,
        reason: body.reason,
      },
    };
    state.cases[body.caseId].applications ??= [];
    state.cases[body.caseId].applications.push(application);
    return application;
  });
}

function appendDocument(case_, payload) {
  case_.documents.push({
    documentId: payload.documentId,
    version: payload.documentVersion ?? 1,
    effectiveFrom: payload.effectiveFrom ?? new Date().toISOString(),
    effectiveTo: payload.effectiveTo ?? null,
    limitMinor: payload.limitMinor,
    accounts: payload.accounts ? [...payload.accounts] : undefined,
    recordedAt: new Date().toISOString(),
  });
}

// 复核通过：按申请类型落控制范围；较早文书补录只重算未支付控制额，不改写已完成划款。
function approveApplication(state, store, application, reviewer, note) {
  const payload = application.payload;
  const case_ = getCase(state, payload.caseId ?? application.payload.caseId);
  application.status = 'approved';
  application.reviewerId = reviewer.id;
  application.reviewNote = note ?? null;
  application.decidedAt = new Date().toISOString();

  if (application.type === 'control') {
    // 文书可以先到、账户归属后确认：已确认账户直接生效，未确认账户形成待定范围。
    appendDocument(case_, payload);
    for (const accountId of payload.accounts) {
      const account = state.accounts[accountId];
      if (!account) throw unprocessable(`账户 ${accountId} 不存在`);
      const owned = account.ownerMerchantId === case_.merchantId && account.confirmed;
      const relation = Object.values(state.relations).some(item =>
        item.accountId === accountId && item.merchantId === case_.merchantId && item.status === 'confirmed');
      const pendingRelation = !(owned || relation);
      upsertScope(case_, accountId, payload.limitMinor, payload.effectiveFrom, payload.effectiveTo, pendingRelation);
    }
    case_.status = 'controlled';
    if (payload.rank !== undefined) reorderRank(state, case_, payload.rank);
  } else if (application.type === 'adjust') {
    if (case_.scopes.length === 0) throw unprocessable('案件尚无生效控制范围，不能调整，应先申请查控');
    appendDocument(case_, payload);
    // 按账户均摊调整额到各范围；已完成划款不动，分配引擎只对未支付额重新判断。
    const perAccount = Math.floor(payload.limitMinor / case_.scopes.length);
    let remainder = payload.limitMinor - perAccount * case_.scopes.length;
    for (const scope of case_.scopes) {
      const next = perAccount + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      scope.currentLimitMinor = next;
      scope.limitMinor = next;
      scope.updatedAt = new Date().toISOString();
    }
  } else if (application.type === 'rank') {
    reorderRank(state, case_, payload.rank);
  } else if (application.type === 'release') {
    appendDocument(case_, payload);
    for (const release of payload.releases) {
      const scope = case_.scopes.find(item => item.accountId === release.accountId);
      if (!scope) continue;
      scope.currentLimitMinor = Math.max(0, scope.currentLimitMinor - release.releaseMinor);
      scope.updatedAt = new Date().toISOString();
      if (scope.currentLimitMinor === 0) scope.status = 'released';
      else scope.status = 'partial_released';
    }
    if (case_.scopes.every(scope => scope.status === 'released')) case_.status = 'released';
    else case_.status = 'partially_released';
    // 被解除的可用额不直接变商家可提现：分配引擎按顺位先满足后顺位案件。
  } else if (application.type === 'refund_decision') {
    const refund = state.refunds[payload.refundId];
    if (!refund) throw notFound('退款不存在');
    refund.decidedAt = new Date().toISOString();
    refund.decidedBy = reviewer.id;
    refund.decisionNote = note ?? payload.note ?? null;
    if (payload.allow) {
      refund.status = 'allowed';
    } else {
      refund.status = 'rejected';
    }
  }
}

// 顺位重排：把目标案件插入到 newRank，同主体内 rank 唯一，被占用顺位向后顺延。
function reorderRank(state, targetCase, newRank) {
  const peers = Object.values(state.cases)
    .filter(item => item.merchantId === targetCase.merchantId && item.id !== targetCase.id)
    .sort((a, b) => a.rank - b.rank);
  const ordered = peers.map(item => item.id);
  const insertAt = Math.min(Math.max(newRank - 1, 0), ordered.length);
  ordered.splice(insertAt, 0, targetCase.id);
  ordered.forEach((caseId, index) => {
    state.cases[caseId].rank = index + 1;
  });
}

export function reviewApplication(store, actor, body) {
  requireFields(body, ['caseId', 'applicationId', 'decision']);
  if (!['approve', 'reject'].includes(body.decision)) throw badRequest('decision 必须是 approve 或 reject');
  return store.mutate(actor.id, `application.${body.decision}`, body.applicationId, body.reason, (state) => {
    const case_ = getCase(state, body.caseId);
    const applications = case_.applications ?? [];
    const application = applications.find(item => item.id === body.applicationId);
    if (!application) throw notFound('申请不存在');
    if (application.status !== 'pending') throw conflict('该申请已复核，不能重复决定');
    assertLegalReviewer(actor, application);
    if (body.decision === 'reject') {
      application.status = 'rejected';
      application.reviewerId = actor.id;
      application.reviewNote = body.note ?? null;
      application.decidedAt = new Date().toISOString();
      return application;
    }
    approveApplication(state, store, application, actor, body.note ?? null);
    return application;
  });
}

export function listApplications(state, query = {}) {
  const all = Object.values(state.cases).flatMap(case_ =>
    (case_.applications ?? []).map(app => ({ ...app, caseId: case_.id })));
  const filtered = query.status ? all.filter(app => app.status === query.status) : all;
  return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function registerCase(state, body) {
  requireFields(body, ['id', 'merchantId']);
  if (state.cases[body.id]) throw conflict(`案件 ${body.id} 已存在`);
  if (!state.merchants[body.merchantId]) throw unprocessable('案件主体不存在，同名商户不能替代');
  const peerRanks = Object.values(state.cases).filter(item => item.merchantId === body.merchantId).map(item => item.rank);
  state.cases[body.id] = {
    id: body.id,
    merchantId: body.merchantId,
    rank: body.rank ?? (peerRanks.length ? Math.max(...peerRanks) + 1 : 1),
    status: 'registered',
    createdAt: new Date().toISOString(),
    documents: [],
    scopes: [],
    applications: [],
  };
  return state.cases[body.id];
}

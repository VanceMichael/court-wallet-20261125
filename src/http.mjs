import { createServer } from 'node:http';
import { HttpError, badRequest, forbidden, notFound, requireReason, unauthorized } from './errors.mjs';
import * as org from './org.mjs';
import * as cases from './cases.mjs';
import * as trade from './trade.mjs';
import * as payments from './payments.mjs';
import {
  computeAccountView,
  computeCaseView,
  computeOrderView,
} from './allocation.mjs';

const json = (res, status, value) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    Connection: 'close',
  });
  res.end(JSON.stringify(value));
};

// 路由表：method 与路径模板（:name 为参数段）。
export function createApp(store, peer) {
  const routes = [];
  const route = (method, pattern, roles, handler) => {
    const parts = pattern.split('/').filter(Boolean);
    routes.push({ method, parts, roles, handler });
  };

  const match = (method, pathname) => {
    const segments = pathname.split('/').filter(Boolean);
    for (const candidate of routes) {
      if (candidate.method !== method || candidate.parts.length !== segments.length) continue;
      const params = {};
      let ok = true;
      for (const [i, part] of candidate.parts.entries()) {
        if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segments[i]);
        else if (part !== segments[i]) { ok = false; break; }
      }
      if (ok) return { ...candidate, params };
    }
    return null;
  };

  const authenticate = (req) => {
    const actorId = req.headers['x-actor-id'];
    if (typeof actorId !== 'string' || !actorId) throw unauthorized();
    const actor = store.state.actors[actorId];
    if (!actor) throw unauthorized('身份不存在或已停用');
    return actor;
  };

  const assertRole = (actor, roles) => {
    if (roles && roles.length && !roles.includes(actor.role)) {
      throw forbidden(`角色 ${actor.role} 无权执行该操作，需要 ${roles.join(' 或 ')}`);
    }
  };

  // ---- 健康检查与静态资料 ----
  route('GET', '/health', null, () => ({ status: 'ok', service: '协助执行资金控制服务', peer: peer.baseUrl }));
  route('GET', '/actors', ['legal', 'payments'], (req, res, { actor }) => ({ actors: Object.values(store.state.actors) }));
  route('GET', '/source-changes', ['legal'], () => ({ sourceChanges: store.state.sourceChanges }));

  // ---- 主体与账户 ----
  route('POST', '/merchants', ['legal', 'payments'], (req, res, ctx) =>
    store.mutate(ctx.actor.id, 'merchant.create', ctx.body.id, ctx.body.reason, (state) => org.createMerchant(state, ctx.body)));
  route('GET', '/merchants', ['legal', 'payments'], () => ({ merchants: Object.values(store.state.merchants) }));
  route('POST', '/accounts', ['legal', 'payments'], (req, res, ctx) =>
    store.mutate(ctx.actor.id, 'account.create', ctx.body.id, ctx.body.reason, (state) => org.createAccount(state, ctx.body)));
  route('GET', '/accounts', ['legal', 'payments'], () => ({
    accounts: Object.keys(store.state.accounts).map(id => computeAccountView(store.state, id)),
  }));
  route('GET', '/accounts/:id', ['legal', 'payments'], (req, res, ctx) =>
    org.accountView({ computeAccountView }, store.state, ctx.params.id));
  route('POST', '/relations', ['legal'], (req, res, ctx) =>
    store.mutate(ctx.actor.id, 'relation.create', ctx.body.id, ctx.body.reason, (state) => org.createRelation(state, ctx.body)));
  route('GET', '/relations', ['legal', 'payments'], () => ({ relations: org.listRelations(store.state) }));
  route('POST', '/relations/:id/confirm', ['legal'], (req, res, ctx) =>
    org.confirmRelation(store, ctx.actor, { ...ctx.body, relationId: ctx.params.id, reason: requireReason(ctx.body) }));

  // ---- 案件与文书 ----
  route('POST', '/cases', ['legal', 'payments'], (req, res, ctx) =>
    store.mutate(ctx.actor.id, 'case.register', ctx.body.id, ctx.body.reason, (state) => cases.registerCase(state, ctx.body)));
  route('GET', '/cases', ['legal', 'payments'], () => ({
    cases: Object.keys(store.state.cases).map(id => computeCaseView(store.state, id)),
  }));
  route('GET', '/cases/:id', ['legal', 'payments'], (req, res, ctx) => {
    const view = computeCaseView(store.state, ctx.params.id);
    if (!view) throw notFound('案件不存在');
    return view;
  });
  route('POST', '/cases/:id/control-applications', ['legal', 'payments'], (req, res, ctx) =>
    cases.applyControl(store, ctx.actor, { ...ctx.body, caseId: ctx.params.id, reason: requireReason(ctx.body) }));
  route('POST', '/cases/:id/adjust-applications', ['legal', 'payments'], (req, res, ctx) =>
    cases.applyAdjust(store, ctx.actor, { ...ctx.body, caseId: ctx.params.id, reason: requireReason(ctx.body) }));
  route('POST', '/cases/:id/rank-applications', ['legal', 'payments'], (req, res, ctx) =>
    cases.applyRank(store, ctx.actor, { ...ctx.body, caseId: ctx.params.id, reason: requireReason(ctx.body) }));
  route('POST', '/cases/:id/release-applications', ['legal', 'payments'], (req, res, ctx) =>
    cases.applyRelease(store, ctx.actor, { ...ctx.body, caseId: ctx.params.id, reason: requireReason(ctx.body) }));
  route('GET', '/cases/:id/applications', ['legal', 'payments'], (req, res, ctx) => ({
    applications: (store.state.cases[ctx.params.id]?.applications ?? []),
  }));
  route('POST', '/applications/review', ['legal'], (req, res, ctx) =>
    cases.reviewApplication(store, ctx.actor, { ...ctx.body, reason: requireReason(ctx.body) }));
  route('GET', '/applications', ['legal', 'payments'], (req, res, ctx) => ({ applications: cases.listApplications(store.state, ctx.query) }));

  // ---- 订单、收入与退款 ----
  route('POST', '/orders', ['legal', 'payments'], (req, res, ctx) =>
    trade.postOrderIncome(store, ctx.actor, { ...ctx.body, reason: requireReason(ctx.body) }));
  route('POST', '/incomes', ['legal', 'payments'], (req, res, ctx) =>
    trade.postIncome(store, ctx.actor, { ...ctx.body, reason: requireReason(ctx.body) }));
  route('GET', '/incomes', ['legal', 'payments'], () => ({ incomes: Object.values(store.state.incomes) }));
  route('GET', '/orders/:id', null, (req, res, ctx) => {
    // 客服只能查自己服务的订单，且看不到账户账单明细。
    if (ctx.actor.role === 'support') return trade.supportOrderView(store.state, ctx.actor, ctx.params.id, computeOrderView);
    const view = computeOrderView(store.state, ctx.params.id);
    if (!view) throw notFound('订单不存在');
    return view;
  });
  route('POST', '/refunds', ['legal', 'payments', 'support'], (req, res, ctx) =>
    trade.requestRefund(store, ctx.actor, { ...ctx.body, reason: requireReason(ctx.body) }));
  route('GET', '/refunds', null, (req, res, ctx) => {
    let refunds = Object.values(store.state.refunds);
    if (ctx.actor.role === 'support') {
      refunds = refunds.filter(item => ctx.actor.orderScope.includes(item.orderId));
    }
    return { refunds };
  });
  route('POST', '/refund-decision-applications', ['legal', 'payments', 'support'], (req, res, ctx) =>
    trade.applyRefundDecision(store, ctx.actor, { ...ctx.body, reason: requireReason(ctx.body) }));
  route('POST', '/refund-decision-applications/review', ['legal'], (req, res, ctx) =>
    trade.reviewRefundDecision(store, ctx.actor, { ...ctx.body, reason: requireReason(ctx.body) }));

  // ---- 付款批次与指令 ----
  route('POST', '/payment-batches', ['payments', 'legal'], (req, res, ctx) =>
    payments.createPaymentBatch(store, peer, ctx.actor, { ...ctx.body, reason: requireReason(ctx.body) }));
  route('GET', '/payment-batches', ['legal', 'payments'], () => ({ batches: Object.values(store.state.batches) }));
  route('GET', '/payment-batches/:id', ['legal', 'payments'], (req, res, ctx) => {
    const batch = store.state.batches[ctx.params.id];
    if (!batch) throw notFound('批次不存在');
    return {
      ...batch,
      instructions: batch.instructionIds.map(id => store.state.instructions[id]),
    };
  });
  route('GET', '/instructions', ['legal', 'payments'], () => ({ instructions: Object.values(store.state.instructions) }));
  route('GET', '/instructions/:id', ['legal', 'payments'], (req, res, ctx) => {
    const instruction = store.state.instructions[ctx.params.id];
    if (!instruction) throw notFound('指令不存在');
    return instruction;
  });
  route('POST', '/instructions/:id/sync', ['payments', 'legal'], (req, res, ctx) =>
    payments.syncInstruction(store, peer, ctx.actor, ctx.params.id));
  route('POST', '/instructions/:id/receipt', ['payments', 'legal'], (req, res, ctx) =>
    payments.recordReceipt(store, ctx.actor, { ...ctx.body, instructionId: ctx.params.id, reason: requireReason(ctx.body) }));
  route('GET', '/payments/overview', ['legal', 'payments'], () => payments.paymentViews(store.state, { computeAccountView }));

  // ---- 审计 ----
  route('GET', '/audit', null, (req, res, ctx) => {
    let entries = store.state.audit;
    if (ctx.actor.role === 'support') {
      const allowed = new Set(ctx.actor.orderScope);
      entries = entries.filter(entry =>
        entry.action.startsWith('refund.') || entry.action.includes('order')
          ? allowed.has(entry.target)
          : false);
    }
    return { audit: entries, count: entries.length };
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 4 * 1024 * 1024) {
          return json(res, 413, { error: '请求体过大' });
        }
      }
      const body = raw ? JSON.parse(raw) : {};
      const matched = match(req.method, url.pathname);
      if (!matched) return json(res, 404, { error: '没有对应的接口' });

      const actor = matched.roles === null ? (req.headers['x-actor-id'] ? authenticate(req) : null) : authenticate(req);
      if (actor) assertRole(actor, matched.roles);
      const query = Object.fromEntries(url.searchParams.entries());
      const result = await matched.handler(req, res, { actor, body, params: matched.params, query });
      if (!res.writableEnded) json(res, 200, result);
    } catch (error) {
      if (error instanceof SyntaxError) return json(res, 400, { error: 'JSON 格式不符' });
      if (error instanceof HttpError) return json(res, error.status, { error: error.message, code: error.code });
      json(res, 500, { error: `服务内部错误：${error.message}` });
    }
  });

  return server;
}

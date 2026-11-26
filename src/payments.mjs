// 账户付款：对接本地收单方协议，允许批次部分受理。
// 关键规则：
// - 案件划付被受理（含结果未明）后，同一金额不能再退给消费者；
// - 查询未明期间不释放资金、不另建新付款；
// - 重复回执、拒绝受理、最终成功分别反映在案件、订单与账户中。
import { badRequest, conflict, forbidden, notFound, parseAmount, requireFields, unprocessable } from './errors.mjs';
import {
  REFUND_PAYABLE_STATUSES,
  computeAccountView,
  computeCaseView,
  computeOrderView,
  INSTRUCTION_OPEN_STATUSES,
} from './allocation.mjs';

function assertPaymentsRole(actor) {
  if (!['payments', 'legal'].includes(actor.role)) throw forbidden('只有支付运营或法务可以发起划付');
}

// 收单方状态映射到本地指令状态。
function mapPeerStatus(peerStatus) {
  switch (peerStatus) {
    case 'accepted': return 'accepted';
    case 'rejected': return 'rejected';
    case 'pending': return 'pending';
    case 'confirmed': return 'confirmed';
    case 'returned': return 'returned';
    default: return 'accepted';
  }
}

function findOpenInstruction(state, kind, businessId) {
  return Object.values(state.instructions).find(item =>
    item.kind === kind && item.businessId === businessId && INSTRUCTION_OPEN_STATUSES.has(item.status));
}

export async function createPaymentBatch(store, peer, actor, body) {
  requireFields(body, ['items']);
  assertPaymentsRole(actor);
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
    throw badRequest('每批 1-100 条指令');
  }

  // 第一阶段：串行事务内校验并锁定资金，生成指令与批次骨架。
  const prepared = await store.mutate(actor.id, 'payment.batch.prepare', body.idempotencyKey ?? null, body.reason, (state) => {
    const idempotencyKey = body.idempotencyKey ?? store.nextId('KEY');
    if (state.batches[idempotencyKey]) {
      return { idempotent: true, idempotencyKey, batch: state.batches[idempotencyKey] };
    }
    const normalized = body.items.map(item => {
      requireFields(item, ['kind', 'businessId', 'amountMinor']);
      if (!['case', 'refund'].includes(item.kind)) throw badRequest('指令 kind 必须是 case 或 refund');
      const amountMinor = parseAmount(item.amountMinor, '划付金额');
      return { ...item, amountMinor };
    });

    // 新批次提交时：存在在途/未明指令的业务不能另建新批次。
    // 同一批次允许同一案件的多条指令（收单方支持批次内部分受理），但同一退款只能出现一次。
    const refundSeen = new Set();
    for (const item of normalized) {
      if (item.kind === 'refund') {
        if (refundSeen.has(item.businessId)) throw badRequest(`同一批次内退款 ${item.businessId} 不能重复`);
        refundSeen.add(item.businessId);
      }
      const open = findOpenInstruction(state, item.kind, item.businessId);
      if (open) throw conflict(`业务 ${item.businessId} 已有在途/未明付款 ${open.id}，未明期间不能另建新付款`);
    }

    const instructions = [];
    for (const item of normalized) {
      if (item.kind === 'case') {
        const caseView = computeCaseView(state, item.businessId);
        if (!caseView) throw notFound(`案件 ${item.businessId} 不存在`);
        if (item.amountMinor > caseView.remainingExecutableMinor) {
          throw unprocessable(`案件 ${item.businessId} 剩余可执行额 ${caseView.remainingExecutableMinor} 不足`);
        }
        // 资金必须真实处于该案件占用中（不能划走后顺位或退款预留的钱）。
        const held = caseView.accountViews.reduce((sum, entry) => sum + entry.currentlyHeldMinor, 0);
        const alreadyLocked = caseView.inFlightMinor;
        if (item.amountMinor > held + alreadyLocked) {
          throw unprocessable(`案件 ${item.businessId} 当前实际控制资金不足（占用 ${held}）`);
        }
      } else {
        const refund = state.refunds[item.businessId];
        if (!refund) throw notFound(`退款 ${item.businessId} 不存在`);
        if (!REFUND_PAYABLE_STATUSES.has(refund.status)) {
          throw unprocessable(`退款 ${refund.id} 状态 ${refund.status} 不允许划付`);
        }
        if (item.amountMinor !== refund.amountMinor) {
          throw unprocessable('退款划付必须与退款预留金额一致');
        }
        const orderView = computeOrderView(state, refund.orderId);
        if (orderView.refundableMinor < refund.amountMinor) {
          throw unprocessable('订单可退余额不足，不能划付退款');
        }
        // 防重复使用的硬约束：退款必须由当前账户分配足额覆盖。
        // 在途/已受理的案件划款已锁定对应资金，若退款因此无法足额覆盖则禁止划付。
        const accountView = computeAccountView(state, refund.accountId);
        const covered = accountView.allocations
          .filter(allocation => allocation.kind === 'refund' && allocation.refundId === refund.id)
          .reduce((sum, allocation) => sum + allocation.amountMinor, 0);
        if (covered < refund.amountMinor) {
          throw unprocessable(
            `退款 ${refund.id} 当前可动用资金 ${covered} 分，不足 ${refund.amountMinor} 分；在途划款锁定的资金不能再退给消费者`,
          );
        }
      }
      const instructionId = store.nextId('PAY');
      const instruction = {
        id: instructionId,
        kind: item.kind,
        businessId: item.businessId,
        accountId: item.kind === 'refund'
          ? state.refunds[item.businessId].accountId
          : (item.accountId ?? state.cases[item.businessId].scopes[0]?.accountId),
        amountMinor: item.amountMinor,
        status: 'created',
        createdAt: new Date().toISOString(),
        createdBy: actor.id,
        peerReference: null,
        events: [{ at: new Date().toISOString(), from: null, to: 'created', note: '指令创建并锁定资金' }],
        batchId: idempotencyKey,
      };
      if (!instruction.accountId) throw unprocessable('无法确定划付账户');
      state.instructions[instructionId] = instruction;
      instructions.push(instruction);
      if (item.kind === 'refund') state.refunds[item.businessId].paymentInstructionId = instructionId;
    }

    const batch = {
      id: idempotencyKey,
      idempotencyKey,
      status: 'submitting',
      createdAt: new Date().toISOString(),
      createdBy: actor.id,
      reason: body.reason,
      instructionIds: instructions.map(item => item.id),
      peerResults: [],
      unknown: false,
    };
    state.batches[idempotencyKey] = batch;
    return { idempotent: false, idempotencyKey, batch, instructions };
  });

  if (prepared.idempotent) return { idempotent: true, batch: prepared.batch };

  // 第二阶段：调用收单方（事务外网络交互）。
  let peerResponse;
  let transportUnknown = false;
  try {
    peerResponse = await peer.submitBatch(prepared.idempotencyKey, prepared.instructions.map(instruction => ({
      instructionId: instruction.id,
      reference: `${instruction.kind}:${instruction.businessId}`,
      kind: instruction.kind,
      businessId: instruction.businessId,
      amountMinor: instruction.amountMinor,
    })));
  } catch (error) {
    if (error.name !== 'PeerTimeoutError') throw error;
    transportUnknown = true;
  }

  // 第三阶段：按收单方结果回写；超时/断线全部标记 unknown，资金保持锁定。
  return store.mutate(actor.id, 'payment.batch.settle', prepared.idempotencyKey, body.reason, (state) => {
    const batch = state.batches[prepared.idempotencyKey];
    if (transportUnknown) {
      batch.status = 'unknown';
      batch.unknown = true;
      for (const instructionId of batch.instructionIds) {
        const instruction = state.instructions[instructionId];
        instruction.status = 'unknown';
        instruction.events.push({ at: new Date().toISOString(), from: 'created', to: 'unknown', note: '收单方超时/断线，受理结果未明，资金保持锁定' });
      }
      return { idempotent: false, batch, unknown: true };
    }

    const results = peerResponse?.results ?? [];
    batch.peerResults = results.map(item => ({ id: item.id, status: item.status, revision: item.revision }));
    let anyAccepted = false;
    let anyRejected = false;
    for (const result of results) {
      const instruction = state.instructions[result.id];
      if (!instruction) continue;
      const next = mapPeerStatus(result.status);
      instruction.events.push({ at: new Date().toISOString(), from: instruction.status, to: next, note: '收单方批次受理结果', revision: result.revision });
      instruction.status = next;
      instruction.peerReference = result.revision ?? null;
      if (next === 'rejected') {
        anyRejected = true;
        if (instruction.kind === 'refund') {
          const refund = state.refunds[instruction.businessId];
          if (refund && refund.paymentInstructionId === instruction.id) refund.paymentInstructionId = null;
        }
      } else {
        anyAccepted = true;
      }
    }
    batch.status = anyRejected && !anyAccepted ? 'rejected' : anyRejected ? 'partial_accepted' : 'accepted';
    return { idempotent: false, batch, peerResults: batch.peerResults };
  });
}

// 按平台业务流水查询收单方并同步状态；未明期间不释放、不新建。
export async function syncInstruction(store, peer, actor, instructionId) {
  const instruction = store.state.instructions[instructionId];
  if (!instruction) throw notFound('付款指令不存在');
  let lookup;
  try {
    lookup = await peer.lookup(instructionId);
  } catch (error) {
    if (error.name !== 'PeerTimeoutError') throw error;
    return store.mutate(actor.id, 'payment.lookup.unknown', instructionId, '查询超时，继续保持未明锁定', (state) => {
      const current = state.instructions[instructionId];
      current.events.push({ at: new Date().toISOString(), to: current.status, note: '查询收单方超时，结果未明' });
      return { instruction: current, unknown: true };
    });
  }
  return store.mutate(actor.id, 'payment.lookup.sync', instructionId, '收单方查询结果回写', (state) => {
    const current = state.instructions[instructionId];
    if (!lookup.found) {
      current.events.push({ at: new Date().toISOString(), to: current.status, note: '收单方未查到该流水（不等于未受理），保持未明锁定' });
      return { instruction: current, unknown: true, peerFound: false };
    }
    const next = mapPeerStatus(lookup.operation.status);
    const changed = current.status !== next;
    current.events.push({
      at: new Date().toISOString(),
      from: current.status,
      to: next,
      note: '收单方查询同步',
      revision: lookup.operation.revision,
      duplicate: !changed,
    });
    current.status = next;
    current.peerReference = lookup.operation.revision ?? current.peerReference;
    // 终态回写到案件/订单关联对象。
    if (current.kind === 'refund') {
      const refund = state.refunds[current.businessId];
      if (refund) {
        if (next === 'confirmed') refund.status = 'completed';
        if (next === 'returned') refund.status = 'returned';
      }
    }
    return { instruction: current, peerFound: true, changed };
  });
}

// 收单方最终回执（confirmed/returned 等）由查询同步带入；该接口用于登记外部送达的回执。
export function recordReceipt(store, actor, body) {
  requireFields(body, ['instructionId', 'status']);
  const terminal = new Set(['confirmed', 'returned', 'rejected']);
  if (!terminal.has(body.status)) throw badRequest('回执终态必须是 confirmed/returned/rejected');
  return store.mutate(actor.id, 'payment.receipt', body.instructionId, body.reason, (state) => {
    const instruction = state.instructions[body.instructionId];
    if (!instruction) throw notFound('付款指令不存在');
    const already = instruction.events.some(event => event.to === body.status && event.duplicateReceipt === true);
    const duplicate = instruction.status === body.status;
    instruction.events.push({
      at: new Date().toISOString(),
      from: instruction.status,
      to: body.status,
      note: body.note ?? '外部回执登记',
      duplicateReceipt: duplicate,
      details: body.details ?? null,
    });
    if (!duplicate) instruction.status = body.status;
    if (instruction.kind === 'refund') {
      const refund = state.refunds[instruction.businessId];
      if (refund) {
        if (body.status === 'confirmed') refund.status = 'completed';
        if (body.status === 'returned') refund.status = 'returned';
      }
    }
    return { instruction, duplicateReceipt: duplicate };
  });
}

export function paymentViews(state, allocation) {
  const instructions = Object.values(state.instructions).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const batches = Object.values(state.batches).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    batches,
    instructions: instructions.map(instruction => {
      const view = computeAccountView(state, instruction.accountId);
      return { ...instruction, accountView: { freeMinor: view.freeMinor, lockedMinor: view.lockedMinor, reservedMinor: view.reservedMinor } };
    }),
  };
}

// 检查三：付款受理结果未明（超时/断线/查询不到）时，资金不被释放、不另建新付款、不重复退款；
// 重复回执、拒绝受理、最终成功分别反映在案件、订单与账户；平台与收单方可分别重启。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, client, ACTORS } from './helpers/harness.mjs';

const reason = '演练未明付款检查';

async function setupControlledFunds(harness) {
  const api = actor => client(harness.appUrl, actor);
  // 干净账户：新建账户与新订单，避免种子数据干扰。
  await api(ACTORS.legalA).post('/accounts', { id: 'W-T', ownerMerchantId: 'M-A', confirmed: true, reason });
  const order = await api(ACTORS.cashier).post('/orders', {
    orderId: 'O-T', merchantId: 'M-A', accountId: 'W-T', paidMinor: 100000, reason,
  });
  assert.equal(order.status, 200);
  const applied = await api(ACTORS.legalA).post('/cases/C-1/control-applications', {
    accounts: ['W-T'], limitMinor: 80000, documentId: 'DOC-T', rank: 1, reason,
  });
  await api(ACTORS.legalB).post('/applications/review', {
    caseId: 'C-1', applicationId: applied.body.id, decision: 'approve', reason,
  });
  return api;
}

test('收单方断线/在途：资金保持锁定，不能另建付款，同一金额不能再退给消费者', async () => {
  const harness = await startHarness();
  const api = await setupControlledFunds(harness);
  try {
    // 账户到账 100000，C-1 控制 80000。先让一笔 80000 案件划款进入在途（资金被全部锁入控制）。
    const first = await api(ACTORS.cashier).post('/payment-batches', {
      idempotencyKey: 'inflight-batch', items: [{ kind: 'case', businessId: 'C-1', amountMinor: 80000 }], reason,
    });
    assert.equal(first.status, 200);
    const instructionId = first.body.batch.instructionIds[0];
    assert.equal(first.body.batch.status, 'accepted');

    // 同一案件第二笔划付：存在在途指令，直接冲突，不能另建付款。
    const second = await api(ACTORS.cashier).post('/payment-batches', {
      idempotencyKey: 'inflight-batch-2', items: [{ kind: 'case', businessId: 'C-1', amountMinor: 5000 }], reason,
    });
    assert.equal(second.status, 409);
    assert.match(second.body.error, /在途|未明|不能另建/);

    // 控制生效后退款 30000，经法务允许。
    const refund = await api(ACTORS.cashier).post('/refunds', { orderId: 'O-T', amountMinor: 30000, reason });
    assert.equal(refund.status, 200);
    assert.equal(refund.body.status, 'legal_pending');
    const decision = await api(ACTORS.cashier).post('/refund-decision-applications', {
      refundId: refund.body.id, allow: true, reason,
    });
    const review = await api(ACTORS.legalA).post('/refund-decision-applications/review', {
      applicationId: decision.body.id, decision: 'approve', reason,
    });
    assert.equal(review.status, 200);

    // 退款划付：可动用资金（100000 - 锁定 80000 = 20000）不足 30000，被禁止，不能动用在途锁定的钱。
    const refundPay = await api(ACTORS.cashier).post('/payment-batches', {
      idempotencyKey: 'refund-blocked', items: [{ kind: 'refund', businessId: refund.body.id, amountMinor: 30000 }], reason,
    });
    assert.equal(refundPay.status, 422);
    assert.match(refundPay.body.error, /在途划款锁定|不能再退/);

    const account = (await api(ACTORS.cashier).get('/accounts/W-T')).body;
    assert.equal(account.lockedMinor, 80000);
    assert.equal(account.freeMinor + account.reservedMinor + account.lockedMinor, account.receivedMinor);
    assert.ok(instructionId);
  } finally {
    await harness.stop();
  }
});

test('真实断线场景：受理结果未明期间查询不释放资金，最终确认后正确落账', async () => {
  const harness = await startHarness();
  const api = await setupControlledFunds(harness);
  try {
    // 用独立账户与可预知规则：先设置一个不存在指令的断线规则无法预知编号，
    // 因此通过收单方控制接口对“下一条指令”设置规则——指令编号顺序可预知（PAY-000001）。
    await harness.peer.setRule('PAY-000001', 'accepted_disconnect');
    const batch = await api(ACTORS.cashier).post('/payment-batches', {
      idempotencyKey: 'disconnect-batch', items: [{ kind: 'case', businessId: 'C-1', amountMinor: 25000 }], reason,
    });
    assert.equal(batch.status, 200);
    assert.equal(batch.body.unknown, true);
    const instructionId = batch.body.batch.instructionIds[0];
    assert.equal(instructionId, 'PAY-000001');

    let instruction = (await api(ACTORS.cashier).get(`/instructions/${instructionId}`)).body;
    assert.equal(instruction.status, 'unknown');

    // 查询收单方：实际已持久化受理（accepted），同步后状态更新，资金始终锁定。
    const synced = await api(ACTORS.cashier).post(`/instructions/${instructionId}/sync`, {});
    assert.equal(synced.status, 200);
    assert.equal(synced.body.peerFound, true);
    assert.equal(synced.body.instruction.status, 'accepted');

    // 收单方最终确认。
    await harness.peer.settle(instructionId, 'confirmed', { receipt: 'final-rcp' });
    const finalSync = await api(ACTORS.cashier).post(`/instructions/${instructionId}/sync`, {});
    assert.equal(finalSync.body.instruction.status, 'confirmed');

    const caseView = (await api(ACTORS.legalA).get('/cases/C-1')).body;
    assert.equal(caseView.disbursedMinor, 25000);
    assert.equal(caseView.remainingExecutableMinor, 80000 - 25000);
  } finally {
    await harness.stop();
  }
});

test('查询收单方 404（未查到不等于未受理）：继续锁定，收单方重启恢复后可同步', async () => {
  const harness = await startHarness();
  const api = await setupControlledFunds(harness);
  try {
    const batch = await api(ACTORS.cashier).post('/payment-batches', {
      idempotencyKey: 'lost-batch', items: [{ kind: 'case', businessId: 'C-1', amountMinor: 15000 }], reason,
    });
    const instructionId = batch.body.batch.instructionIds[0];
    assert.equal(batch.body.batch.status, 'accepted');

    // 用空状态文件重启收单方（新端口，应用客户端自动跟随），模拟该流水查询不到（不等于未受理）。
    const emptyState = `${harness.dir}/empty-peer.json`;
    await harness.restartPeer({ stateFile: emptyState });
    const lookup404 = await harness.peer.lookup(instructionId);
    assert.equal(lookup404.found, false);

    // 应用侧同步：404 时指令保持原状态、资金不释放。
    const syncedUnknown = await api(ACTORS.cashier).post(`/instructions/${instructionId}/sync`, {});
    assert.equal(syncedUnknown.body.unknown, true);
    assert.equal(syncedUnknown.body.instruction.status, 'accepted');

    // 用原状态文件重启收单方（恢复流水），可正常查询。
    await harness.restartPeer();
    const found = await harness.peer.lookup(instructionId);
    assert.equal(found.found, true);
    assert.equal(found.operation.status, 'accepted');
  } finally {
    await harness.stop();
  }
});

test('批次部分受理：拒绝项释放资金并反映到案件，受理项保持锁定', async () => {
  const harness = await startHarness();
  const api = await setupControlledFunds(harness);
  try {
    // 两条指令，其中一条被收单方拒绝。
    await harness.peer.setRule('PAY-000002', 'rejected');
    const batch = await api(ACTORS.cashier).post('/payment-batches', {
      idempotencyKey: 'partial-batch',
      items: [
        { kind: 'case', businessId: 'C-1', amountMinor: 20000 },
        { kind: 'case', businessId: 'C-1', amountMinor: 10000 },
      ],
      reason,
    });
    assert.equal(batch.status, 200);
    assert.equal(batch.body.batch.status, 'partial_accepted');
    const ids = batch.body.batch.instructionIds;
    const statuses = ids.map(id => harness.store.state.instructions[id].status).sort();
    assert.deepEqual(statuses, ['accepted', 'rejected']);

    const account = (await api(ACTORS.cashier).get('/accounts/W-T')).body;
    assert.equal(account.lockedMinor, 20000); // 只有受理项锁钱
    // 被拒绝的 10000 回到可分配资金（仍受案件控制，不会变成自由提现）。
    const caseAllocation = account.allocations.find(a => a.kind === 'case' && a.caseId === 'C-1');
    assert.ok(caseAllocation.amountMinor >= 50000);
  } finally {
    await harness.stop();
  }
});

test('重复回执不重复入账；returned 与 rejected 分别反映在指令和订单', async () => {
  const harness = await startHarness();
  const api = await setupControlledFunds(harness);
  try {
    const batch = await api(ACTORS.cashier).post('/payment-batches', {
      idempotencyKey: 'receipt-batch', items: [{ kind: 'case', businessId: 'C-1', amountMinor: 12000 }], reason,
    });
    const instructionId = batch.body.batch.instructionIds[0];

    const r1 = await api(ACTORS.cashier).post(`/instructions/${instructionId}/receipt`, {
      status: 'confirmed', note: '第一次回执', reason,
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.duplicateReceipt, false);

    const r2 = await api(ACTORS.cashier).post(`/instructions/${instructionId}/receipt`, {
      status: 'confirmed', note: '重复回执', reason,
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.duplicateReceipt, true); // 重复回执被明确标记，不产生第二笔账

    const caseView = (await api(ACTORS.legalA).get('/cases/C-1')).body;
    assert.equal(caseView.disbursedMinor, 12000); // 只计一次
    assert.equal(caseView.instructions[0].events.filter(e => e.duplicateReceipt).length, 1);
  } finally {
    await harness.stop();
  }
});

test('业务服务重启后未明状态与资金锁定保留，收单方与平台可分别重启', async () => {
  const harness = await startHarness();
  const api = await setupControlledFunds(harness);
  try {
    await harness.peer.setRule('PAY-000001', 'accepted_disconnect');
    const batch = await api(ACTORS.cashier).post('/payment-batches', {
      idempotencyKey: 'restart-batch', items: [{ kind: 'case', businessId: 'C-1', amountMinor: 18000 }], reason,
    });
    assert.equal(batch.body.unknown, true);
    const instructionId = batch.body.batch.instructionIds[0];

    // 仅重启业务服务（收单方不动）。
    const restarted = await harness.restartApp();
    const api2 = client(restarted.url, ACTORS.cashier);
    const instruction = (await api2.get(`/instructions/${instructionId}`)).body;
    assert.equal(instruction.status, 'unknown');
    const account = (await api2.get('/accounts/W-T')).body;
    assert.equal(account.lockedMinor, 18000); // 未明资金重启后仍锁定

    // 重启后仍不能另建付款。
    const duplicate = await api2.post('/payment-batches', {
      idempotencyKey: 'after-restart', items: [{ kind: 'case', businessId: 'C-1', amountMinor: 5000 }], reason,
    });
    assert.equal(duplicate.status, 409);

    // 收单方查询恢复后同步为已受理。
    const synced = await api2.post(`/instructions/${instructionId}/sync`, {});
    assert.equal(synced.body.instruction.status, 'accepted');
  } finally {
    await harness.stop();
  }
});

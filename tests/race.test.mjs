// 检查一：竞争申请并发时，资金不被重复承诺/重复使用。
// 覆盖：两个案件争抢同一笔新收入、同一案件并发划付、重复退款、并发复核、越权复核。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, client, ACTORS } from './helpers/harness.mjs';

const reason = '演练竞争检查';

async function approveControl(api, caseId, accounts, limitMinor, documentId, applicant, reviewer, rank) {
  const applied = await api(applicant).post(`/cases/${caseId}/control-applications`, {
    accounts, limitMinor, documentId, rank, reason,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const reviewed = await api(reviewer).post('/applications/review', {
    caseId, applicationId: applied.body.id, decision: 'approve', reason,
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  return reviewed.body;
}

test('两个案件同时要求控制新收入时，按顺位切分而不是各自承诺全部金额', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    // 种子数据：W-A 已有到账 50000，且有控制生效前退款 RF-1 预留 12000。
    await approveControl(api, 'C-1', ['W-A'], 90000, 'DOC-A', ACTORS.legalA, ACTORS.legalB, 1);
    await approveControl(api, 'C-2', ['W-A'], 60000, 'DOC-B', ACTORS.legalB, ACTORS.legalA, 2);

    // 再来一笔新收入 100000。
    const income = await api(ACTORS.cashier).post('/incomes', { accountId: 'W-A', amountMinor: 100000, reason });
    assert.equal(income.status, 200);

    const account = (await api(ACTORS.legalA).get('/accounts/W-A')).body;
    assert.equal(account.receivedMinor, 150000);
    // 控制前退款先保留 12000。
    assert.equal(account.allocations.find(a => a.kind === 'refund').amountMinor, 12000);
    const c1 = account.allocations.find(a => a.kind === 'case' && a.caseId === 'C-1');
    const c2 = account.allocations.find(a => a.kind === 'case' && a.caseId === 'C-2');
    assert.equal(c1.amountMinor, 90000); // 先顺位案件足额
    assert.equal(c2.amountMinor, 48000); // 后顺位只拿到剩余，未被全额承诺
    // 恒等式：可用 + 预留 + 锁定 = 到账。
    assert.equal(account.freeMinor + account.reservedMinor + account.lockedMinor, account.receivedMinor);
    assert.equal(account.freeMinor, 0);

    const c2View = (await api(ACTORS.legalA).get('/cases/C-2')).body;
    assert.equal(c2View.currentlyControlledMinor, 48000); // 实际控制占用
    // 控制总额 60000 中尚有 12000 无资金覆盖，案件剩余可执行额与资金缺口都能查清
    assert.equal(c2View.limitMinor - c2View.currentlyControlledMinor, 12000);
  } finally {
    await harness.stop();
  }
});

test('同一案件并发发起两笔划付，只有一笔成功，资金不重复划出', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    await approveControl(api, 'C-1', ['W-A'], 90000, 'DOC-A', ACTORS.legalA, ACTORS.legalB, 1);
    const before = (await api(ACTORS.cashier).get('/accounts/W-A')).body;

    const payload = key => ({ idempotencyKey: key, items: [{ kind: 'case', businessId: 'C-1', amountMinor: 30000 }], reason });
    const [r1, r2] = await Promise.all([
      api(ACTORS.cashier).post('/payment-batches', payload('race-key-1')),
      api(ACTORS.cashier).post('/payment-batches', payload('race-key-2')),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const conflictBody = r1.status === 409 ? r1.body : r2.body;
    assert.match(conflictBody.error, /在途|未明|不能另建/);

    const instructions = (await api(ACTORS.cashier).get('/instructions')).body.instructions;
    assert.equal(instructions.length, 1);
    assert.equal(instructions[0].amountMinor, 30000);
    const after = (await api(ACTORS.cashier).get('/accounts/W-A')).body;
    assert.equal(after.lockedMinor, before.lockedMinor + 30000);
    assert.equal(after.freeMinor + after.reservedMinor + after.lockedMinor, after.receivedMinor);
  } finally {
    await harness.stop();
  }
});

test('客服并发重复提交退款只成立一笔，不能靠重复提交绕行', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    // support-a 仅服务 O-1；O-1 已有种子退款 RF-1（在途），新退款应被拒绝。
    const [r1, r2] = await Promise.all([
      api(ACTORS.supportA).post('/refunds', { orderId: 'O-1', amountMinor: 1000, reason }),
      api(ACTORS.supportA).post('/refunds', { orderId: 'O-1', amountMinor: 1000, reason }),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [409, 409]);
    const refunds = (await api(ACTORS.legalA).get('/refunds')).body.refunds;
    assert.equal(refunds.length, 1);
  } finally {
    await harness.stop();
  }
});

test('同一申请并发复核只生效一次；申请人不能自审，非法务不能复核', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    const applied = await api(ACTORS.legalA).post('/cases/C-1/control-applications', {
      accounts: ['W-A'], limitMinor: 10000, documentId: 'DOC-X', reason,
    });
    assert.equal(applied.status, 200);
    const reviewBody = { caseId: 'C-1', applicationId: applied.body.id, decision: 'approve', reason };

    const selfReview = await api(ACTORS.legalA).post('/applications/review', reviewBody);
    assert.equal(selfReview.status, 403);
    const cashierReview = await api(ACTORS.cashier).post('/applications/review', reviewBody);
    assert.equal(cashierReview.status, 403);

    const [ok1, ok2] = await Promise.all([
      api(ACTORS.legalB).post('/applications/review', reviewBody),
      api(ACTORS.legalB).post('/applications/review', reviewBody),
    ]);
    assert.deepEqual([ok1.status, ok2.status].sort(), [200, 409]);
    const caseView = (await api(ACTORS.legalB).get('/cases/C-1')).body;
    assert.equal(caseView.status, 'controlled');
    assert.equal(caseView.documents.length, 1); // 文书版本只记一次
  } finally {
    await harness.stop();
  }
});

test('并发入账两笔订单均成功且账户恒等式持续成立', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    const [o1, o2] = await Promise.all([
      api(ACTORS.cashier).post('/orders', { orderId: 'O-RACE-1', merchantId: 'M-A', accountId: 'W-A', paidMinor: 20000, reason }),
      api(ACTORS.cashier).post('/orders', { orderId: 'O-RACE-2', merchantId: 'M-A', accountId: 'W-A', paidMinor: 30000, reason }),
    ]);
    assert.equal(o1.status, 200);
    assert.equal(o2.status, 200);
    const account = (await api(ACTORS.cashier).get('/accounts/W-A')).body;
    assert.equal(account.receivedMinor, 50000 + 20000 + 30000);
    assert.equal(account.freeMinor + account.reservedMinor + account.lockedMinor, account.receivedMinor);
  } finally {
    await harness.stop();
  }
});

// 检查二：控制范围（部分）解除、顺位让位、代收归属确认、较早文书补录、控制后退款。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, client, ACTORS } from './helpers/harness.mjs';

const reason = '演练解除检查';

async function control(api, caseId, accounts, limitMinor, documentId, applicant, reviewer, rank) {
  const applied = await api(applicant).post(`/cases/${caseId}/control-applications`, {
    accounts, limitMinor, documentId, rank, reason,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const reviewed = await api(reviewer).post('/applications/review', {
    caseId, applicationId: applied.body.id, decision: 'approve', reason,
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
}

async function release(api, caseId, accounts, reviewer, documentId) {
  const applied = await api(ACTORS.legalA).post(`/cases/${caseId}/release-applications`, {
    documentId, accounts, reason,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const reviewed = await api(reviewer).post('/applications/review', {
    caseId, applicationId: applied.body.id, decision: 'approve', reason,
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
}

test('部分解除先让位给后顺位案件，不直接变成商家可提现额', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    // 入账 100000 到 W-A（另有种子到账 50000 与控制前退款 12000）。
    await api(ACTORS.cashier).post('/incomes', { accountId: 'W-A', amountMinor: 100000, reason });
    // C-1、C-2 均仅控制 W-A，顺位分别为 1、2。
    await control(api, 'C-1', ['W-A'], 90000, 'DOC-A', ACTORS.legalA, ACTORS.legalB, 1);
    await control(api, 'C-2', ['W-A'], 60000, 'DOC-B', ACTORS.legalB, ACTORS.legalA, 2);

    let account = (await api(ACTORS.legalA).get('/accounts/W-A')).body;
    const beforeC2 = account.allocations.find(a => a.kind === 'case' && a.caseId === 'C-2').amountMinor;
    assert.equal(beforeC2, 48000);
    assert.equal(account.freeMinor, 0);

    // 解除 C-1 在 W-A 上 18000（对应演练资料 RELAX-A）。
    await release(api, 'C-1', [{ accountId: 'W-A', releaseMinor: 18000 }], ACTORS.legalB, 'DOC-RELAX');

    account = (await api(ACTORS.legalA).get('/accounts/W-A')).body;
    const c1 = account.allocations.find(a => a.kind === 'case' && a.caseId === 'C-1');
    const c2 = account.allocations.find(a => a.kind === 'case' && a.caseId === 'C-2');
    assert.equal(c1.amountMinor, 72000);
    assert.equal(c2.amountMinor, 60000); // 后顺位案件先补足到其控制上限
    // 两案控制合计 132000 < 可分配 138000，满足后顺位后多出的 6000 才是可提现；
    // 被解除的 18000 中 12000 已让位给 C-2，没有整笔直接变成商家可提现额。
    assert.equal(account.freeMinor, 6000);

    // 全部解除 C-1 后，满足 C-2 的剩余才进入 free。
    await release(api, 'C-1', [{ accountId: 'W-A', releaseMinor: 72000 }], ACTORS.legalB, 'DOC-RELAX-2');
    account = (await api(ACTORS.legalA).get('/accounts/W-A')).body;
    assert.equal(account.allocations.filter(a => a.kind === 'case' && a.caseId === 'C-1').length, 0);
    const c2Final = account.allocations.find(a => a.kind === 'case' && a.caseId === 'C-2');
    assert.equal(c2Final.amountMinor, 60000);
    // 到账 150000 - 控制前退款 12000 - C-2 控制 60000 = 78000 才是商家可提现。
    assert.equal(account.freeMinor, 78000);
  } finally {
    await harness.stop();
  }
});

test('代收账户未经归属确认不能纳入控制；确认后待定控制自动激活', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    // W-AGENT 名义归属 M-B，REL-1 对 M-A 的代收关系未确认。
    // 文书可以先到：复核通过后，未确认账户形成 pending_relation 待定范围，不授予控制权。
    const applied = await api(ACTORS.legalB).post('/cases/C-2/control-applications', {
      accounts: ['W-A', 'W-AGENT'], limitMinor: 50000, documentId: 'DOC-B', reason,
    });
    assert.equal(applied.status, 200);
    const reviewed = await api(ACTORS.legalA).post('/applications/review', {
      caseId: 'C-2', applicationId: applied.body.id, decision: 'approve', reason,
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));

    let caseView = (await api(ACTORS.legalA).get('/cases/C-2')).body;
    const pendingScope = caseView.scopes.find(s => s.accountId === 'W-AGENT');
    assert.equal(pendingScope.status, 'pending_relation');
    const activeScope = caseView.scopes.find(s => s.accountId === 'W-A');
    assert.equal(activeScope.status, 'active');
    // 待定范围不产生资金占用。
    const agentAccount = (await api(ACTORS.legalA).get('/accounts/W-AGENT')).body;
    assert.equal(agentAccount.reservedMinor, 0);

    // 归属确认（对应 REL-CONFIRM）后待定控制自动激活。
    const confirm = await api(ACTORS.legalB).post('/relations/REL-1/confirm', { reason });
    assert.equal(confirm.status, 200);
    assert.deepEqual(confirm.body.activated.map(item => item.caseId), ['C-2']);

    caseView = (await api(ACTORS.legalA).get('/cases/C-2')).body;
    const agentScope = caseView.scopes.find(s => s.accountId === 'W-AGENT');
    assert.equal(agentScope.status, 'active');
    assert.ok(agentScope.relationActivatedAt);
  } finally {
    await harness.stop();
  }
});

test('较早文书补录不自动改写已完成划款，仅对未支付控制额重新判断', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    await api(ACTORS.cashier).post('/incomes', { accountId: 'W-A', amountMinor: 100000, reason });
    await control(api, 'C-2', ['W-A'], 60000, 'DOC-B', ACTORS.legalB, ACTORS.legalA, 1);

    // C-2 先划付 30000 并被收单方最终确认。
    const batch = await api(ACTORS.cashier).post('/payment-batches', {
      idempotencyKey: 'bk-1', items: [{ kind: 'case', businessId: 'C-2', amountMinor: 30000 }], reason,
    });
    assert.equal(batch.status, 200);
    const instructionId = batch.body.batch.instructionIds[0];
    await harness.peer.settle(instructionId, 'confirmed', { receipt: 'rcp-1' });
    const sync = await api(ACTORS.cashier).post(`/instructions/${instructionId}/sync`, {});
    assert.equal(sync.status, 200);
    assert.equal(sync.body.instruction.status, 'confirmed');

    // 补录更早文书 C-1（rank 调整到 C-2 之前）。
    await control(api, 'C-1', ['W-A'], 90000, 'DOC-A-EARLY', ACTORS.legalA, ACTORS.legalB, 1);

    const c2 = (await api(ACTORS.legalB).get('/cases/C-2')).body;
    const c1 = (await api(ACTORS.legalB).get('/cases/C-1')).body;
    assert.equal(c1.rank, 1);
    assert.equal(c2.rank, 2);
    // 已完成划款 30000 原样保留，不被补录改写。
    assert.equal(c2.disbursedMinor, 30000);
    assert.equal(c2.instructions[0].status, 'confirmed');
    // 未支付控制额重新判断：C-1 先足额占用。
    const account = (await api(ACTORS.legalB).get('/accounts/W-A')).body;
    assert.equal(account.allocations.find(a => a.kind === 'case' && a.caseId === 'C-1').amountMinor, 90000);
  } finally {
    await harness.stop();
  }
});

test('控制生效后退款须法务决定，允许后自最后顺位案件已控资金让位', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    // 新订单 O-3 入账 40000，随后建立控制，再提退款（控制生效后）。
    const order = await api(ACTORS.cashier).post('/orders', {
      orderId: 'O-3', merchantId: 'M-A', accountId: 'W-A', paidMinor: 40000, reason,
    });
    assert.equal(order.status, 200);
    await control(api, 'C-1', ['W-A'], 200000, 'DOC-POST', ACTORS.legalA, ACTORS.legalB, 1);

    const refund = await api(ACTORS.supportA).post('/refunds', { orderId: 'O-3', amountMinor: 15000, reason });
    // support-a 不服务 O-3，先验证客服数据边界。
    assert.equal(refund.status, 403);

    const refundByOps = await api(ACTORS.cashier).post('/refunds', { orderId: 'O-3', amountMinor: 15000, reason });
    assert.equal(refundByOps.status, 200);
    assert.equal(refundByOps.body.status, 'legal_pending');
    const refundId = refundByOps.body.id;

    // 申请人不能自审；换一名法务复核允许。
    const decision = await api(ACTORS.cashier).post('/refund-decision-applications', { refundId, allow: true, reason });
    assert.equal(decision.status, 200);
    const self = await api(ACTORS.cashier).post('/refund-decision-applications/review', {
      applicationId: decision.body.id, decision: 'approve', reason,
    });
    assert.equal(self.status, 403);
    const reviewed = await api(ACTORS.legalA).post('/refund-decision-applications/review', {
      applicationId: decision.body.id, decision: 'approve', reason,
    });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.refund.status, 'allowed');

    const account = (await api(ACTORS.legalA).get('/accounts/W-A')).body;
    const postRefund = account.allocations.find(a => a.kind === 'refund' && a.refundId === refundId);
    assert.equal(postRefund.amountMinor, 15000);
    assert.match(postRefund.note, /让位/);
    // 案件实际占用被让位扣减，后续案件可执行余额相应变化。
    const caseView = (await api(ACTORS.legalA).get('/cases/C-1')).body;
    assert.ok(caseView.accountViews.some(v => v.refundClawbackMinor === 15000));
  } finally {
    await harness.stop();
  }
});

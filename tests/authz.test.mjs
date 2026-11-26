// 检查四：角色权限、客服数据边界、主体同名不合并、账户全量恒等式与审计留痕。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, client, ACTORS } from './helpers/harness.mjs';

const reason = '演练权限检查';

test('客服只能查自己服务的订单，且看不到账户账单明细；无权访问账户与案件视图', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    // support-a 仅服务 O-1。
    const own = await api(ACTORS.supportA).get('/orders/O-1');
    assert.equal(own.status, 200);
    assert.equal(own.body.orderId, 'O-1');
    assert.equal(own.body.accountId, undefined); // 账户标识被隐藏，无账单明细

    const other = await api(ACTORS.supportA).get('/orders/O-2');
    assert.equal(other.status, 403);

    const accounts = await api(ACTORS.supportA).get('/accounts');
    assert.equal(accounts.status, 403);
    const cases = await api(ACTORS.supportA).get('/cases');
    assert.equal(cases.status, 403);
    const control = await api(ACTORS.supportA).post('/cases/C-1/control-applications', {
      accounts: ['W-A'], limitMinor: 1000, documentId: 'D', reason,
    });
    assert.equal(control.status, 403);

    // 客服退款列表只含自己服务订单的退款。
    const refunds = await api(ACTORS.supportA).get('/refunds');
    assert.equal(refunds.status, 200);
    assert.ok(refunds.body.refunds.length > 0);
    assert.ok(refunds.body.refunds.every(item => item.orderId === 'O-1'));
  } finally {
    await harness.stop();
  }
});

test('同名商户不等于同一主体：跨主体控制与账户归属被拒绝', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    // M-A 与 M-B 同名“南岸商行”，但 W-AGENT 归属 M-B，不能直接用于 M-A 案件。
    const applied = await api(ACTORS.legalB).post('/cases/C-1/control-applications', {
      accounts: ['W-AGENT'], limitMinor: 10000, documentId: 'D-NAME', reason,
    });
    await api(ACTORS.legalA).post('/applications/review', {
      caseId: 'C-1', applicationId: applied.body.id, decision: 'approve', reason,
    });
    const caseView = (await api(ACTORS.legalA).get('/cases/C-1')).body;
    const scope = caseView.scopes.find(s => s.accountId === 'W-AGENT');
    assert.equal(scope.status, 'pending_relation'); // 只能待定，不授予控制权
    const agent = (await api(ACTORS.legalA).get('/accounts/W-AGENT')).body;
    assert.equal(agent.reservedMinor, 0);

    // 给不存在的主体建控制被拒。
    const bad = await api(ACTORS.legalA).post('/cases', { id: 'C-X', merchantId: 'M-NOPE', reason });
    assert.equal(bad.status, 422);
  } finally {
    await harness.stop();
  }
});

test('所有写操作都保留操作人与业务原因，审计可追溯', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    const noReason = await api(ACTORS.cashier).post('/incomes', { accountId: 'W-A', amountMinor: 1000 });
    assert.equal(noReason.status, 400);

    await api(ACTORS.cashier).post('/incomes', { accountId: 'W-A', amountMinor: 1000, reason: '对账补录' });
    const audit = (await api(ACTORS.legalA).get('/audit')).body.audit;
    const entry = audit.find(item => item.action === 'income.post');
    assert.ok(entry);
    assert.equal(entry.actorId, 'cashier');
    assert.equal(entry.reason, '对账补录');
    assert.ok(entry.at && entry.id);
  } finally {
    await harness.stop();
  }
});

test('全账户恒等式：到账 = 可用 + 预留 + 锁定，且不存在负金额', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    // 建立多账户、多案件、退款与一笔在途付款的混合状态。
    await api(ACTORS.legalB).post('/relations/REL-1/confirm', { reason });
    await api(ACTORS.cashier).post('/incomes', { accountId: 'W-AGENT', amountMinor: 70000, reason });
    const a1 = await api(ACTORS.legalA).post('/cases/C-1/control-applications', {
      accounts: ['W-A'], limitMinor: 90000, documentId: 'DA', rank: 1, reason,
    });
    await api(ACTORS.legalB).post('/applications/review', { caseId: 'C-1', applicationId: a1.body.id, decision: 'approve', reason });
    const a2 = await api(ACTORS.legalB).post('/cases/C-2/control-applications', {
      accounts: ['W-A', 'W-AGENT'], limitMinor: 60000, documentId: 'DB', rank: 2, reason,
    });
    await api(ACTORS.legalA).post('/applications/review', { caseId: 'C-2', applicationId: a2.body.id, decision: 'approve', reason });
    await api(ACTORS.cashier).post('/payment-batches', {
      idempotencyKey: 'mix-1', items: [{ kind: 'case', businessId: 'C-1', amountMinor: 20000 }], reason,
    });

    const accounts = (await api(ACTORS.legalA).get('/accounts')).body.accounts;
    for (const account of accounts) {
      assert.equal(
        account.freeMinor + account.reservedMinor + account.lockedMinor,
        account.receivedMinor,
        `账户 ${account.accountId} 恒等式破裂`,
      );
      for (const key of ['freeMinor', 'reservedMinor', 'lockedMinor', 'receivedMinor']) {
        assert.ok(account[key] >= 0);
      }
    }
  } finally {
    await harness.stop();
  }
});

test('未携带身份头的请求被拒绝', async () => {
  const harness = await startHarness();
  const anonymous = client(harness.appUrl, null);
  const res = await anonymous.get('/accounts');
  assert.equal(res.status, 401);
  await harness.stop();
});

// 检查五：文书生效区间。控制仅在文书指定的生效区间内有效，到期后自动失效并让位。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, client, ACTORS } from './helpers/harness.mjs';
import { computeAccountView } from '../src/allocation.mjs';

const reason = '演练生效区间检查';

test('控制范围超过 effectiveTo 后不再占用资金，自动让位给后顺位案件', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    await api(ACTORS.cashier).post('/incomes', { accountId: 'W-A', amountMinor: 100000, reason });

    // C-1 控制区间已到期（effectiveTo 在过去）。
    const a1 = await api(ACTORS.legalA).post('/cases/C-1/control-applications', {
      accounts: ['W-A'], limitMinor: 90000, documentId: 'DOC-EXPIRED', rank: 1,
      effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-06-01T00:00:00Z', reason,
    });
    await api(ACTORS.legalB).post('/applications/review', {
      caseId: 'C-1', applicationId: a1.body.id, decision: 'approve', reason,
    });
    // C-2 长期有效。
    const a2 = await api(ACTORS.legalB).post('/cases/C-2/control-applications', {
      accounts: ['W-A'], limitMinor: 60000, documentId: 'DOC-VALID', rank: 2, reason,
    });
    await api(ACTORS.legalA).post('/applications/review', {
      caseId: 'C-2', applicationId: a2.body.id, decision: 'approve', reason,
    });

    const account = (await api(ACTORS.legalA).get('/accounts/W-A')).body;
    const c1 = account.allocations.find(a => a.kind === 'case' && a.caseId === 'C-1');
    const c2 = account.allocations.find(a => a.kind === 'case' && a.caseId === 'C-2');
    assert.equal(c1, undefined); // 到期范围不占用
    assert.equal(c2.amountMinor, 60000); // 后顺位案件获得资金

    // 引擎层：到期判定与未来生效判定一致。
    const state = harness.store.state;
    const expiredScope = state.cases['C-1'].scopes[0];
    assert.equal(computeAccountView(state, 'W-A').allocations.some(a => a.caseId === 'C-1'), false);
    assert.ok(expiredScope.status === 'active'); // 状态仍登记为 active，由区间判定失效
  } finally {
    await harness.stop();
  }
});

test('effectiveFrom 在未来的控制范围暂不占用，到达生效时间后才控制', async () => {
  const harness = await startHarness();
  const api = actor => client(harness.appUrl, actor);
  try {
    const a1 = await api(ACTORS.legalA).post('/cases/C-1/control-applications', {
      accounts: ['W-A'], limitMinor: 50000, documentId: 'DOC-FUTURE', rank: 1,
      effectiveFrom: '2099-01-01T00:00:00Z', reason,
    });
    await api(ACTORS.legalB).post('/applications/review', {
      caseId: 'C-1', applicationId: a1.body.id, decision: 'approve', reason,
    });
    const before = (await api(ACTORS.legalA).get('/accounts/W-A')).body;
    assert.equal(before.allocations.some(a => a.caseId === 'C-1'), false);

    // 用历史时刻视角验证：在 2099 年该范围生效并参与占用（受账户实际资金上限约束）。
    const state = harness.store.state;
    const futureView = computeAccountView(state, 'W-A', '2099-06-01T00:00:00Z');
    const futureClaim = futureView.allocations.find(a => a.caseId === 'C-1');
    assert.ok(futureClaim, '到达生效时间后控制范围应参与资金占用');
    assert.ok(futureClaim.amountMinor > 0);
  } finally {
    await harness.stop();
  }
});

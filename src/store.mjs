import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertInvariants } from './allocation.mjs';
import { seedState } from './seed.mjs';

export function freshState() {
  return {
    version: 1,
    actors: {},
    merchants: {},
    accounts: {},
    relations: {},
    cases: {},
    orders: {},
    incomes: {},
    refunds: {},
    instructions: {},
    batches: {},
    audit: [],
    counters: {},
    sourceChanges: [],
  };
}

// 全部写操作经由单链队列串行提交，从根本上消除并发双花。
export class Store {
  #stateFile;
  #state;
  #chain = Promise.resolve();

  constructor(stateFile, options = {}) {
    this.#stateFile = stateFile;
    try {
      this.#state = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.#state = options.seed === false ? freshState() : seedState(freshState());
      this.persist();
    }
  }

  get state() {
    return this.#state;
  }

  persist() {
    mkdirSync(dirname(this.#stateFile), { recursive: true });
    writeFileSync(this.#stateFile + '.tmp', JSON.stringify(this.#state));
    renameSync(this.#stateFile + '.tmp', this.#stateFile);
  }

  nextId(prefix) {
    this.#state.counters[prefix] = (this.#state.counters[prefix] ?? 0) + 1;
    return `${prefix}-${String(this.#state.counters[prefix]).padStart(6, '0')}`;
  }

  audit(actorId, action, target, reason, detail) {
    this.#state.audit.push({
      id: this.nextId('AUD'),
      at: new Date().toISOString(),
      actorId,
      action,
      target,
      reason,
      detail: detail ?? null,
    });
  }

  // 读操作直接在当前状态上计算（视图均为纯函数）。
  read(fn) {
    return fn(this.#state);
  }

  // 写操作排队执行；提交前强制资金恒等式检查，通过后原子落盘。
  mutate(actorId, action, target, reason, fn) {
    const run = this.#chain.then(() => {
      const detail = fn(this.#state) ?? null;
      assertInvariants(this.#state);
      this.audit(actorId, action, target, reason, detail);
      this.persist();
      return detail;
    });
    // 防止单个事务失败中断整条链。
    this.#chain = run.catch(() => {});
    return run;
  }
}

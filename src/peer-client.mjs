// 本地收单方（合作方）客户端：只负责协议交互，不做业务资格判断。
// 超时/网络错误统一视为“受理结果未明”，由业务侧保持资金锁定。
export class PeerTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PeerTimeoutError';
  }
}

export class PeerProtocolError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PeerProtocolError';
    this.status = status;
  }
}

export class PeerClient {
  #baseUrl;
  #timeoutMs;

  constructor(baseUrl, timeoutMs = 1200) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = timeoutMs;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  // 收单方独立重启到新地址时切换目标，不改变业务侧状态与未明锁定。
  setBaseUrl(baseUrl) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    return this.#baseUrl;
  }

  async #request(method, path, body, idempotencyKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res;
    try {
      res = await fetch(this.#baseUrl + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // 断线、超时、连接拒绝都无法证明对方是否已受理。
      throw new PeerTimeoutError(`收单方交互结果未明：${error.message}`);
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    const text = await res.text();
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    if (!res.ok) throw new PeerProtocolError(payload?.error ?? `收单方返回 ${res.status}`, res.status);
    return payload;
  }

  // 提交一批划付指令；收单方允许部分受理、部分拒绝。
  async submitBatch(batchId, items) {
    return this.#request('POST', '/v1/disbursements', {
      items: items.map(item => ({
        instructionId: item.instructionId,
        reference: item.reference,
        kind: item.kind,
        businessId: item.businessId,
        amountMinor: item.amountMinor,
      })),
    }, batchId);
  }

  // 按平台业务流水（即本地指令编号）查询收单方受理情况。404 表示“未查到”，不是未受理的结论。
  async lookup(instructionId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res;
    try {
      res = await fetch(`${this.#baseUrl}/v1/disbursements/${encodeURIComponent(instructionId)}`, {
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new PeerTimeoutError(`查询收单方超时，结果未明：${error.message}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (res.status === 404) return { found: false };
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    if (!res.ok) throw new PeerProtocolError(payload?.error ?? `收单方返回 ${res.status}`, res.status);
    return { found: true, operation: payload };
  }

  // 测试/演练控制接口：设置收单方逐项行为模式。
  async setRule(instructionId, mode) {
    return this.#request('PUT', '/control/rules', { id: instructionId, mode });
  }

  async settle(instructionId, status, details) {
    return this.#request('POST', '/control/settle', { id: instructionId, status, details: details ?? {} });
  }
}

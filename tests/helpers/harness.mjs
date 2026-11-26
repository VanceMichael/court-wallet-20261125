// 测试辅助：在临时目录中用随机端口拉起“收单方 + 业务服务”，两者独立持久化、可分别重启。
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPeer } from '../../support/peer.mjs';
import { Store } from '../../src/store.mjs';
import { PeerClient } from '../../src/peer-client.mjs';
import { createApp } from '../../src/http.mjs';
import partnerConfig from '../../fixtures/partner.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));

// 进程内实例（速度快，单测使用）。
export async function startHarness({ seed = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'court-wallet-'));
  const peerState = join(dir, 'partner.json');
  const appState = join(dir, 'app-state.json');

  const peerServer = createPeer(partnerConfig, peerState);
  const peerUrl = await listen(peerServer);
  const peer = new PeerClient(peerUrl, 800);

  const store = new Store(appState, seed === false ? { seed: false } : {});
  const app = createApp(store, peer);
  const appUrl = await listen(app);

  const appRef = { current: app };
  const storeRef = { current: store };

  // 仅重启业务服务（收单方保持运行），验证持久化与未明状态保留。
  const restartApp = async () => {
    await close(appRef.current);
    const store2 = new Store(appState);
    const app2 = createApp(store2, peer);
    const url2 = await listen(app2);
    appRef.current = app2;
    storeRef.current = store2;
    return { url: url2, store: store2 };
  };

  // 仅重启收单方（业务服务保持运行）；随机端口并切换应用客户端地址，可换状态文件模拟空流水。
  const peerServerRef = { current: peerServer };
  const restartPeer = async ({ stateFile = peerState } = {}) => {
    await close(peerServerRef.current);
    const next = createPeer(partnerConfig, stateFile);
    const nextUrl = await listen(next);
    peerServerRef.current = next;
    peer.setBaseUrl(nextUrl);
    return nextUrl;
  };

  return {
    dir, appUrl, peerUrl,
    get store() { return storeRef.current; },
    peer,
    stop: async () => {
      await close(appRef.current);
      await close(peerServerRef.current);
      await rm(dir, { recursive: true, force: true });
    },
    restartApp, restartPeer, app: appRef, peerServer: peerServerRef,
  };
}

export function client(baseUrl, actorId) {
  const call = async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Connection: 'close',
        ...(actorId ? { 'x-actor-id': actorId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    const jsonBody = text ? JSON.parse(text) : {};
    return { status: res.status, body: jsonBody };
  };
  return {
    get: path => call('GET', path),
    post: (path, body) => call('POST', path, body),
    raw: call,
  };
}

export const ACTORS = {
  legalA: 'legal-a',
  legalB: 'legal-b',
  cashier: 'cashier',
  supportA: 'support-a',
};

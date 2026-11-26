import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Store } from './store.mjs';
import { PeerClient } from './peer-client.mjs';
import { createApp } from './http.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// 平台服务与本地收单方分别持久化、可分别重启。
// 若未设置 PEER_URL，则由本进程拉起一个内置收单方子进程（独立状态文件）。
async function waitForPeer(peer, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(peer.baseUrl + '/health');
      if (res.ok) return true;
    } catch { /* 未就绪，继续等待 */ }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('收单方在约定时间内未就绪');
}

async function main() {
  const port = Number(process.env.PORT ?? 4318);
  const stateFile = process.env.APP_STATE ?? join(root, '.local', 'app-state.json');
  const dataDir = dirname(stateFile);
  mkdirSync(dataDir, { recursive: true });

  let peerProcess = null;
  let peerUrl = process.env.PEER_URL;
  if (!peerUrl) {
    const peerPort = Number(process.env.PEER_PORT ?? 4317);
    const peerState = process.env.PEER_STATE ?? join(root, '.local', 'partner.json');
    mkdirSync(dirname(peerState), { recursive: true });
    peerProcess = spawn(process.execPath, [join(root, 'support', 'peer.mjs')], {
      cwd: root,
      env: { ...process.env, PORT: String(peerPort), PARTNER_STATE: peerState },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    peerUrl = `http://127.0.0.1:${peerPort}`;
  }

  const peer = new PeerClient(peerUrl, Number(process.env.PEER_TIMEOUT_MS ?? 1500));
  await waitForPeer(peer);

  const store = new Store(stateFile);
  const server = createApp(store, peer);

  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({
      message: '协助执行资金控制服务已启动',
      port,
      stateFile,
      peerUrl,
      embeddedPeer: peerProcess !== null,
      hint: '身份通过请求头 x-actor-id 传递，可选 legal-a / legal-b / cashier / support-a',
    }));
  });

  const shutdown = () => {
    server.close(() => {
      if (peerProcess) peerProcess.kill();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.message, stack: error.stack }));
  process.exit(1);
});

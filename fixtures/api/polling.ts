/**
 * 常驻请求夹具的接口（PRD 9.3，FR-14）：每秒轮询的 tick 接口 + 服务端定时推送的 WebSocket。
 *
 * - GET /api/polling/tick?hold=毫秒：服务端计数加一，hold 毫秒后返回 {tick}（hold 让请求一直挂着，模拟网络永不空闲）。
 * - WS /api/polling/ws?interval=毫秒：每 interval 毫秒（默认 200）推一条文本消息 {seq}。
 *   只做服务端推送：握手用 node:crypto 手写，不加依赖；客户端发来的帧一律不解析，只看是不是关闭帧。
 */
import { createHash } from 'node:crypto';
import type { FixtureHandler, UpgradeHandler } from '../server.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let ticks = 0;

const tick: FixtureHandler = async ({ url, res, json }) => {
  const hold = Math.min(10_000, Math.max(0, Number(url.searchParams.get('hold')) || 0));
  const n = ++ticks;
  if (hold) await new Promise((r) => setTimeout(r, hold));
  if (res.destroyed) return;
  json({ tick: n });
};

const ws: UpgradeHandler = (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    return;
  }
  const interval = Math.max(
    20,
    Number(new URL(req.url ?? '/', 'http://x').searchParams.get('interval')) || 200,
  );
  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let seq = 0;
  const stop = () => clearInterval(timer);
  const timer = setInterval(() => {
    const payload = Buffer.from(JSON.stringify({ seq: ++seq }));
    // 服务端文本帧：FIN=1、opcode=1、不加掩码，payload 远小于 126 字节
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  }, interval);
  socket.on('close', stop);
  socket.on('error', stop);
  socket.on('data', (chunk: Buffer) => {
    if (((chunk[0] ?? 0) & 0x0f) === 0x8) {
      stop();
      socket.end();
    }
  });
};

export const routes: Record<string, FixtureHandler> = {
  '/api/polling/tick': tick,
};

export const upgrades: Record<string, UpgradeHandler> = {
  '/api/polling/ws': ws,
};

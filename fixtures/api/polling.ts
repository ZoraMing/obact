/**
 * 常驻请求夹具的接口（PRD 9.3，FR-14）：每秒轮询的 tick 接口 + 服务端定时推送的 WebSocket。
 *
 * - GET /api/polling/tick?hold=毫秒：服务端计数加一，hold 毫秒后返回 {tick}（hold 用来让请求一直挂着，
 *   模拟网络永不空闲）。
 * - GET /api/polling/stats：{ticks, ws_open, ws_connections, ws_sent, ws_received}，供测试核对“请求确实在进行”。
 * - WS /api/polling/ws?interval=毫秒&seed=：每 interval 毫秒（默认 200）推一条 {type:'push', seq, value}；
 *   收到文本 {type:'echo', text} 时回 {type:'echo', text}。value 由 seed 与 seq 决定，结果确定。
 *
 * WebSocket 用 node:crypto 手写握手与帧（RFC 6455），不加依赖：只支持文本帧、ping/pong、close，
 * 客户端分片消息按 continuation 拼接。
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FixtureHandler, UpgradeHandler } from '../server.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const stats = { ticks: 0, wsOpen: 0, wsConnections: 0, wsSent: 0, wsReceived: 0 };

/** seq 条推送的值：由 seed 与 seq 决定（100.0 ~ 199.9）。 */
export function pushValue(seed: number, seq: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(seq | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = (h ^ (h >>> 12)) >>> 0;
  return 100 + (h % 1000) / 10;
}

/** 组一个服务端帧（不加掩码，FIN=1）。 */
export function wsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 0x10000) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

type Frame = { fin: boolean; opcode: number; payload: Buffer };

/** 从缓冲区解析出完整的帧（客户端帧带掩码），返回帧与剩余字节。 */
export function wsParse(buf: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off] as number;
    const b1 = buf[off + 1] as number;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < p + maskLen + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    p += maskLen;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask)
      for (let i = 0; i < len; i++) payload[i] = (payload[i] as number) ^ (mask[i & 3] as number);
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

const ws: UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const interval = Math.max(20, Number(url.searchParams.get('interval')) || 200);
  const seed = Number(url.searchParams.get('seed')) || 1;
  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  );
  (socket as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);
  stats.wsOpen++;
  stats.wsConnections++;

  let open = true;
  let seq = 0;
  let buf: Buffer = Buffer.alloc(0);
  let partial: Buffer[] = [];
  const send = (opcode: number, payload: Buffer) => {
    if (!open || socket.destroyed) return;
    socket.write(wsFrame(opcode, payload));
  };
  const sendJson = (data: unknown) => {
    send(0x1, Buffer.from(JSON.stringify(data)));
    stats.wsSent++;
  };
  const timer = setInterval(() => {
    seq++;
    sendJson({ type: 'push', seq, value: pushValue(seed, seq) });
  }, interval);
  const shut = () => {
    if (!open) return;
    open = false;
    clearInterval(timer);
    stats.wsOpen--;
  };
  const onMessage = (text: string) => {
    stats.wsReceived++;
    let msg: { type?: string; text?: unknown } = {};
    try {
      msg = JSON.parse(text);
    } catch {
      msg = { type: 'echo', text };
    }
    if (msg.type === 'echo') sendJson({ type: 'echo', text: String(msg.text ?? '') });
  };
  const onData = (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const { frames, rest } = wsParse(buf);
    buf = rest;
    for (const f of frames) {
      if (f.opcode === 0x8) {
        // 关闭：回一个关闭帧后结束连接
        send(0x8, f.payload.subarray(0, 2));
        shut();
        socket.end();
        return;
      }
      if (f.opcode === 0x9) send(0xa, f.payload);
      else if (f.opcode === 0x1 || f.opcode === 0x0) {
        partial.push(f.payload);
        if (f.fin) {
          const text = Buffer.concat(partial).toString('utf8');
          partial = [];
          onMessage(text);
        }
      }
    }
  };
  socket.on('data', onData);
  socket.on('error', () => {
    shut();
    socket.destroy();
  });
  socket.on('end', () => {
    shut();
    socket.end();
  });
  socket.on('close', shut);
  if (head?.length) onData(head);
};

const tick: FixtureHandler = async ({ url, res, json }) => {
  const hold = Math.min(10_000, Math.max(0, Number(url.searchParams.get('hold')) || 0));
  const n = ++stats.ticks;
  if (hold) await new Promise((r) => setTimeout(r, hold));
  if (res.destroyed) return;
  json({ tick: n });
};

export const routes: Record<string, FixtureHandler> = {
  '/api/polling/tick': tick,
  '/api/polling/stats': ({ json }) =>
    json({
      ticks: stats.ticks,
      ws_open: stats.wsOpen,
      ws_connections: stats.wsConnections,
      ws_sent: stats.wsSent,
      ws_received: stats.wsReceived,
    }),
};

export const upgrades: Record<string, UpgradeHandler> = {
  '/api/polling/ws': ws,
};

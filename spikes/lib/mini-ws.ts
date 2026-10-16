// 预研用最小 WebSocket 服务端（只处理短文本帧），避免为预研引入依赖。正式实现用成熟库。
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

export type WsMessage = { origin: string | undefined; text: string; reply: (text: string) => void };

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const head = Buffer.alloc(4);
  head[0] = 0x81;
  head[1] = 126;
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

function parse(buf: Buffer): string | null {
  if (buf.length < 2) return null;
  let len = (buf[1] as number) & 0x7f;
  let offset = 2;
  if (len === 126) {
    len = buf.readUInt16BE(2);
    offset = 4;
  }
  const mask = buf.subarray(offset, offset + 4);
  const data = buf.subarray(offset + 4, offset + 4 + len);
  return Buffer.from(data.map((b, i) => b ^ (mask[i % 4] as number))).toString();
}

export async function serveWs(port: number, onMessage: (m: WsMessage) => void): Promise<Server> {
  const server = createServer((_req, res) => res.writeHead(426).end());
  server.on('upgrade', (req, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on('error', () => {}); // 浏览器关闭时连接被重置，忽略
    socket.on('data', (buf: Buffer) => {
      const text = parse(buf);
      if (text !== null) {
        onMessage({ origin: req.headers.origin, text, reply: (t) => socket.write(frame(t)) });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

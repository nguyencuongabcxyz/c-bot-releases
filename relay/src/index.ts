// The relay for C-Bot's shared chats over the internet. A host's C-Bot opens a room
// (/room/<id>?as=host) and its guests join it (?as=guest); the room passes bytes between them:
//
//   host  <-> relay   binary frames: a 4-byte peer number (big-endian), then the bytes
//                     text frames:   {"t":"open","peer":n,"ip":"…"} when a guest comes,
//                                    {"t":"close","peer":n} when one goes (either way)
//   guest <-> relay   binary frames: just the bytes
//
// The bytes are a TLS session between the two C-Bots (the guest checks the host's certificate
// against the fingerprint in its invite link), so the relay never sees what's said. It only
// keeps the room small and short-lived.

import { DurableObject } from 'cloudflare:workers';

type Env = { ROOMS: DurableObjectNamespace<Room> };

/** Guests in a room at once (C-Bot lets three in; a few more may be knocking). */
const GUESTS_MAX = 6;
/** A room lasts this long at most, from when its host opens it. */
const ROOM_MS = 2 * 60 * 60 * 1000;
/** The biggest frame a guest may send (it only sends suggestions, in TLS records). */
const GUEST_FRAME_MAX = 64 * 1024;
const ROOM_ID = /^[0-9a-f]{32}$/;

/** What a socket is, kept with it (so it survives the room sleeping between messages). */
type Tag = { role: 'host' } | { role: 'guest'; peer: number; ip: string };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!m) return new Response('C-Bot relay\n', { status: url.pathname === '/' ? 200 : 404 });
    const [, id] = m;
    const role = url.searchParams.get('as');
    if (!ROOM_ID.test(id) || (role !== 'host' && role !== 'guest')) return new Response('Bad room\n', { status: 400 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket only\n', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(req);
  },
};

export class Room extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).searchParams.get('as');
    const host = this.host();
    if (role === 'host' && host) return new Response('This room has a host\n', { status: 409 });
    if (role === 'guest' && !host) return new Response('No such share (it may have stopped)\n', { status: 404 });
    if (role === 'guest' && this.ctx.getWebSockets('guest').length >= GUESTS_MAX)
      return new Response('This share is full\n', { status: 429 });

    const [client, server] = Object.values(new WebSocketPair());
    if (role === 'host') {
      this.ctx.acceptWebSocket(server, ['host']);
      server.serializeAttachment({ role: 'host' } satisfies Tag);
      await this.ctx.storage.setAlarm(Date.now() + ROOM_MS);
    } else {
      const peer = ((await this.ctx.storage.get<number>('peer')) ?? 0) + 1;
      await this.ctx.storage.put('peer', peer);
      const ip = req.headers.get('CF-Connecting-IP') ?? '';
      this.ctx.acceptWebSocket(server, ['guest']);
      server.serializeAttachment({ role: 'guest', peer, ip } satisfies Tag);
      host?.send(JSON.stringify({ t: 'open', peer, ip }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    const tag = ws.deserializeAttachment() as Tag;
    if (tag.role === 'guest') return this.fromGuest(ws, tag.peer, msg);
    if (typeof msg === 'string') return this.hostSays(msg);
    if (msg.byteLength < 4) return;
    const peer = new DataView(msg).getUint32(0);
    this.guest(peer)?.send(msg.slice(4));
  }

  private fromGuest(ws: WebSocket, peer: number, msg: string | ArrayBuffer) {
    if (typeof msg === 'string' || msg.byteLength > GUEST_FRAME_MAX) {
      ws.close(1008, 'Not allowed'); // (its close tells the host: webSocketClose)
      return;
    }
    const frame = new Uint8Array(4 + msg.byteLength);
    new DataView(frame.buffer).setUint32(0, peer);
    frame.set(new Uint8Array(msg), 4);
    this.host()?.send(frame);
  }

  /** The host closing one guest's connection (it left, was refused, or was let go). */
  private hostSays(text: string) {
    let m: { t?: string; peer?: number };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.t === 'close' && typeof m.peer === 'number') this.guest(m.peer)?.close(1000, 'Closed by the host');
  }

  async webSocketClose(ws: WebSocket) {
    try {
      ws.close(1000); // (its side of the closing handshake)
    } catch {
      // (already closed)
    }
    const tag = ws.deserializeAttachment() as Tag;
    if (tag.role === 'guest') return this.closed(tag.peer);
    await this.end('The host left');
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  /** The room's time is up. */
  async alarm() {
    await this.end('The share ran out of time');
  }

  private closed(peer: number) {
    this.host()?.send(JSON.stringify({ t: 'close', peer }));
  }

  private async end(why: string) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, why);
      } catch {
        // (already closing)
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  private host(): WebSocket | undefined {
    return this.ctx.getWebSockets('host').find((ws) => ws.readyState === WebSocket.OPEN);
  }

  private guest(peer: number): WebSocket | undefined {
    return this.ctx.getWebSockets('guest').find((ws) => (ws.deserializeAttachment() as Tag & { peer?: number }).peer === peer);
  }
}

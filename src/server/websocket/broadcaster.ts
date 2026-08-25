import { WebSocket } from 'ws';
import type { WSEvent } from './events.js';
import { logger } from '../logging/logger.js';

// Binary frame format for high-frequency PTY output:
//   byte 0:           kind (0x01 = session output)
//   byte 1:           sessionId UTF-8 byte length (max 255)
//   bytes 2..2+L-1:   sessionId bytes
//   bytes 2+L..end:   payload (raw PTY chunk, UTF-8)
//
// Kept binary (not base64+JSON) so spinner-frequency output doesn't
// inflate by ~33% and bypass the JSON.stringify hot path.
export const BINARY_FRAME_SESSION_OUTPUT = 0x01;

export function encodeSessionFrame(sessionId: string, payload: Buffer | Uint8Array | string): Buffer {
  const sidBytes = Buffer.from(sessionId, 'utf8');
  if (sidBytes.length > 255) throw new Error('sessionId too long for binary frame');
  const payloadBuf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const out = Buffer.alloc(2 + sidBytes.length + payloadBuf.length);
  out[0] = BINARY_FRAME_SESSION_OUTPUT;
  out[1] = sidBytes.length;
  sidBytes.copy(out, 2);
  payloadBuf.copy(out, 2 + sidBytes.length);
  return out;
}

class Broadcaster {
  private clients: Set<WebSocket> = new Set();
  private subscriptions: WeakMap<WebSocket, Set<string>> = new WeakMap();

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
    this.subscriptions.delete(ws);
  }

  /** Subscribe a client to high-frequency binary output for a sessionId. */
  subscribe(ws: WebSocket, sessionId: string): void {
    let set = this.subscriptions.get(ws);
    if (!set) {
      set = new Set();
      this.subscriptions.set(ws, set);
    }
    set.add(sessionId);
  }

  unsubscribe(ws: WebSocket, sessionId: string): void {
    const set = this.subscriptions.get(ws);
    if (!set) return;
    set.delete(sessionId);
  }

  isSubscribed(ws: WebSocket, sessionId: string): boolean {
    return !!this.subscriptions.get(ws)?.has(sessionId);
  }

  broadcast(event: WSEvent): void {
    let data: string;
    try {
      data = JSON.stringify(event);
    } catch (err) {
      // Serialization failure means the event is lost for every client — one of
      // the few WebSocket conditions that is worth an ERROR line.
      logger.error('ws.serialize-failed', {
        scope: '[ws]',
        msg: `could not serialize "${event?.type ?? 'unknown'}" event`,
        eventType: event?.type,
        err,
      });
      return;
    }
    logger.debug('ws.broadcast', { scope: '[ws]', msg: `broadcast ${event.type}`, eventType: event.type, clients: this.clients.size });
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(data);
      } catch (err) {
        logger.warn('ws.broadcast-failed', {
          scope: '[ws]',
          msg: `broadcast to one client failed (${event.type})`,
          eventType: event.type,
          err,
        });
      }
    }
  }

  /** Send a pre-encoded binary frame only to clients subscribed to sessionId. */
  sendBinaryToSubscribers(sessionId: string, frame: Buffer): void {
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (!this.isSubscribed(client, sessionId)) continue;
      // Drop subscribers that have backed up too far (e.g. tab in background).
      if (client.bufferedAmount > 4 * 1024 * 1024) {
        this.unsubscribe(client, sessionId);
        continue;
      }
      client.send(frame, { binary: true });
    }
  }

  /** Send a JSON event only to clients subscribed to sessionId. */
  sendJsonToSubscribers(sessionId: string, event: WSEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (!this.isSubscribed(client, sessionId)) continue;
      client.send(data);
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }
}

export const broadcaster = new Broadcaster();

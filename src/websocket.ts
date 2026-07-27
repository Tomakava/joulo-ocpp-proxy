import WebSocket from "ws";

export function forwardPing(ws: WebSocket | null, data: Buffer): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  try {
    ws.ping(data);
  } catch {
    /* best-effort — peer may have just closed */
  }
}

export function forwardPong(ws: WebSocket | null, data: Buffer): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  try {
    ws.pong(data);
  } catch {
    /* best-effort — peer may have just closed */
  }
}

export function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (Buffer.isBuffer(data)) return data.toString();
  return Buffer.from(data).toString();
}

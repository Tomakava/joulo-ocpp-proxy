import WebSocket from "ws";
import { createLogger } from "./logger";
import {
  OCPP_MSG_CALL,
  OCPP_MSG_CALLERROR,
  OCPP_MSG_CALLRESULT,
  OCPP_SUBPROTOCOLS,
  type OcppMessageType,
  type ParsedMessage,
} from "./types";

/**
 * Manages the full lifecycle of a single charger connection:
 *
 *   Charger  ←─→  Proxy  ←─→  Primary CSMS
 *                         ──→  Secondary CSMS (mirror, one-way)
 *
 * - All messages from the charger are forwarded to the primary; only
 *   CALL messages are mirrored to secondaries.
 * - Only the primary CSMS can send commands back to the charger.
 * - Secondary connections are best-effort; failures never affect the
 *   charger or the primary link. Secondaries auto-reconnect, send
 *   periodic keepalive pings, and buffer a small bounded queue of
 *   messages while reconnecting so brief blips don't lose data.
 */

function forwardPing(ws: WebSocket | null, data: Buffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.ping(data);
  } catch {
    /* best-effort — peer may have just closed */
  }
}

function forwardPong(ws: WebSocket | null, data: Buffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.pong(data);
  } catch {
    /* best-effort — peer may have just closed */
  }
}

const SECONDARY_RECONNECT_DELAY_MS = 10_000;
const SECONDARY_KEEPALIVE_INTERVAL_MS = 30_000;
const SECONDARY_PONG_TIMEOUT_MS = 90_000;
const SECONDARY_MAX_QUEUE = 100;

interface SecondaryState {
  url: string;
  ws: WebSocket | null;
  queue: ParsedMessage[];
  keepalive: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastPongAt: number;
}

export class ChargerConnection {
  private readonly log;
  private primary: WebSocket | null = null;
  private secondaries: SecondaryState[] = [];
  private alive = true;

  constructor(
    private readonly charger: WebSocket,
    private readonly chargePointId: string,
    private readonly primaryUrl: string,
    private readonly secondaryUrls: string[],
    private readonly protocol: string,
    private readonly authHeader: string | undefined,
    private readonly logMaxMessageLength: number,
    private readonly endCallback?: () => void
  ) {
    this.log = createLogger(chargePointId);
    this.setup();
  }

  private setup() {
    this.primary = this.connectPrimary(this.primaryUrl);

    for (const url of this.secondaryUrls) {
      const state: SecondaryState = {
        url,
        ws: null,
        queue: [],
        keepalive: null,
        reconnectTimer: null,
        lastPongAt: Date.now(),
      };
      this.secondaries.push(state);
      state.ws = this.connectSecondary(state);
    }

    this.charger.on("message", (data) => {
      const raw = data.toString();
      const msg = this.decode(raw);
      this.log.debug("charger → proxy", { message: this.summarise(msg || raw) });

      if (this.primary?.readyState === WebSocket.OPEN) {
        this.primary.send(raw);
      }

      if (msg?.type === OCPP_MSG_CALL) {
        for (const sec of this.secondaries) {
          if (!this.sendToSecondary(sec, msg)) {
            this.enqueueForSecondary(sec, msg);
          }
        }
      }
    });

    this.charger.on("close", (code, reason) => {
      this.log.info("charger disconnected", {
        code,
        reason: reason.toString(),
      });
      this.teardown();
    });

    this.charger.on("error", (err) => {
      this.log.error("charger connection error", { error: err.message });
    });

    this.charger.on("ping", (data) => {
      forwardPing(this.primary, data);
    });

    this.charger.on("pong", (data) => {
      forwardPong(this.primary, data);
    });

    this.log.info("session started", {
      primary: this.primaryUrl,
      secondaries: this.secondaryUrls,
      protocol: this.protocol,
    });
  }

  /**
   * Connect to the primary CSMS. The primary is bidirectional: its
   * responses are forwarded back to the charger, and a primary failure
   * tears the whole session down (chargers expect to talk to exactly one
   * CSMS at a time).
   */
  private connectPrimary(baseUrl: string): WebSocket {
    const url = `${baseUrl.replace(/\/+$/, "")}/${this.chargePointId}`;

    const ws = new WebSocket(
      url,
      this.protocol ? [this.protocol] : OCPP_SUBPROTOCOLS,
      {
        headers: this.buildHeaders(),
        handshakeTimeout: 10_000,
        autoPong: false,
      }
    );

    ws.on("open", () => {
      this.log.info("primary connected", { url });
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      const msg = this.decode(raw);
      this.log.debug("primary → charger", { message: this.summarise(msg || raw) });
      if (this.charger.readyState === WebSocket.OPEN) {
        this.charger.send(raw);
      }
    });

    ws.on("close", (code, reason) => {
      this.log.warn("primary disconnected", {
        url,
        code,
        reason: reason.toString(),
      });
      this.charger.close(1001, "Primary CSMS disconnected");
      this.teardown();
    });

    ws.on("error", (err) => {
      this.log.error("primary error", { url, error: err.message });
      if (this.alive) {
        this.charger.close(1011, "Primary CSMS unreachable");
        this.teardown();
      }
    });

    ws.on("ping", (data) => forwardPing(this.charger, data));
    ws.on("pong", (data) => forwardPong(this.charger, data));

    return ws;
  }

  /**
   * Connect (or reconnect) a secondary CSMS. Secondaries are one-way
   * mirrors: their responses are logged and discarded. They auto-reconnect
   * on disconnect/error and send periodic keepalive pings so idle
   * connections aren't dropped by intermediaries.
   */
  private connectSecondary(state: SecondaryState): WebSocket {
    const url = `${state.url.replace(/\/+$/, "")}/${this.chargePointId}`;

    const ws = new WebSocket(
      url,
      this.protocol ? [this.protocol] : OCPP_SUBPROTOCOLS,
      {
        headers: this.buildHeaders(),
        handshakeTimeout: 10_000,
      }
    );

    ws.on("open", () => {
      this.log.info("secondary connected", { url });
      state.lastPongAt = Date.now();
      this.flushSecondaryQueue(state);
      this.startSecondaryKeepalive(state, ws);
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      if (raw === "__pong__") {
        state.lastPongAt = Date.now();
        return;
      }
      const msg = this.decode(raw);
      this.log.debug("secondary response (ignored)", {
        url,
        message: this.summarise(msg || raw),
      });
    });

    ws.on("pong", () => {
      state.lastPongAt = Date.now();
    });

    ws.on("close", (code, reason) => {
      this.log.warn("secondary disconnected", {
        url,
        code,
        reason: reason.toString(),
      });
      this.stopSecondaryKeepalive(state);
      this.scheduleSecondaryReconnect(state);
    });

    ws.on("error", (err) => {
      this.log.error("secondary error", { url, error: err.message });
    });

    return ws;
  }

  private sendToSecondary(state: SecondaryState, msg: ParsedMessage): boolean {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.log.debug("proxy → secondary", { url: state.url, message: this.summarise(msg) });
      state.ws.send(this.serialize(msg));
      return true;
    } catch {
      return false;
    }
  }

  private enqueueForSecondary(state: SecondaryState, msg: ParsedMessage) {
    if (state.queue.length >= SECONDARY_MAX_QUEUE) {
      state.queue.shift();
      this.log.warn("secondary queue full, dropping oldest message", {
        url: state.url,
        max: SECONDARY_MAX_QUEUE,
      });
    }
    state.queue.push(msg);
  }

  private flushSecondaryQueue(state: SecondaryState) {
    if (state.queue.length === 0) return;
    this.log.info("secondary flushing queued messages", {
      url: state.url,
      count: state.queue.length,
    });
    for (const msg of state.queue) {
      this.sendToSecondary(state, msg);
    }
    state.queue = [];
  }

  private startSecondaryKeepalive(state: SecondaryState, ws: WebSocket) {
    this.stopSecondaryKeepalive(state);
    state.keepalive = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      if (Date.now() - state.lastPongAt > SECONDARY_PONG_TIMEOUT_MS) {
        this.log.warn("secondary pong timeout, forcing reconnect", {
          url: state.url,
        });
        try { ws.close(4000, "pong timeout"); } catch { /* */ }
        return;
      }

      try {
        ws.ping();
      } catch {
        /* best-effort */
      }
    }, SECONDARY_KEEPALIVE_INTERVAL_MS);
  }

  private stopSecondaryKeepalive(state: SecondaryState) {
    if (state.keepalive !== null) {
      clearInterval(state.keepalive);
      state.keepalive = null;
    }
  }

  private scheduleSecondaryReconnect(state: SecondaryState) {
    if (!this.alive) return;
    if (state.reconnectTimer !== null) return;

    this.log.info("secondary reconnecting", {
      url: state.url,
      delayMs: SECONDARY_RECONNECT_DELAY_MS,
    });

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (!this.alive) return;
      state.ws = this.connectSecondary(state);
    }, SECONDARY_RECONNECT_DELAY_MS);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }
    return headers;
  }

  teardown() {
    if (!this.alive) return;
    this.alive = false;

    for (const sec of this.secondaries) {
      this.stopSecondaryKeepalive(sec);
      if (sec.reconnectTimer !== null) {
        clearTimeout(sec.reconnectTimer);
        sec.reconnectTimer = null;
      }
      sec.queue = [];
    }

    const close = (ws: WebSocket | null) => {
      if (ws && ws.readyState <= WebSocket.OPEN) {
        ws.close(1000);
      }
    };

    close(this.primary);
    for (const sec of this.secondaries) close(sec.ws);
    close(this.charger);

    this.log.info("session ended");
    this.endCallback?.();
  }

  /** Parse a raw WebSocket frame into a structured OCPP message, or null if the frame is not valid OCPP JSON. */
  private decode(raw: string): ParsedMessage | null {
    try {
      const arr = JSON.parse(raw) as unknown[];
      if (!Array.isArray(arr) || arr.length < 3) return null;
      const type = arr[0] as OcppMessageType;
      const id = arr[1] as string;
      if (type === OCPP_MSG_CALL) {
        return { type, id, action: arr[2] as string, payload: arr[3] };
      }
      if (type === OCPP_MSG_CALLRESULT) {
        return { type, id, payload: arr[2] };
      }
      if (type === OCPP_MSG_CALLERROR) {
        return { type, id, errorCode: arr[2] as string, errorDescription: arr[3] as string, errorDetails: arr[4] };
      }
      return null;
    } catch {
      return null;
    }
  }

  private serialize(msg: ParsedMessage): string {
    if (msg.type === OCPP_MSG_CALL) return JSON.stringify([msg.type, msg.id, msg.action, msg.payload ?? {}]);
    if (msg.type === OCPP_MSG_CALLRESULT) return JSON.stringify([msg.type, msg.id, msg.payload ?? {}]);
    return JSON.stringify([msg.type, msg.id, msg.errorCode, msg.errorDescription, msg.errorDetails ?? {}]);
  }

  /** Return a short human-readable label for logging. Accepts a parsed message or a raw string fallback. */
  private summarise(msg: ParsedMessage | string): string {
    const max = this.logMaxMessageLength;
    if (typeof msg === "string") return msg.slice(0, max);
    if (msg.type === OCPP_MSG_CALL) {
      const detail = JSON.stringify(msg.payload ?? {}).slice(0, max);
      return `[CALL] ${msg.action} (${msg.id}) ${detail}`;
    }
    if (msg.type === OCPP_MSG_CALLRESULT) {
      const detail = JSON.stringify(msg.payload ?? {}).slice(0, max);
      return `[RESULT] (${msg.id}) ${detail}`;
    }
    return `[ERROR] (${msg.id}) ${msg.errorCode}: ${msg.errorDescription}`;
  }
}

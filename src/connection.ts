import WebSocket from "ws";
import { createLogger } from "./logger";
import type { SecondaryChargerMap } from "./config";
import type { StateStore } from "./state";
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
 * - Each secondary may use a different charger ID (URL path) and
 *   credentials, configured via the charger_map in the config file.
 * - OCPP 1.6 StartTransaction assigns a transactionId per-CSMS; the
 *   proxy maps primary transactionIds to secondary transactionIds so
 *   MeterValues and StopTransaction reach the correct transaction.
 * - BootNotification chargePointSerialNumber is rewritten to the mapped
 *   charger ID when a secondary uses a different identity.
 * - A hardcoded idTag can be configured per secondary charger (via id_tag in the
 *   charger_map). When set it is substituted into every StartTransaction mirrored
 *   to that secondary.
 * - CALLs from a secondary are either forwarded to the charger (SECONDARY_FORWARDED_ACTIONS),
 *   rejected with {status:"Rejected"} (SECONDARY_REJECTED_ACTIONS), or rejected with a
 *   NotSupported CallError for unknown actions.
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

// CALL actions from a secondary that are forwarded to the charger.
const SECONDARY_FORWARDED_ACTIONS = new Set(["TriggerMessage", "GetConfiguration"]);

// Known CSMS→charger actions that the proxy refuses to relay.
// Replied to with a CALLRESULT {status:"Rejected"} so the secondary receives a
// well-formed OCPP response rather than a generic NotSupported error.
const SECONDARY_REJECTED_ACTIONS = new Set([
  "CancelReservation",
  "ChangeAvailability",
  "ChangeConfiguration",
  "ClearCache",
  "ClearChargingProfile",
  "DataTransfer",
  "GetCompositeSchedule",
  "GetDiagnostics",
  "GetLocalListVersion",
  "RemoteStartTransaction",
  "RemoteStopTransaction",
  "ReserveNow",
  "Reset",
  "SendLocalList",
  "SetChargingProfile",
  "UnlockConnector",
  "UpdateFirmware",
]);

interface SecondaryState {
  url: string;
  mappedChargerId: string;
  password?: string;
  ws: WebSocket | null;
  queue: ParsedMessage[];
  keepalive: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastPongAt: number;
  // primary txId (as string) → secondary txId (as string)
  txIdMap: Map<string, string>;
  // msgId → secondary txId, held until the primary txId for that msgId is known
  pendingSecondaryTxIds: Map<string, string>;
  // hardcoded idTag from config; substituted into every StartTransaction mirrored to this secondary
  idTag?: string;
}

export class ChargerConnection {
  private readonly log;
  private primary: WebSocket | null = null;
  private secondaries: SecondaryState[] = [];
  private alive = true;

  // Tracks message IDs for in-flight StartTransaction CALLs
  private pendingStartTxMsgIds = new Set<string>();
  // msgId → primary-assigned transactionId (string), populated on primary CALLRESULT
  private primaryTxIdByMsgId = new Map<string, string>();
  // msgId → secondary that forwarded the CALL to the charger; reply goes back there only
  private readonly pendingSecondaryCallIds = new Map<string, SecondaryState>();

  constructor(
    private readonly charger: WebSocket,
    private readonly chargePointId: string,
    private readonly primaryUrl: string,
    private readonly secondaryUrls: string[],
    private readonly protocol: string,
    private readonly authHeader: string | undefined,
    private readonly logMaxMessageLength: number,
    private readonly secondaryChargerMap: SecondaryChargerMap,
    private readonly store: StateStore,
    private readonly endCallback?: () => void
  ) {
    this.log = createLogger(chargePointId);
    this.setup();
  }

  private setup() {
    this.primary = this.connectPrimary(this.primaryUrl);

    for (const url of this.secondaryUrls) {
      const mapping = this.secondaryChargerMap.get(url)?.get(this.chargePointId);
      const state: SecondaryState = {
        url,
        mappedChargerId: mapping?.chargerId ?? this.chargePointId,
        password: mapping?.password,
        idTag: mapping?.idTag,
        ws: null,
        queue: [],
        keepalive: null,
        reconnectTimer: null,
        lastPongAt: Date.now(),
        txIdMap: this.store.get(this.chargePointId, url),
        pendingSecondaryTxIds: new Map(),
      };
      this.secondaries.push(state);
      state.ws = this.connectSecondary(state);
    }

    this.charger.on("message", (data) => {
      const raw = data.toString();
      const msg = this.decode(raw);
      this.log.debug("charger → proxy", { message: this.summarise(msg || raw) });

      if (msg?.type === OCPP_MSG_CALL && msg.action === "StartTransaction") {
        this.pendingStartTxMsgIds.add(msg.id);
      }

      // Route replies to secondary-originated CALLs back to that secondary only.
      if (msg?.type === OCPP_MSG_CALLRESULT || msg?.type === OCPP_MSG_CALLERROR) {
        const sec = this.pendingSecondaryCallIds.get(msg.id);
        if (sec) {
          this.pendingSecondaryCallIds.delete(msg.id);
          this.log.debug("charger → secondary", { url: sec.url, message: this.summarise(msg) });
          if (sec.ws?.readyState === WebSocket.OPEN) {
            try { sec.ws.send(raw); } catch { /* best-effort */ }
          }
          return;
        }
      }

      if (this.primary?.readyState === WebSocket.OPEN) {
        this.primary.send(raw);
      }

      if (msg?.type === OCPP_MSG_CALL) {
        for (const sec of this.secondaries) {
          const toSend = this.rewriteForSecondary(sec, msg);
          if (!this.sendToSecondary(sec, toSend)) {
            this.enqueueForSecondary(sec, toSend);
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
        headers: this.buildPrimaryHeaders(),
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

      // Capture the transactionId assigned by the primary for StartTransaction.
      // Once known, resolve any secondaries that already responded with their txId.
      if (msg?.type === OCPP_MSG_CALLRESULT && this.pendingStartTxMsgIds.has(msg.id)) {
        this.pendingStartTxMsgIds.delete(msg.id);
        const payload = msg.payload as Record<string, unknown> | null;
        if (payload?.transactionId !== undefined) {
          const primaryTxId = String(payload.transactionId);
          this.primaryTxIdByMsgId.set(msg.id, primaryTxId);

          for (const sec of this.secondaries) {
            const secTxId = sec.pendingSecondaryTxIds.get(msg.id);
            if (secTxId !== undefined) {
              sec.txIdMap.set(primaryTxId, secTxId);
              sec.pendingSecondaryTxIds.delete(msg.id);
              this.store.set(this.chargePointId, sec.url, primaryTxId, secTxId);
              this.log.debug("secondary txId mapped (deferred)", {
                secondary: sec.url,
                primaryTxId,
                secondaryTxId: secTxId,
              });
            }
          }
        }
      }

      if (msg?.type === OCPP_MSG_CALLERROR && this.pendingStartTxMsgIds.has(msg.id)) {
        this.pendingStartTxMsgIds.delete(msg.id);
        this.primaryTxIdByMsgId.delete(msg.id);
        for (const sec of this.secondaries) sec.pendingSecondaryTxIds.delete(msg.id);
      }

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
   * mirrors: their responses are logged and discarded (except to extract
   * transactionIds for OCPP 1.6 mapping). They auto-reconnect on
   * disconnect/error and send periodic keepalive pings so idle connections
   * aren't dropped by intermediaries.
   */
  private connectSecondary(state: SecondaryState): WebSocket {
    const url = `${state.url.replace(/\/+$/, "")}/${state.mappedChargerId}`;

    const ws = new WebSocket(
      url,
      this.protocol ? [this.protocol] : OCPP_SUBPROTOCOLS,
      {
        headers: this.buildSecondaryHeaders(state),
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
      this.log.debug("secondary → proxy", {
        url: state.url,
        message: this.summarise(msg || raw),
      });

      if (msg?.type === OCPP_MSG_CALL) {
        if (SECONDARY_FORWARDED_ACTIONS.has(msg.action ?? "")) {
          this.pendingSecondaryCallIds.set(msg.id, state);
          this.log.debug("secondary → charger", { url: state.url, message: this.summarise(msg) });
          if (this.charger.readyState === WebSocket.OPEN) {
            try { this.charger.send(raw); } catch { /* best-effort */ }
          }
        } else if (SECONDARY_REJECTED_ACTIONS.has(msg.action ?? "")) {
          this.log.debug("secondary CALL rejected", { url: state.url, action: msg.action });
          this.replyRejectedToSecondary(state, msg.id);
        } else {
          this.replyNotSupportedToSecondary(state, msg.id, msg.action);
        }
        return;
      }

      // Capture the transactionId assigned by this secondary for StartTransaction
      // so we can rewrite MeterValues / StopTransaction sent later.
      if (msg?.type === OCPP_MSG_CALLRESULT) {
        const payload = msg.payload as Record<string, unknown> | null;
        if (payload?.transactionId !== undefined) {
          const secondaryTxId = String(payload.transactionId);
          const primaryTxId = this.primaryTxIdByMsgId.get(msg.id);
          if (primaryTxId !== undefined) {
            state.txIdMap.set(primaryTxId, secondaryTxId);
            this.store.set(this.chargePointId, state.url, primaryTxId, secondaryTxId);
            this.log.debug("secondary txId mapped", {
              secondary: state.url,
              primaryTxId,
              secondaryTxId,
            });
          } else if (this.pendingStartTxMsgIds.has(msg.id)) {
            // Primary hasn't responded yet; defer until we have the primary txId
            state.pendingSecondaryTxIds.set(msg.id, secondaryTxId);
          }
        }
      }
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

  /**
   * Return the message to send to a secondary, applying any rewrites needed:
   * - BootNotification: chargePointSerialNumber → mappedChargerId
   * - StartTransaction: idTag → state.idTag (hardcoded in config, if set)
   * - MeterValues / StopTransaction: transactionId → secondary-assigned txId
   * Returns the original message unchanged if no rewrite is needed.
   */
  private rewriteForSecondary(state: SecondaryState, msg: ParsedMessage): ParsedMessage {
    if (msg.type !== OCPP_MSG_CALL || !msg.action || !msg.payload) return msg;

    const action = msg.action;
    const payload = msg.payload as Record<string, unknown>;

    if (
      action === "BootNotification" &&
      state.mappedChargerId !== this.chargePointId &&
      "chargePointSerialNumber" in payload
    ) {
      return {
        type: OCPP_MSG_CALL,
        id: msg.id,
        action,
        payload: { ...payload, chargePointSerialNumber: state.mappedChargerId },
      };
    }

    if (action === "StartTransaction" && state.idTag !== undefined) {
      return {
        type: OCPP_MSG_CALL,
        id: msg.id,
        action,
        payload: { ...payload, idTag: state.idTag },
      };
    }

    if (action === "MeterValues" || action === "StopTransaction") {
      const rawTxId = payload.transactionId;
      if (rawTxId !== undefined) {
        const key = String(rawTxId);
        const mapped = state.txIdMap.get(key);
        if (mapped !== undefined) {
          if (action === "StopTransaction") {
            state.txIdMap.delete(key);
            this.store.delete(this.chargePointId, state.url, key);
          }
          return {
            type: OCPP_MSG_CALL,
            id: msg.id,
            action,
            payload: {
              ...payload,
              transactionId: typeof rawTxId === "number" ? Number(mapped) : mapped,
            },
          };
        }
      }
    }

    return msg;
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

  /** Acknowledge a secondary's CALL locally with {status: "Accepted"} (no round-trip to the charger). */
  private replyAcceptedToSecondary(state: SecondaryState, callId: string): boolean {
    return this.sendToSecondary(state, {
      type: OCPP_MSG_CALLRESULT,
      id: callId,
      payload: { status: "Accepted" },
    });
  }

  /** Reject a secondary's CALL with {status:"Rejected"} — used for known but disallowed actions. */
  private replyRejectedToSecondary(state: SecondaryState, callId: string): boolean {
    return this.sendToSecondary(state, {
      type: OCPP_MSG_CALLRESULT,
      id: callId,
      payload: { status: "Rejected" },
    });
  }

  /** Reject a secondary's CALL locally with a NotSupported CallError — used for unknown actions. */
  private replyNotSupportedToSecondary(state: SecondaryState, callId: string, action: string): boolean {
    return this.sendToSecondary(state, {
      type: OCPP_MSG_CALLERROR,
      id: callId,
      errorCode: "NotSupported",
      errorDescription: `Action '${action}' is not supported by the proxy`,
    });
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

  private buildPrimaryHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }
    return headers;
  }

  private buildSecondaryHeaders(state: SecondaryState): Record<string, string> {
    const headers: Record<string, string> = {};
    if (state.password) {
      const credentials = Buffer.from(
        `${state.mappedChargerId}:${state.password}`
      ).toString("base64");
      headers["Authorization"] = `Basic ${credentials}`;
    } else if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }
    return headers;
  }

  teardown() {
    if (!this.alive) return;
    this.alive = false;

    this.store.flush();
    this.pendingSecondaryCallIds.clear();

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

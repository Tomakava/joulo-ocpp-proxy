import WebSocket from "ws";
import { ChargerCallGate } from "./charger-calls";
import type { CsmsBackend, SecondaryTarget } from "./config";
import { createLogger } from "./logger";
import { OutboxStore, type Delivery } from "./outbox";
import {
  OCPP_MSG_CALL,
  OCPP_MSG_CALLERROR,
  OCPP_MSG_CALLRESULT,
  OCPP_SUBPROTOCOLS,
  type ParsedMessage,
} from "./types";
import {
  decodeOcppFrame,
  encodeCall,
  encodeCallError,
  encodeCallResult,
} from "./utils/ocpp";
import { forwardPing, forwardPong, rawDataToString } from "./utils/websocket";
import { resolveCsmsUrl } from "./utils/url";

/**
 * Manages the full lifecycle of a single charger connection:
 *
 *   Charger  ←─→  Proxy  ←─→  Primary CSMS
 *                         ──→  Secondary CSMS (mirror, one-way)
 *
 * - All messages from the charger are forwarded to the primary. Everything
 *   except its responses (CALLRESULT / CALLERROR) is mirrored to secondaries:
 *   a response belongs to whoever sent the request, and only the primary ever
 *   sends one.
 * - Only the primary CSMS can send commands back to the charger, apart from
 *   the read-only diagnostics in SECONDARY_FORWARDED_ACTIONS.
 * - Mirrored reports are journaled before sending to a secondary. Network
 *   failures never tear down primary control. Uncertain transaction starts
 *   require reconciliation instead of being blindly replayed.
 * - A secondary may know the charger under a different ID and expect its own
 *   credentials and idTag (configured via charger_mappings). Mirrored frames
 *   are rewritten per secondary:
 *   - BootNotification: chargePointSerialNumber → the mapped charger ID
 *   - StartTransaction: idTag → the configured idTag
 *   - MeterValues / StopTransaction: transactionId → the ID that secondary
 *     assigned, since OCPP 1.6 transaction IDs are assigned per CSMS
 *   These rewrites are OCPP 1.6 specific — they match 1.6 action names and
 *   payload keys. On a 2.0.1 session they simply don't apply: BootNotification
 *   carries chargingStation.serialNumber, authorization uses idToken, and the
 *   charging station generates the transactionId in TransactionEvent, so there
 *   is no per-CSMS ID to reconcile. URL and credential mapping still work for
 *   any version.
 * - CALLs from a secondary are forwarded to the charger
 *   (SECONDARY_FORWARDED_ACTIONS), answered with a refusal
 *   (SECONDARY_REFUSALS), or refused with a NotSupported CallError. Forwarded
 *   CALLs share the proxy→charger direction with the primary's, so they go
 *   through a ChargerCallGate that keeps to OCPP-J's one-outstanding-CALL rule.
 */

const SECONDARY_RECONNECT_DELAY_MS = 10_000;
const SECONDARY_KEEPALIVE_INTERVAL_MS = 30_000;
const SECONDARY_PONG_TIMEOUT_MS = 90_000;

/** One outstanding mirrored CALL per secondary, with a bounded ack wait. */
const SECONDARY_ACK_TIMEOUT_MS = 120_000;

/** Read-only CALL actions from a secondary that are relayed to the charger. */
const SECONDARY_FORWARDED_ACTIONS = new Set([
  "TriggerMessage",
  "GetConfiguration",
]);

const REJECTED = { status: "Rejected" };

/**
 * Known CSMS→charger actions the proxy refuses to relay: only the primary may
 * command the charger. Each is answered with a CALLRESULT that is a valid "no"
 * for that action's response schema, so the secondary gets a well-formed OCPP
 * response rather than a protocol error. `null` means the schema has no honest
 * refusal — GetLocalListVersion must report a version, and an empty
 * UpdateFirmware.conf means the update was accepted — so those get a
 * NotSupported CallError instead.
 *
 * Checked against the OCPP 1.6J response schemas, and the 2.0.1 ones for the
 * actions that exist in both.
 */
const SECONDARY_REFUSALS = new Map<string, object | null>([
  ["CancelReservation", REJECTED],
  ["ChangeAvailability", REJECTED],
  ["ChangeConfiguration", REJECTED],
  ["ClearCache", REJECTED],
  ["ClearChargingProfile", { status: "Unknown" }],
  ["DataTransfer", REJECTED],
  ["GetCompositeSchedule", REJECTED],
  // No fileName: no diagnostics will be uploaded.
  ["GetDiagnostics", {}],
  ["GetLocalListVersion", null],
  ["RemoteStartTransaction", REJECTED],
  ["RemoteStopTransaction", REJECTED],
  ["ReserveNow", REJECTED],
  ["Reset", REJECTED],
  ["SendLocalList", { status: "Failed" }],
  ["SetChargingProfile", REJECTED],
  ["UnlockConnector", { status: "UnlockFailed" }],
  ["UpdateFirmware", null],
]);


interface SecondaryState {
  /** Configured backend URL, also the identity used in logs. */
  url: string;
  /** URL actually connected to, after charge point ID resolution. */
  resolvedUrl: string;
  mappedChargerId: string;
  password?: string;
  /** Hardcoded idTag substituted into every mirrored StartTransaction. */
  idTag?: string;
  ws: WebSocket | null;
  /** Persistent queue identity; it includes the primary and negotiated protocol. */
  scope: string;
  inFlightId: number | null;
  /** Fires when the in-flight head goes unanswered for too long. */
  ackTimer: ReturnType<typeof setTimeout> | null;
  keepalive: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastPongAt: number;
}

export class ChargerConnection {
  private readonly log;
  private primary: WebSocket | null = null;
  private secondaries: SecondaryState[] = [];
  private alive = true;

  /** Keeps secondary CALLs from overlapping the primary's on the charger. */
  private readonly chargerCalls: ChargerCallGate<SecondaryState>;

  constructor(
    private readonly charger: WebSocket,
    private readonly chargePointId: string,
    private readonly primaryBackend: CsmsBackend,
    private readonly secondaryTargets: SecondaryTarget[],
    private readonly protocol: string,
    private readonly authHeader: string | undefined,
    private readonly store: OutboxStore,
    private readonly endCallback?: () => void,
  ) {
    this.log = createLogger(chargePointId);
    this.chargerCalls = new ChargerCallGate<SecondaryState>({
      sendToCharger: (raw) => this.sendToCharger(raw),
      replyToSecondary: (secondary, raw) => {
        this.sendToSecondary(secondary, raw);
      },
      describe: (secondary) => secondary.url,
      log: this.log,
    });
    this.setup();
  }

  private setup() {
    const primaryUrl = this.resolveUrl(this.primaryBackend);
    this.primary = this.connectPrimary(primaryUrl);

    for (const target of this.secondaryTargets) {
      try {
        const state: SecondaryState = {
          url: target.url,
          resolvedUrl: resolveCsmsUrl(target, target.mappedChargerId),
          mappedChargerId: target.mappedChargerId,
          password: target.password,
          idTag: target.idTag,
          ws: null,
          scope: this.store.register({
            chargerId: this.chargePointId,
            primaryUrl,
            protocol: this.protocol,
            secondaryUrl: target.url,
            mappedChargerId: target.mappedChargerId,
            appendChargePointId: target.appendChargePointId,
          }),
          inFlightId: null,
          ackTimer: null,
          keepalive: null,
          reconnectTimer: null,
          lastPongAt: Date.now(),
        };
        this.secondaries.push(state);
        this.connectSecondary(state);
      } catch (error) {
        this.deliveryFailure(error);
      }
    }

    this.charger.on("message", (data) => {
      if (!this.alive) return;
      const raw = rawDataToString(data);
      const msg = decodeOcppFrame(raw);
      this.log.debugOcppFrame("charger → proxy", msg ?? raw);


      // A reply to a secondary-originated CALL belongs to that secondary alone —
      // the primary never sent the command, so it must not see the response.
      if (
        msg?.type === OCPP_MSG_CALLRESULT ||
        msg?.type === OCPP_MSG_CALLERROR
      ) {
        const route = this.chargerCalls.routeReply(msg.id);
        if (route.to === "none") return;
        if (route.to === "secondary") {
          this.log.debugOcppFrame("charger → secondary", msg, {
            url: route.secondary.url,
          });
          this.sendToSecondary(route.secondary, raw);
          return;
        }
      }

      if (this.primary?.readyState === WebSocket.OPEN) {
        this.primary.send(raw);
      }

      // Withhold responses only: a secondary never sent the request, so the
      // reply is meaningless to it. Anything else the charger initiates is
      // mirrored — including frames this proxy can't parse and message types it
      // doesn't know yet — so the mirror stays complete as OCPP adds them.
      if (
        msg?.type === OCPP_MSG_CALLRESULT ||
        msg?.type === OCPP_MSG_CALLERROR
      ) {
        return;
      }

      for (const sec of this.secondaries) {
        this.mirrorToSecondary(sec, msg, raw);
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
      primary: primaryUrl,
      secondaries: this.secondaries.map((secondary) => secondary.resolvedUrl),
      protocol: this.protocol,
    });
  }

  /**
   * Connect to the primary CSMS. The primary is bidirectional: its
   * responses are forwarded back to the charger, and a primary failure
   * tears the whole session down (chargers expect to talk to exactly one
   * CSMS at a time).
   */
  private connectPrimary(url: string): WebSocket {
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
      if (!this.alive) return;
      const raw = rawDataToString(data);
      const msg = decodeOcppFrame(raw);
      this.log.debugOcppFrame("primary → charger", msg ?? raw);

      if (msg !== null) this.capturePrimaryResponse(msg);

      // The primary's CALLs share the charger with forwarded secondary CALLs;
      // its replies to the charger's own CALLs go straight through.
      if (msg?.type === OCPP_MSG_CALL) {
        this.chargerCalls.sendFromPrimary(msg.id, raw);
        return;
      }

      this.sendToCharger(raw);
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

    ws.on("ping", (data) => {
      forwardPing(this.charger, data);
    });
    ws.on("pong", (data) => {
      forwardPong(this.charger, data);
    });

    return ws;
  }

  private capturePrimaryResponse(msg: ParsedMessage): void {
    for (const state of this.secondaries) {
      this.withJournal(() => { this.store.capturePrimary(state.scope, msg); });
      this.drainOutbox(state);
    }
  }

  /**
   * Connect (or reconnect) a secondary CSMS. Secondaries are one-way mirrors:
   * their responses are logged and discarded, apart from the transactionIds
   * needed for rewriting and the diagnostics CALLs listed in
   * SECONDARY_FORWARDED_ACTIONS. They auto-reconnect on disconnect/error and
   * send periodic keepalive pings so idle connections aren't dropped by
   * intermediaries.
   */
  private connectSecondary(state: SecondaryState): void {
    const ws = new WebSocket(
      state.resolvedUrl,
      this.protocol ? [this.protocol] : OCPP_SUBPROTOCOLS,
      {
        headers: this.buildSecondaryHeaders(state),
        handshakeTimeout: 10_000,
      }
    );

    // Adopt the socket before wiring handlers, so a drain triggered from one
    // writes to this connection rather than the one it replaced.
    state.ws = ws;

    ws.on("open", () => {
      if (!this.alive || state.ws !== ws) return;
      this.log.info("secondary connected", { url: state.resolvedUrl });
      state.lastPongAt = Date.now();
      this.drainOutbox(state);
      this.startSecondaryKeepalive(state, ws);
    });

    ws.on("message", (data) => {
      if (!this.alive || state.ws !== ws) return;
      const raw = rawDataToString(data);
      if (raw === "__pong__") {
        state.lastPongAt = Date.now();
        return;
      }

      const msg = decodeOcppFrame(raw);
      this.log.debugOcppFrame("secondary → proxy", msg ?? raw, {
        url: state.url,
      });

      if (msg === null) return;

      if (msg.type === OCPP_MSG_CALL) {
        this.handleSecondaryCall(state, msg, raw);
        return;
      }

      this.withJournal(() => {
        const acknowledged = this.store.acknowledge(state.scope, msg);
        if (acknowledged !== null && acknowledged === state.inFlightId) {
          this.clearAckTimer(state);
          state.inFlightId = null;
        }
      });
      this.drainOutbox(state);
    });

    ws.on("pong", () => {
      state.lastPongAt = Date.now();
    });

    ws.on("close", (code, reason) => {
      if (!this.alive || state.ws !== ws) return;
      this.log.warn("secondary disconnected", {
        url: state.url,
        code,
        reason: reason.toString(),
      });
      this.stopSecondaryKeepalive(state);
      this.abandonInFlight(state);
      this.scheduleSecondaryReconnect(state);
    });

    ws.on("error", (err) => {
      this.log.error("secondary error", {
        url: state.url,
        error: err.message,
      });
    });
  }

  /**
   * A secondary sent a CALL. Read-only diagnostics reach the charger (with the
   * reply routed back to that secondary only); anything that would command the
   * charger is refused here.
   */
  private handleSecondaryCall(
    state: SecondaryState,
    msg: ParsedMessage,
    raw: string
  ): void {
    const action = msg.action ?? "";

    if (SECONDARY_FORWARDED_ACTIONS.has(action)) {
      this.log.debugOcppFrame("secondary → charger", msg, { url: state.url });
      this.chargerCalls.sendFromSecondary(state, msg.id, raw);
      return;
    }

    const refusal = SECONDARY_REFUSALS.get(action);
    if (refusal !== undefined) {
      this.log.debug("secondary CALL rejected", { url: state.url, action });
      this.sendToSecondary(
        state,
        refusal === null
          ? encodeCallError(
              msg.id,
              "NotSupported",
              `Action '${action}' is reserved for the primary backend`
            )
          : encodeCallResult(msg.id, refusal)
      );
      return;
    }

    this.log.debug("secondary CALL not supported", { url: state.url, action });
    this.sendToSecondary(
      state,
      encodeCallError(
        msg.id,
        "NotSupported",
        `Action '${action}' is not supported by the proxy`
      )
    );
  }


  /** Rewrites only with a binding that this secondary actually issued. */
  private rewriteForSecondary(
    state: SecondaryState,
    msg: ParsedMessage,
    entry: Delivery
  ): string | null {
    const action = msg.action;
    if (action === undefined) return msg.raw;
    let payload = msg.payload;
    if (typeof payload === "object" && payload !== null) {
      if (action === "BootNotification" && state.mappedChargerId !== this.chargePointId && "chargePointSerialNumber" in payload) {
        payload = { ...payload, chargePointSerialNumber: state.mappedChargerId };
      } else if (action === "StartTransaction" && state.idTag !== undefined) {
        payload = { ...payload, idTag: state.idTag };
      } else if ((action === "MeterValues" || action === "StopTransaction") && "transactionId" in payload) {
        const mapped = this.store.mappedTransaction(entry);
        if (mapped === null || !Number.isSafeInteger(Number(mapped))) return null;
        payload = { ...payload, transactionId: Number(mapped) };
      }
    }
    // Charger RPC IDs may be reused once the primary has replied, while an
    // older mirror is still waiting. Each journal entry owns a durable relay ID.
    return encodeCall(entry.relayId, action, payload);
  }

  /**
   * Write one frame to a secondary's socket. Returns false when it could not be
   * handed off at all — a true return only means the frame reached the write
   * path, never that the secondary received it.
   */
  private sendToSecondary(state: SecondaryState, raw: string): boolean {
    if (state.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      state.ws.send(raw);
      return true;
    } catch (err) {
      this.log.warn("secondary send failed", {
        url: state.url,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private mirrorToSecondary(
    state: SecondaryState,
    msg: ParsedMessage | null,
    raw: string
  ): void {
    this.withJournal(() => { this.store.enqueue(state.scope, msg, raw); });
    this.drainOutbox(state);
  }

  private drainOutbox(state: SecondaryState): void {
    this.withJournal(() => {
      while (this.alive && state.ws?.readyState === WebSocket.OPEN) {
        const entry = this.store.head(state.scope);
        if (entry?.state !== "queued" || !this.store.canSend(entry)) return;
        const msg = decodeOcppFrame(entry.raw);
        const frame = entry.wire ?? (msg === null ? entry.raw : this.rewriteForSecondary(state, msg, entry));
        if (frame === null) {
          this.store.block(entry.id, "No confirmed secondary transaction mapping; reconcile before sending");
          this.log.error("secondary delivery blocked: missing transaction mapping", { url: state.url, deliveryId: entry.id });
          return;
        }
        // The attempted wire frame is durable before any bytes can escape.
        this.store.prepare(entry.id, frame);
        if (!this.sendToSecondary(state, frame)) {
          this.store.interrupt(state.scope);
          return;
        }
        if (msg?.type !== OCPP_MSG_CALL) {
          this.store.malformed(entry.id);
          continue;
        }
        state.inFlightId = entry.id;
        this.startAckTimer(state);
        return;
      }
    });
  }

  private handleAckTimeout(state: SecondaryState): void {
    const id = state.inFlightId;
    state.inFlightId = null;
    if (id !== null) {
      this.withJournal(() => { this.store.timeout(id); });
      this.log.warn("secondary delivery unacknowledged; retained in journal", { url: state.url, deliveryId: id });
    }
    this.drainOutbox(state);
  }

  private abandonInFlight(state: SecondaryState): void {
    this.clearAckTimer(state);
    state.inFlightId = null;
    this.withJournal(() => { this.store.interrupt(state.scope); });
  }

  private withJournal(operation: () => void): void {
    try {
      operation();
    } catch (error) {
      this.deliveryFailure(error);
    }
  }

  private deliveryFailure(error: unknown): void {
    this.store.fail(error);
    this.log.error("secondary persistence failed; reporting health is degraded", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private startAckTimer(state: SecondaryState) {
    this.clearAckTimer(state);
    state.ackTimer = setTimeout(() => {
      state.ackTimer = null;
      this.handleAckTimeout(state);
    }, SECONDARY_ACK_TIMEOUT_MS);
  }

  private clearAckTimer(state: SecondaryState) {
    if (state.ackTimer !== null) {
      clearTimeout(state.ackTimer);
      state.ackTimer = null;
    }
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
      this.connectSecondary(state);
    }, SECONDARY_RECONNECT_DELAY_MS);
  }

  private resolveUrl(backend: CsmsBackend): string {
    return resolveCsmsUrl(backend, this.chargePointId);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }
    return headers;
  }

  /**
   * A mapped secondary authenticates as its own charger identity when a
   * password is configured; otherwise the charger's own credentials are reused.
   */
  private buildSecondaryHeaders(state: SecondaryState): Record<string, string> {
    if (state.password === undefined) return this.buildHeaders();

    const credentials = Buffer.from(
      `${state.mappedChargerId}:${state.password}`
    ).toString("base64");
    return { Authorization: `Basic ${credentials}` };
  }

  /**
   * Write one frame to the charger. Returns false when it could not be handed
   * off, so a forwarded secondary CALL can be answered instead of left hanging.
   */
  private sendToCharger(raw: string): boolean {
    if (this.charger.readyState !== WebSocket.OPEN) return false;
    try {
      this.charger.send(raw);
      return true;
    } catch (err) {
      this.log.warn("charger send failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  teardown() {
    if (!this.alive) return;
    this.alive = false;

    // Before the sockets close, so secondaries still hear why.
    this.chargerCalls.close();

    for (const sec of this.secondaries) {
      this.stopSecondaryKeepalive(sec);
      this.withJournal(() => { this.store.interrupt(sec.scope); });
      this.clearAckTimer(sec);
      if (sec.reconnectTimer !== null) {
        clearTimeout(sec.reconnectTimer);
        sec.reconnectTimer = null;
      }
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

}


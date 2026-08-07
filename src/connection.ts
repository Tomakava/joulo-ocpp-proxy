import WebSocket from "ws";
import type { CsmsBackend, SecondaryTarget } from "./config";
import { createLogger } from "./logger";
import type { StateStore } from "./state";
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
 * - Secondary connections are best-effort; failures never affect the
 *   charger or the primary link. Secondaries auto-reconnect and send periodic
 *   keepalive pings. Every mirrored frame goes through a bounded per-secondary
 *   outbox and stays there until that secondary answers it, so frames lost to a
 *   half-open socket — where send() succeeds but nothing arrives — are resent.
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
 *   (SECONDARY_FORWARDED_ACTIONS), answered with {status:"Rejected"}
 *   (SECONDARY_REJECTED_ACTIONS), or refused with a NotSupported CallError.
 */

const SECONDARY_RECONNECT_DELAY_MS = 10_000;
const SECONDARY_KEEPALIVE_INTERVAL_MS = 30_000;
const SECONDARY_PONG_TIMEOUT_MS = 90_000;
const SECONDARY_MAX_QUEUE = 100;

/**
 * How long a mirrored CALL may go unanswered before it is sent again. Sized
 * against how long a live socket takes to answer, not against outages: the timer
 * is cleared whenever the socket closes, so a reconnect never spends this budget.
 *
 * Kept above SECONDARY_PONG_TIMEOUT_MS, which is the real half-open-socket
 * detector — a peer that stops answering pings gets force-closed and the outbox
 * replays on a fresh connection. This is only the backstop for a frame lost on a
 * socket that stays healthy.
 */
const SECONDARY_ACK_TIMEOUT_MS = 120_000;

/**
 * Ack timeouts a mirrored CALL may collect before it is given up on, so one
 * message a secondary never answers can't stall the mirror forever.
 *
 * Every action is retried, including the non-transaction ones OCPP 1.6 tells a
 * Charge Point not to resend. A mirror is not a Charge Point: its secondary sees
 * only what this proxy pushes, so a dropped StatusNotification leaves that
 * secondary's idea of the connector wrong until the next state change. Retrying
 * can't reorder state either — the outbox is ordered, so a newer frame queues
 * behind the stuck one rather than overtaking it.
 *
 * A resent StartTransaction may open a second transaction, since OCPP 1.6 has a
 * Central System accept every one and offers no deduplication. Losing it is
 * worse: without the reply there is no transactionId mapping for the rest of the
 * session, and every MeterValues behind it carries the primary's ID instead.
 */
const SECONDARY_MAX_ACK_TIMEOUTS = 2;

/**
 * Cap on remembered StartTransaction results. A retry can need one long after
 * the primary replied, so they outlive the CALL and are bounded here instead.
 */
const MAX_TRACKED_START_TX = 200;

/** Read-only CALL actions from a secondary that are relayed to the charger. */
const SECONDARY_FORWARDED_ACTIONS = new Set([
  "TriggerMessage",
  "GetConfiguration",
]);

/**
 * Known CSMS→charger actions the proxy refuses to relay: only the primary may
 * command the charger. Answered with a CALLRESULT {status:"Rejected"} so the
 * secondary gets a well-formed OCPP response rather than a protocol error.
 */
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

/**
 * One frame mirrored to a secondary, held until that secondary answers it.
 *
 * The parsed message is kept rather than the encoded frame, because the rewrite
 * depends on state that moves while an entry waits: a MeterValues queued behind
 * an unanswered StartTransaction has no transactionId mapping yet.
 */
interface OutboxEntry {
  /** Parsed CALL, or null for a frame this proxy could not decode. */
  msg: ParsedMessage | null;
  /** The frame as the charger sent it, mirrored verbatim when msg is null. */
  raw: string;
  /** When the current attempt was written; null when not in flight. */
  sentAt: number | null;
  /** Ack timeouts, not sends — a dropped connection must not burn a retry. */
  timeouts: number;
}

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
  /** Mirrored frames awaiting acknowledgement, oldest first; only the head is
   * ever in flight. */
  outbox: OutboxEntry[];
  /** Fires when the in-flight head goes unanswered for too long. */
  ackTimer: ReturnType<typeof setTimeout> | null;
  keepalive: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastPongAt: number;
  /** primary transactionId → this secondary's transactionId. */
  txIdMap: Map<string, string>;
  /** msgId → secondary txId, held until the primary txId for that msgId is known. */
  pendingSecondaryTxIds: Map<string, string>;
}

export class ChargerConnection {
  private readonly log;
  private primary: WebSocket | null = null;
  private secondaries: SecondaryState[] = [];
  private alive = true;

  /** Message IDs of StartTransaction CALLs still awaiting a primary response. */
  private readonly pendingStartTxMsgIds = new Set<string>();
  /** msgId → primary-assigned transactionId, populated on the primary CALLRESULT. */
  private readonly primaryTxIdByMsgId = new Map<string, string>();
  /** msgId → the secondary whose CALL was forwarded; its reply goes back there only. */
  private readonly pendingSecondaryCallIds = new Map<string, SecondaryState>();

  constructor(
    private readonly charger: WebSocket,
    private readonly chargePointId: string,
    private readonly primaryBackend: CsmsBackend,
    private readonly secondaryTargets: SecondaryTarget[],
    private readonly protocol: string,
    private readonly authHeader: string | undefined,
    private readonly store: StateStore,
    private readonly endCallback?: () => void,
  ) {
    this.log = createLogger(chargePointId);
    this.setup();
  }

  private setup() {
    const primaryUrl = this.resolveUrl(this.primaryBackend);
    this.primary = this.connectPrimary(primaryUrl);

    for (const target of this.secondaryTargets) {
      const state: SecondaryState = {
        url: target.url,
        resolvedUrl: resolveCsmsUrl(target, target.mappedChargerId),
        mappedChargerId: target.mappedChargerId,
        password: target.password,
        idTag: target.idTag,
        ws: null,
        outbox: [],
        ackTimer: null,
        keepalive: null,
        reconnectTimer: null,
        lastPongAt: Date.now(),
        txIdMap: this.store.get(this.chargePointId, target.url),
        pendingSecondaryTxIds: new Map(),
      };
      this.secondaries.push(state);
      this.connectSecondary(state);
    }

    this.charger.on("message", (data) => {
      const raw = rawDataToString(data);
      const msg = decodeOcppFrame(raw);
      this.log.debugOcppFrame("charger → proxy", msg ?? raw);

      if (msg?.type === OCPP_MSG_CALL && msg.action === "StartTransaction") {
        this.pendingStartTxMsgIds.add(msg.id);
      }

      // A reply to a secondary-originated CALL belongs to that secondary alone —
      // the primary never sent the command, so it must not see the response.
      if (
        msg?.type === OCPP_MSG_CALLRESULT ||
        msg?.type === OCPP_MSG_CALLERROR
      ) {
        const secondary = this.pendingSecondaryCallIds.get(msg.id);
        if (secondary) {
          this.pendingSecondaryCallIds.delete(msg.id);
          this.log.debugOcppFrame("charger → secondary", msg, {
            url: secondary.url,
          });
          this.sendToSecondary(secondary, raw);
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
      const raw = rawDataToString(data);
      const msg = decodeOcppFrame(raw);
      this.log.debugOcppFrame("primary → charger", msg ?? raw);

      if (msg !== null) this.captureStartTransactionResult(msg);

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

    ws.on("ping", (data) => {
      forwardPing(this.charger, data);
    });
    ws.on("pong", (data) => {
      forwardPong(this.charger, data);
    });

    return ws;
  }

  /**
   * Record the transactionId the primary assigned to a StartTransaction, and
   * pair it with any secondary transactionId that arrived first.
   */
  private captureStartTransactionResult(msg: ParsedMessage): void {
    if (!this.pendingStartTxMsgIds.has(msg.id)) return;

    if (msg.type === OCPP_MSG_CALLERROR) {
      // The transaction never started; drop everything held for it.
      this.pendingStartTxMsgIds.delete(msg.id);
      this.primaryTxIdByMsgId.delete(msg.id);
      for (const sec of this.secondaries) {
        sec.pendingSecondaryTxIds.delete(msg.id);
      }
      return;
    }

    if (msg.type !== OCPP_MSG_CALLRESULT) return;

    this.pendingStartTxMsgIds.delete(msg.id);

    const primaryTxId = readTransactionId(msg.payload);
    if (primaryTxId === null) return;

    this.rememberPrimaryTxId(msg.id, primaryTxId);

    for (const sec of this.secondaries) {
      const secondaryTxId = sec.pendingSecondaryTxIds.get(msg.id);
      if (secondaryTxId === undefined) continue;

      sec.pendingSecondaryTxIds.delete(msg.id);
      this.mapTransactionId(sec, primaryTxId, secondaryTxId);
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
      this.log.info("secondary connected", { url: state.resolvedUrl });
      state.lastPongAt = Date.now();
      if (state.outbox.length > 0) {
        this.log.info("secondary replaying unacknowledged messages", {
          url: state.url,
          count: state.outbox.length,
        });
      }
      this.drainOutbox(state);
      this.startSecondaryKeepalive(state, ws);
    });

    ws.on("message", (data) => {
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

      if (msg.type === OCPP_MSG_CALLRESULT) {
        this.captureSecondaryTransactionId(state, msg);
      }

      // Only a CALLRESULT or CALLERROR reaches here, and either completes a
      // mirrored CALL. Last, because releasing the frame behind it may need the
      // mapping captured just above.
      this.acknowledgeOutboxEntry(state, msg);
    });

    ws.on("pong", () => {
      state.lastPongAt = Date.now();
    });

    ws.on("close", (code, reason) => {
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
      this.pendingSecondaryCallIds.set(msg.id, state);
      this.log.debugOcppFrame("secondary → charger", msg, { url: state.url });
      if (this.charger.readyState === WebSocket.OPEN) {
        try {
          this.charger.send(raw);
        } catch (err) {
          this.pendingSecondaryCallIds.delete(msg.id);
          this.log.warn("forwarding secondary CALL to charger failed", {
            url: state.url,
            action,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }

    if (SECONDARY_REJECTED_ACTIONS.has(action)) {
      this.log.debug("secondary CALL rejected", { url: state.url, action });
      this.sendToSecondary(
        state,
        encodeCallResult(msg.id, { status: "Rejected" })
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

  /**
   * Capture the transactionId a secondary assigned to a mirrored
   * StartTransaction so later MeterValues / StopTransaction can be rewritten.
   */
  private captureSecondaryTransactionId(
    state: SecondaryState,
    msg: ParsedMessage
  ): void {
    const secondaryTxId = readTransactionId(msg.payload);
    if (secondaryTxId === null) return;

    const primaryTxId = this.primaryTxIdByMsgId.get(msg.id);
    if (primaryTxId !== undefined) {
      this.mapTransactionId(state, primaryTxId, secondaryTxId);
      return;
    }

    if (this.pendingStartTxMsgIds.has(msg.id)) {
      // The primary hasn't answered yet; hold this until its txId is known.
      state.pendingSecondaryTxIds.set(msg.id, secondaryTxId);
    }
  }

  /**
   * Remember what the primary assigned to a StartTransaction. Entries outlive
   * the CALL because a retry may need one later, so trim oldest-first.
   */
  private rememberPrimaryTxId(msgId: string, primaryTxId: string): void {
    this.primaryTxIdByMsgId.set(msgId, primaryTxId);

    while (this.primaryTxIdByMsgId.size > MAX_TRACKED_START_TX) {
      const oldest = this.primaryTxIdByMsgId.keys().next().value;
      if (oldest === undefined) break;
      this.primaryTxIdByMsgId.delete(oldest);
    }
  }

  private mapTransactionId(
    state: SecondaryState,
    primaryTxId: string,
    secondaryTxId: string
  ): void {
    state.txIdMap.set(primaryTxId, secondaryTxId);
    this.store.set(this.chargePointId, state.url, primaryTxId, secondaryTxId);
    this.log.debug("secondary txId mapped", {
      url: state.url,
      primaryTxId,
      secondaryTxId,
    });
  }

  /**
   * Return the frame to mirror to one secondary, applying the rewrites that
   * secondary's identity needs. Falls back to the original frame when nothing
   * has to change.
   *
   * Pure, and called on every send attempt: a retry must see the transactionId
   * mapping as it stands then, not as it stood when the frame was queued.
   */
  private rewriteForSecondary(
    state: SecondaryState,
    msg: ParsedMessage
  ): string {
    const action = msg.action;
    if (action === undefined) return msg.raw;
    if (typeof msg.payload !== "object" || msg.payload === null) return msg.raw;

    const payload = msg.payload as Record<string, unknown>;

    if (
      action === "BootNotification" &&
      state.mappedChargerId !== this.chargePointId &&
      "chargePointSerialNumber" in payload
    ) {
      return encodeCall(msg.id, action, {
        ...payload,
        chargePointSerialNumber: state.mappedChargerId,
      });
    }

    if (action === "StartTransaction" && state.idTag !== undefined) {
      return encodeCall(msg.id, action, { ...payload, idTag: state.idTag });
    }

    if (action === "MeterValues" || action === "StopTransaction") {
      const rawTxId = payload.transactionId;
      if (typeof rawTxId !== "number" && typeof rawTxId !== "string") {
        return msg.raw;
      }

      const mapped = state.txIdMap.get(String(rawTxId));
      if (mapped === undefined) return msg.raw;

      return encodeCall(msg.id, action, {
        ...payload,
        transactionId: typeof rawTxId === "number" ? Number(mapped) : mapped,
      });
    }

    return msg.raw;
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

  /**
   * Queue one frame for a secondary and start it moving. Everything goes
   * through the outbox whether the socket is up or not: a frame is only done
   * once answered, and one ordered queue is what keeps a replay sequential.
   */
  private mirrorToSecondary(
    state: SecondaryState,
    msg: ParsedMessage | null,
    raw: string
  ): void {
    this.enqueueForSecondary(state, { msg, raw, sentAt: null, timeouts: 0 });
    this.drainOutbox(state);
  }

  private enqueueForSecondary(state: SecondaryState, entry: OutboxEntry) {
    if (state.outbox.length >= SECONDARY_MAX_QUEUE) {
      // Drop the oldest *waiting* frame, never the in-flight head: its ack is
      // what releases everything behind it.
      const index = state.outbox[0].sentAt === null ? 0 : 1;
      const [dropped] = state.outbox.splice(index, 1);
      this.log.warn("secondary queue full, dropping oldest message", {
        url: state.url,
        max: SECONDARY_MAX_QUEUE,
        action: dropped.msg?.action,
      });
    }
    state.outbox.push(entry);
  }

  /**
   * Send as much of the outbox as can go now, keeping at most one CALL in
   * flight. The sequencing is load-bearing: a mirrored MeterValues can't be
   * rewritten until the StartTransaction ahead of it has been answered.
   */
  private drainOutbox(state: SecondaryState): void {
    while (state.outbox.length > 0) {
      if (state.ws?.readyState !== WebSocket.OPEN) return;

      const entry = state.outbox[0];
      // An attempt is already in flight; its ack resumes the drain.
      if (entry.sentAt !== null) return;

      // An undecodable frame is mirrored byte-for-byte: there is nothing to
      // rewrite, and dropping it would lose data the secondary expects.
      const frame =
        entry.msg === null
          ? entry.raw
          : this.rewriteForSecondary(state, entry.msg);

      // Left queued on failure — the reconnect replays from here.
      if (!this.sendToSecondary(state, frame)) return;

      // Only a CALL has an answer to wait for; anything else is done once written.
      if (entry.msg?.type !== OCPP_MSG_CALL) {
        state.outbox.shift();
        continue;
      }

      entry.sentAt = Date.now();
      this.startAckTimer(state);
      return;
    }
  }

  /**
   * Mark the in-flight frame delivered and release the next. Only the head is
   * ever in flight, so any other answer is for a frame already given up on.
   */
  private acknowledgeOutboxEntry(
    state: SecondaryState,
    reply: ParsedMessage
  ): void {
    if (state.outbox.length === 0) return;

    const entry = state.outbox[0];
    if (entry.sentAt === null) return;
    // An undecodable frame has no ID, so it never matches and never waits.
    if (entry.msg?.id !== reply.id) return;

    state.outbox.shift();
    this.clearAckTimer(state);

    // Either reply settles it: the charger's transaction is over regardless of
    // whether this secondary accepted the stop, so the mapping is spent.
    this.releaseStoppedTransaction(state, entry.msg);

    this.drainOutbox(state);
  }

  /**
   * An answered StopTransaction has spent its mapping. Waiting for the answer
   * rather than dropping it at send time is what lets a retry rewrite the same
   * transactionId again.
   */
  private releaseStoppedTransaction(
    state: SecondaryState,
    sent: ParsedMessage
  ): void {
    if (sent.action !== "StopTransaction") return;
    if (typeof sent.payload !== "object" || sent.payload === null) return;

    // The charger's own frame, so this is the primary ID the map is keyed by.
    const rawTxId = (sent.payload as Record<string, unknown>).transactionId;
    if (typeof rawTxId !== "number" && typeof rawTxId !== "string") return;

    const key = String(rawTxId);
    if (!state.txIdMap.delete(key)) return;
    this.store.delete(this.chargePointId, state.url, key);
  }

  /**
   * The in-flight frame went unanswered. A send() that "succeeded" into a
   * half-open socket looks exactly like this, so resend rather than assume
   * delivery — bounded, so a never-answered frame can't hold the mirror shut.
   */
  private handleAckTimeout(state: SecondaryState): void {
    if (state.outbox.length === 0) return;

    const entry = state.outbox[0];
    if (entry.sentAt === null) return;

    entry.sentAt = null;
    entry.timeouts += 1;

    const gaveUp = entry.timeouts >= SECONDARY_MAX_ACK_TIMEOUTS;
    if (gaveUp) state.outbox.shift();

    this.log.warn(
      gaveUp
        ? "secondary never acknowledged mirrored message, giving up"
        : "secondary did not acknowledge mirrored message, retrying",
      {
        url: state.url,
        action: entry.msg?.action,
        timeouts: entry.timeouts,
        queued: state.outbox.length,
      }
    );

    this.drainOutbox(state);
  }

  /**
   * The socket carrying the in-flight frame is gone, so its answer can never
   * arrive. Hand the frame back to the next connection without charging it a
   * retry.
   */
  private abandonInFlight(state: SecondaryState): void {
    this.clearAckTimer(state);
    if (state.outbox.length === 0) return;

    state.outbox[0].sentAt = null;
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

  teardown() {
    if (!this.alive) return;
    this.alive = false;

    this.store.flush();
    this.pendingSecondaryCallIds.clear();

    for (const sec of this.secondaries) {
      this.stopSecondaryKeepalive(sec);
      this.clearAckTimer(sec);
      if (sec.reconnectTimer !== null) {
        clearTimeout(sec.reconnectTimer);
        sec.reconnectTimer = null;
      }
      sec.outbox = [];
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

/** Read a transactionId out of a CALLRESULT payload, if it carries one. */
function readTransactionId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;

  const transactionId = (payload as Record<string, unknown>).transactionId;
  if (typeof transactionId === "number" || typeof transactionId === "string") {
    return String(transactionId);
  }

  return null;
}

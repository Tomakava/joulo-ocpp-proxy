import { encodeCallError } from "./utils/ocpp";

/** How long the charger may take to answer a CALL before the slot is freed. */
export const CHARGER_CALL_TIMEOUT_MS = 30_000;

/**
 * Secondary CALLs that timed out are remembered this long, so a late charger
 * reply to one is dropped instead of reaching the primary as a reply to a
 * request it never sent.
 */
const MAX_LATE_SECONDARY_IDS = 20;

/** Where a charger reply goes. */
export type ReplyRoute<S> =
  | { to: "primary" }
  | { to: "secondary"; secondary: S }
  | { to: "none" };

interface GateLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
}

export interface ChargerCallGateOptions<S> {
  /** Write a frame to the charger; false when it could not be handed off. */
  sendToCharger(raw: string): boolean;
  /** Answer a secondary directly, e.g. with a CallError the proxy generated. */
  replyToSecondary(secondary: S, raw: string): void;
  /** Name for a secondary in log lines. */
  describe(secondary: S): string;
  log: GateLogger;
  timeoutMs?: number;
  now?: () => number;
}

interface SecondaryCall<S> {
  secondary: S;
  id: string;
  raw: string;
  queuedAt: number;
}

interface PrimaryCall {
  id: string;
  raw: string;
}

/**
 * Serialises CALLs sent to the charger.
 *
 * OCPP-J allows one outstanding CALL per direction, but the primary and the
 * secondaries all send in the proxy→charger direction. This gate keeps at most
 * one secondary CALL on the charger at a time, and never alongside a primary
 * CALL, then routes each charger reply back to whoever sent the CALL.
 *
 * The primary always goes first: its CALLs are sent at once unless a secondary
 * CALL is in flight, and then they go as soon as that one is answered or times
 * out, ahead of any queued secondary CALL. A primary CALL never waits behind
 * another primary CALL — the primary keeps to the one-outstanding rule itself,
 * and holding its CALLs would change how the proxy behaves for a charger with no
 * secondaries.
 */
export class ChargerCallGate<S> {
  private readonly timeoutMs: number;
  private readonly now: () => number;

  /** Primary CALLs on the charger, each with its timeout. */
  private readonly primaryInFlight = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Primary CALLs held behind the in-flight secondary CALL. */
  private readonly primaryQueue: PrimaryCall[] = [];

  private secondaryInFlight: SecondaryCall<S> | null = null;
  private secondaryTimer: ReturnType<typeof setTimeout> | null = null;
  /** At most one per secondary; a newer CALL replaces a queued one. */
  private secondaryQueue: SecondaryCall<S>[] = [];

  /** IDs of secondary CALLs already answered with a timeout error. */
  private readonly lateSecondaryIds = new Set<string>();

  private closed = false;

  constructor(private readonly options: ChargerCallGateOptions<S>) {
    this.timeoutMs = options.timeoutMs ?? CHARGER_CALL_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** A CALL from the primary, bound for the charger. */
  sendFromPrimary(id: string, raw: string): void {
    if (this.closed) return;

    if (this.secondaryInFlight !== null) {
      this.primaryQueue.push({ id, raw });
      return;
    }

    this.dispatchPrimary({ id, raw });
  }

  /** A CALL from a secondary that is allowed to reach the charger. */
  sendFromSecondary(secondary: S, id: string, raw: string): void {
    if (this.closed) return;

    const queued = this.secondaryQueue.find(
      (call) => call.secondary === secondary
    );
    if (queued !== undefined) {
      // A secondary that sends again has given up on the queued CALL.
      this.secondaryQueue = this.secondaryQueue.filter((call) => call !== queued);
      this.refuse(queued, "superseded by a newer request from the same backend");
    }

    this.secondaryQueue.push({ secondary, id, raw, queuedAt: this.now() });
    this.pump();
  }

  /**
   * Decide where a charger CALLRESULT/CALLERROR goes, and free the slot it
   * held. A reply the gate does not recognise goes to the primary, as it would
   * without the gate.
   */
  routeReply(id: string): ReplyRoute<S> {
    const secondaryCall = this.secondaryInFlight;
    if (secondaryCall !== null && secondaryCall.id === id) {
      this.clearSecondaryInFlight();
      this.pump();
      return { to: "secondary", secondary: secondaryCall.secondary };
    }

    const primaryTimer = this.primaryInFlight.get(id);
    if (primaryTimer !== undefined) {
      clearTimeout(primaryTimer);
      this.primaryInFlight.delete(id);
      this.pump();
      return { to: "primary" };
    }

    if (this.lateSecondaryIds.delete(id)) {
      this.options.log.warn(
        "charger answered a backend request after it timed out, dropping reply",
        { id }
      );
      return { to: "none" };
    }

    return { to: "primary" };
  }

  /** Session over: answer everything a secondary is still waiting on. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const timer of this.primaryInFlight.values()) clearTimeout(timer);
    this.primaryInFlight.clear();
    this.primaryQueue.length = 0;

    const waiting = [
      ...(this.secondaryInFlight ? [this.secondaryInFlight] : []),
      ...this.secondaryQueue,
    ];
    this.clearSecondaryInFlight();
    this.secondaryQueue = [];
    for (const call of waiting) this.refuse(call, "charger disconnected");
  }

  private dispatchPrimary(call: PrimaryCall): void {
    // Not tracked when it can't be sent: nothing will answer it.
    if (!this.options.sendToCharger(call.raw)) return;

    const existing = this.primaryInFlight.get(call.id);
    if (existing !== undefined) clearTimeout(existing);

    this.primaryInFlight.set(
      call.id,
      setTimeout(() => {
        this.primaryInFlight.delete(call.id);
        this.pump();
      }, this.timeoutMs)
    );
  }

  /** Send whatever may go now: held primary CALLs first, then one secondary CALL. */
  private pump(): void {
    if (this.closed || this.secondaryInFlight !== null) return;

    while (this.primaryQueue.length > 0) {
      const call = this.primaryQueue.shift();
      if (call !== undefined) this.dispatchPrimary(call);
    }

    if (this.primaryInFlight.size > 0) return;

    while (this.secondaryQueue.length > 0) {
      const call = this.secondaryQueue.shift();
      if (call === undefined) return;

      if (this.now() - call.queuedAt >= this.timeoutMs) {
        // Waited out a whole timeout behind other CALLs; the backend has
        // almost certainly given up, and the charger's answer would be stale.
        this.refuse(call, "charger busy with other requests");
        continue;
      }

      if (!this.options.sendToCharger(call.raw)) {
        this.refuse(call, "charger not connected");
        continue;
      }

      this.secondaryInFlight = call;
      this.secondaryTimer = setTimeout(() => {
        this.secondaryTimer = null;
        this.onSecondaryTimeout();
      }, this.timeoutMs);
      return;
    }
  }

  private onSecondaryTimeout(): void {
    const call = this.secondaryInFlight;
    if (call === null) return;

    this.secondaryInFlight = null;
    this.rememberLate(call.id);
    this.options.log.warn("charger did not answer a backend request", {
      url: this.options.describe(call.secondary),
      id: call.id,
    });
    this.refuse(call, "charger did not answer in time");
    this.pump();
  }

  private clearSecondaryInFlight(): void {
    if (this.secondaryTimer !== null) {
      clearTimeout(this.secondaryTimer);
      this.secondaryTimer = null;
    }
    this.secondaryInFlight = null;
  }

  private rememberLate(id: string): void {
    this.lateSecondaryIds.add(id);
    while (this.lateSecondaryIds.size > MAX_LATE_SECONDARY_IDS) {
      const oldest = this.lateSecondaryIds.values().next().value;
      if (oldest === undefined) break;
      this.lateSecondaryIds.delete(oldest);
    }
  }

  /** Answer a secondary CALL the charger will never see (or never answered). */
  private refuse(call: SecondaryCall<S>, reason: string): void {
    this.options.log.debug("backend request to charger not delivered", {
      url: this.options.describe(call.secondary),
      id: call.id,
      reason,
    });
    this.options.replyToSecondary(
      call.secondary,
      encodeCallError(call.id, "GenericError", `Proxy: ${reason}`)
    );
  }
}

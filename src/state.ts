import { readFileSync, writeFileSync, renameSync } from "fs";
import { createLogger } from "./logger";

const STATE_FILE = process.env.STATE_FILE ?? "/data/state.json";
const FLUSH_DEBOUNCE_MS = 500;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const log = createLogger("state");

interface TxEntry {
  secondaryTxId: string;
  lastUpdatedAt: number;
}

interface StateData {
  version: number;
  txMaps: Record<string, Record<string, TxEntry>>;
}

function storeKey(chargerId: string, secondaryUrl: string): string {
  return `${chargerId}::${secondaryUrl}`;
}

export class StateStore {
  private data: StateData = { version: 1, txMaps: {} };
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushFailureWarned = false;

  load(): void {
    try {
      const raw = readFileSync(STATE_FILE, "utf8");
      const parsed = JSON.parse(raw) as StateData;
      if (parsed.version === 1 && parsed.txMaps) {
        this.data = parsed;
        this.prune();
      }
    } catch {
      // Missing or corrupt — start fresh
    }
  }

  get(chargerId: string, secondaryUrl: string): Map<string, string> {
    const entries = this.data.txMaps[storeKey(chargerId, secondaryUrl)];
    if (!entries) return new Map();
    return new Map(Object.entries(entries).map(([k, v]) => [k, v.secondaryTxId]));
  }

  set(chargerId: string, secondaryUrl: string, primaryTxId: string, secondaryTxId: string): void {
    const key = storeKey(chargerId, secondaryUrl);
    if (!this.data.txMaps[key]) this.data.txMaps[key] = {};
    this.data.txMaps[key][primaryTxId] = { secondaryTxId, lastUpdatedAt: Date.now() };
    this.scheduleFlush();
  }

  delete(chargerId: string, secondaryUrl: string, primaryTxId: string): void {
    const key = storeKey(chargerId, secondaryUrl);
    const entries = this.data.txMaps[key];
    if (!entries) return;
    delete entries[primaryTxId];
    if (Object.keys(entries).length === 0) delete this.data.txMaps[key];
    this.scheduleFlush();
  }

  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const tmp = `${STATE_FILE}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tmp, STATE_FILE);
    } catch (err) {
      // Best-effort — non-fatal, but warn once so a misconfigured /data
      // mount or read-only volume doesn't fail silently for the whole
      // lifetime of the process.
      if (!this.flushFailureWarned) {
        this.flushFailureWarned = true;
        log.warn("failed to persist state; txIdMap will not survive restart", {
          path: STATE_FILE,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private prune(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const key of Object.keys(this.data.txMaps)) {
      const entries = this.data.txMaps[key];
      for (const txId of Object.keys(entries)) {
        if (entries[txId].lastUpdatedAt < cutoff) delete entries[txId];
      }
      if (Object.keys(entries).length === 0) delete this.data.txMaps[key];
    }
  }
}

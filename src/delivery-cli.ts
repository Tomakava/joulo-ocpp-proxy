import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { defaultOutboxPath, OutboxStore } from "./outbox";

/** Offline only: the running proxy holds an exclusive lock on its database. */
export function runDeliveryCommand(args: string[], output: (text: string) => void = console.log): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      id: { type: "string" },
      outcome: { type: "string" },
      note: { type: "string" },
      "primary-transaction-id": { type: "string" },
      "secondary-transaction-id": { type: "string" },
    },
  });
  const command = positionals[0];
  if (positionals.length !== 1 || !["status", "list", "export", "resolve", "bind", "discard"].includes(command)) {
    throw new Error("Usage: delivery-cli status|list|export|resolve|bind|discard [--db PATH] [--id ID --outcome received|not_received --note REASON --secondary-transaction-id ID --primary-transaction-id ID]");
  }
  const database = values.db ?? defaultOutboxPath();
  if (!existsSync(database)) throw new Error("Outbox database does not exist; check --db or OUTBOX_FILE");
  const store = new OutboxStore(database, null);
  try {
    if (command === "status") {
      const health = store.health();
      output(JSON.stringify(health, null, 2));
      return health.status === "ok" ? 0 : 2;
    }
    if (command === "list" || command === "export") {
      const deliveries = store.inspect();
      output(JSON.stringify(command === "export" ? deliveries : deliveries.map(row => ({
        id: row.id,
        scope: row.scope,
        messageId: row.messageId,
        relayId: row.relayId,
        action: row.action,
        state: row.state,
        primaryTx: row.primaryTx,
        error: row.error,
        operatorNote: row.operatorNote,
      })), null, 2));
      return 0;
    }
    if (!values.id || !/^\d+$/.test(values.id) || !Number.isSafeInteger(Number(values.id)) || Number(values.id) < 1) {
      throw new Error("A valid delivery --id is required");
    }
    if (!values.note?.trim()) throw new Error("A --note recording the operator's evidence or discard decision is required");
    const id = Number(values.id);
    if (command === "resolve") {
      const outcome = values.outcome;
      if (outcome !== "received" && outcome !== "not_received") throw new Error("--outcome must be received or not_received, confirmed with the backend");
      store.resolve(id, outcome, values.note, values["secondary-transaction-id"], values["primary-transaction-id"]);
    } else if (command === "bind") {
      const primary = values["primary-transaction-id"];
      const secondary = values["secondary-transaction-id"];
      if (primary === undefined || secondary === undefined) throw new Error("Both confirmed transaction IDs are required");
      store.bind(id, primary, secondary, values.note);
    } else {
      store.discard(id, values.note);
    }
    output(JSON.stringify({ deliveryId: id, operation: command, recorded: true }));
    return 0;
  } finally {
    store.close();
  }
}

if (require.main === module) {
  try {
    process.exitCode = runDeliveryCommand(process.argv.slice(2));
  } catch (error) {
    console.error("Delivery administration failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

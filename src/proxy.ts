import { createServer, type IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { Config, SecondaryTarget } from "./config";
import { ChargerConnection } from "./connection";
import { createLogger } from "./logger";
import { OCPP_SUBPROTOCOLS } from "./types";

const log = createLogger("proxy");

/**
 * Start the OCPP proxy server.
 *
 * Chargers connect via:
 *   ws(s)://proxy-host:port/<chargePointId>
 *
 * The proxy can append the chargePointId to each upstream CSMS URL.
 */
export function startProxy(config: Config) {
  const sessions = new Map<string, ChargerConnection>();

  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(
      "joulo-ocpp-proxy is running.\n" +
        "Connect your charge point via WebSocket.\n"
    );
  });

  const wss = new WebSocketServer({
    server,
    autoPong: false,
    handleProtocols: (protocols) => {
      for (const p of OCPP_SUBPROTOCOLS) {
        if (protocols.has(p)) return p;
      }
      return false;
    },
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const chargePointId = extractChargePointId(req.url);
    if (!chargePointId) {
      log.warn("rejected connection: no charge point ID in path", {
        url: req.url,
      });
      ws.close(1002, "Charge point ID required in URL path");
      return;
    }

    const protocol = ws.protocol;
    const authHeader = req.headers.authorization;

    log.info("charger connected", {
      chargePointId,
      protocol: protocol || "none",
      ip: req.socket.remoteAddress,
    });

    // Destroy any existing session for this charger before creating a new one.
    // Without this, the old primary connection stays open; some CSMS backends
    // reject the new connection while the old one is still alive, forcing the
    // charger into a reconnect loop.
    const existing = sessions.get(chargePointId);
    if (existing) {
      log.info("replacing existing session", { chargePointId });
      existing.teardown();
    }

    // Global mirrors see every charger under its own ID; charger_mappings add
    // per-charger mirrors that may use a different identity and credentials.
    const secondaries: SecondaryTarget[] = [
      ...config.secondaryCsms.map((backend) => ({
        ...backend,
        mappedChargerId: chargePointId,
      })),
      ...(config.secondariesByCharger.get(chargePointId) ?? []),
    ];
    if (secondaries.length === 0) {
      log.info("no secondaries configured for this charger; primary only", {
        chargePointId,
      });
    }

    const conn = new ChargerConnection(
      ws,
      chargePointId,
      config.primaryCsms,
      secondaries,
      protocol,
      authHeader,
      () => sessions.delete(chargePointId)
    );
    sessions.set(chargePointId, conn);
  });

  wss.on("error", (err) => {
    log.error("WebSocket server error", { error: err.message });
  });

  server.listen(config.port, () => {
    log.info("proxy listening", {
      port: config.port,
      primary: config.primaryCsms.url,
      secondaries: config.secondaryCsms.map((backend) => backend.url),
      mappedChargers: [...config.secondariesByCharger.keys()],
    });
  });

  const shutdown = () => {
    log.info("shutting down…");
    wss.clients.forEach((ws) => {
      ws.close(1001, "Server shutting down");
    });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function extractChargePointId(url: string | undefined): string | null {
  if (!url) return null;
  const segments = url
    .split("?")[0]
    .split("/")
    .filter(Boolean);
  // Accept /ocpp/<id>, /ws/<id>, or just /<id>
  if (segments.length === 0) return null;
  return segments[segments.length - 1];
}

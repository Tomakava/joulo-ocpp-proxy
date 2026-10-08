import { createServer, type IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { Config, CsmsBackend, SecondaryTarget } from "./config";
import { ChargerConnection } from "./connection";
import { createLogger } from "./logger";
import { StateStore } from "./state";
import { OCPP_SUBPROTOCOLS } from "./types";

const log = createLogger("proxy");

/**
 * Start the OCPP proxy server.
 *
 * Chargers connect via:
 *   ws(s)://proxy-host:port/[<route path>/]<chargePointId>
 *
 * The route path selects the primary CSMS from primary_csms_routes; without a
 * match the default primary is used. The proxy can append the chargePointId
 * to each upstream CSMS URL.
 */
export function startProxy(config: Config) {
  const sessions = new Map<string, ChargerConnection>();

  const store = new StateStore();
  store.load();

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
    const { routePath, chargePointId } = parseChargerPath(req.url);
    if (!chargePointId) {
      log.warn("rejected connection: no charge point ID in path", {
        url: req.url,
      });
      ws.close(1002, "Charge point ID required in URL path");
      return;
    }

    const primaryCsms = selectPrimary(config, routePath);
    if (!primaryCsms) {
      log.warn("rejected connection: no primary CSMS for this path", {
        chargePointId,
        path: routePath,
      });
      ws.close(1008, "Unknown URL path");
      return;
    }

    const protocol = ws.protocol;
    const authHeader = req.headers.authorization;

    log.info("charger connected", {
      chargePointId,
      protocol: protocol || "none",
      ip: req.socket.remoteAddress,
      path: routePath,
      primary: primaryCsms.url,
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
    const secondaries = uniqueSecondaries(chargePointId, [
      ...config.secondaryCsms.map((backend) => ({
        ...backend,
        mappedChargerId: chargePointId,
      })),
      ...(config.secondariesByCharger.get(chargePointId) ?? []),
    ]);
    if (secondaries.length === 0) {
      log.info("no secondaries configured for this charger; primary only", {
        chargePointId,
      });
    }

    const conn = new ChargerConnection(
      ws,
      chargePointId,
      primaryCsms,
      secondaries,
      protocol,
      authHeader,
      store,
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
      primary: config.primaryCsms?.url,
      primaryRoutes: Object.fromEntries(
        [...(config.primaryCsmsByPath ?? [])].map(([path, backend]) => [
          path,
          backend.url,
        ])
      ),
      secondaries: config.secondaryCsms.map((backend) => backend.url),
      mappedChargers: [...config.secondariesByCharger.keys()],
    });
  });

  const shutdown = () => {
    log.info("shutting down…");
    store.flush();
    wss.clients.forEach((ws) => {
      ws.close(1001, "Server shutting down");
    });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Drop secondaries that repeat an earlier one's URL and charger ID. Both would
 * open a connection to the same backend as the same charger, so each would
 * start its own transaction there for every charging session — and they would
 * share one set of saved transactionId mappings. The first wins, so a global
 * mirror takes precedence over a charger_mappings entry that duplicates it.
 */
export function uniqueSecondaries(
  chargePointId: string,
  targets: SecondaryTarget[]
): SecondaryTarget[] {
  const seen = new Set<string>();

  return targets.filter((target) => {
    const key = `${target.url}
${target.mappedChargerId}`;
    if (!seen.has(key)) {
      seen.add(key);
      return true;
    }

    log.warn("duplicate secondary ignored: same URL and charger ID as another", {
      chargePointId,
      url: target.url,
      mappedChargerId: target.mappedChargerId,
    });
    return false;
  });
}

/**
 * Split a charger's connect URL into the charge point ID (the last path
 * segment) and the route path in front of it: `/site-a/CP-1?x=y` gives route
 * path `site-a` and ID `CP-1`. Both are as received, not percent-decoded.
 */
export function parseChargerPath(url: string | undefined): {
  routePath: string;
  chargePointId: string | null;
} {
  const segments = (url ?? "").split("?")[0].split("/").filter(Boolean);
  const chargePointId = segments.pop() ?? null;
  return { routePath: segments.join("/"), chargePointId };
}

/**
 * The primary for a charger connecting under routePath: the matching
 * primary_csms_routes entry, else the default primary. Undefined when neither
 * exists, so the connection is refused.
 *
 * Falling back to the default keeps prefixes like `/ocpp/<id>` and `/ws/<id>`
 * working for setups that configure no routes for them.
 */
export function selectPrimary(
  config: Pick<Config, "primaryCsms" | "primaryCsmsByPath">,
  routePath: string
): CsmsBackend | undefined {
  return config.primaryCsmsByPath?.get(routePath) ?? config.primaryCsms;
}

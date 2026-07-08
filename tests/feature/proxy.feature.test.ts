import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";

import { startProxy } from "../../src/proxy";

interface WsRecord {
  httpServer: ReturnType<typeof createServer>;
  server: WebSocketServer;
  connections: WebSocket[];
}

function waitForOpen(socket: WebSocket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("websocket timeout")), timeoutMs);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function waitForClose(
  socket: WebSocket,
  timeoutMs = 2000
): Promise<{ code: number; reason: Buffer }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("websocket close timeout")), timeoutMs);
    const onError = (error: Error) => {
      clearTimeout(timeout);
      socket.off("close", onClose);
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      socket.off("error", onError);
      resolve({ code, reason: Buffer.from(reason) });
    };
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function connectWhenOpen(
  url: string,
  protocol: string,
  timeoutMs = 3000,
  retryMs = 25
): Promise<WebSocket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    const socket = new WebSocket(url, protocol);
    try {
      await waitForOpen(socket, retryMs);
      return socket;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.message.includes("ECONNREFUSED") || lastError.message.includes("connect")) {
        await sleep(retryMs);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error("websocket failed to open");
}

function waitForMessage(socket: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("websocket message timeout")), timeoutMs);
    socket.once("message", (data) => {
      clearTimeout(timeout);
      resolve(data.toString());
    });
  });
}

function createWsServer(): WsRecord {
  const httpServer = createServer();
  const server = new WebSocketServer({ server: httpServer });
  return { httpServer, server, connections: [] };
}

function startWsServer(record: WsRecord): Promise<number> {
  const { httpServer } = record;
  return new Promise((resolve, reject) => {
    const existingAddress = httpServer.address();
    if (existingAddress && typeof existingAddress === "object") {
      resolve(existingAddress.port);
      return;
    }

    httpServer.once("error", (error) => {
      reject(error);
    });

    httpServer.once("listening", () => {
      const address = httpServer.address();
      if (address && typeof address === "object") {
        resolve(address.port);
        return;
      }
      reject(new Error("websocket server started without address"));
    });

    httpServer.listen(0, "127.0.0.1");
  });
}

async function waitForConnection(record: WsRecord): Promise<WebSocket> {
  return new Promise((resolve) => {
    record.server.once("connection", (socket: WebSocket) => {
      record.connections.push(socket);
      resolve(socket);
    });
  });
}

function closeAll(records: WsRecord[]) {
  for (const record of records) {
    for (const socket of record.connections) {
      if (socket.readyState <= WebSocket.OPEN) socket.close();
    }
    record.server.close();
    record.httpServer.close();
  }
}

describe("proxy feature", () => {
  let primary: WsRecord;
  let secondary: WsRecord;
  let openChargers: WebSocket[] = [];

  const allocatePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const address = s.address();
        if (!address || typeof address !== "object") {
          reject(new Error("Failed to allocate port"));
          return;
        }

        const port = address.port;
        s.close(() => resolve(port));
      });
    });

  beforeEach(() => {
    primary = createWsServer();
    secondary = createWsServer();
    openChargers = [];
  });

  afterEach(async () => {
    for (const charger of openChargers) {
      if (charger.readyState <= WebSocket.OPEN) {
        charger.close();
      }
    }

    closeAll([primary, secondary]);
  });

  it("forwards charger frames to primary and secondary, and forwards primary response back", async () => {
    const bootFrame = '["2","msg-1","BootNotification",{}]';
    const responseFrame = '["3","msg-1",{}]';

    const primaryConnPromise = waitForConnection(primary);
    const secondaryConnPromise = waitForConnection(secondary);

    const primaryPort = await startWsServer(primary);
    const secondaryPort = await startWsServer(secondary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryUrl: `ws://127.0.0.1:${primaryPort}`,
        secondaryUrls: [`ws://127.0.0.1:${secondaryPort}`],
        loggerConfig: {
          logLevel: "error",
        },
      }
    );

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${proxyPort}/charger-1`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const [primaryConn, secondaryConn] = await Promise.all([
      primaryConnPromise,
      secondaryConnPromise,
    ]);

    const primaryMessage = waitForMessage(primaryConn);
    const secondaryMessage = waitForMessage(secondaryConn);
    charger.send(bootFrame);

    expect(await primaryMessage).toBe(bootFrame);
    expect(await secondaryMessage).toBe(bootFrame);

    const chargerMessage = waitForMessage(charger);
    primaryConn.send(responseFrame);
    expect(await chargerMessage).toBe(responseFrame);
  });

  it("rejects charger connections without a charge point ID", async () => {
    const primaryPort = await startWsServer(primary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryUrl: `ws://127.0.0.1:${primaryPort}`,
        secondaryUrls: [],
        loggerConfig: {
          logLevel: "error",
        },
      }
    );

    const charger = await connectWhenOpen(`ws://127.0.0.1:${proxyPort}/`, "ocpp1.6");
    openChargers.push(charger);
    const closeEvent = await waitForClose(charger);

    expect(closeEvent.code).toBe(1002);
    expect(primary.connections).toHaveLength(0);
  });

  it("drops charger connection when primary is unavailable", async () => {
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryUrl: `ws://127.0.0.1:9`,
        secondaryUrls: [],
        loggerConfig: {
          logLevel: "error",
        },
      }
    );

    const charger = await connectWhenOpen(`ws://127.0.0.1:${proxyPort}/cp-offline`, "ocpp1.6");
    openChargers.push(charger);

    const closed = await Promise.race<{
      closed: true;
      code: number;
      reason: Buffer;
    } | { closed: false }>([
      (async () => {
        const event = await waitForClose(charger);
        return { closed: true, code: event.code, reason: event.reason };
      })(),
      sleep(250).then(() => ({ closed: false })),
    ]);

    expect(closed).toEqual({ closed: true, code: expect.any(Number), reason: expect.any(Buffer) });
  });

  it("replaces existing session for same charge point", async () => {
    const firstPrimaryConn = waitForConnection(primary);

    const primaryPort = await startWsServer(primary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryUrl: `ws://127.0.0.1:${primaryPort}`,
        secondaryUrls: [],
        loggerConfig: {
          logLevel: "error",
        },
      }
    );

    const firstCharger = await connectWhenOpen(
      `ws://127.0.0.1:${proxyPort}/cp-reconnect`,
      "ocpp1.6"
    );
    openChargers.push(firstCharger);

    const firstUpstream = await firstPrimaryConn;
    const firstClose = waitForClose(firstUpstream);

    const secondPrimaryConn = waitForConnection(primary);

    const secondCharger = await connectWhenOpen(
      `ws://127.0.0.1:${proxyPort}/cp-reconnect`,
      "ocpp1.6"
    );
    openChargers.push(secondCharger);

    const secondUpstream = await secondPrimaryConn;

    const firstCloseEvent = await firstClose;

    expect(firstCloseEvent.code).toBe(1000);
    expect(secondUpstream.readyState).toBe(WebSocket.OPEN);

    const closeWaits: Promise<{ code: number; reason: Buffer }>[] = [];
    if (firstCharger.readyState <= WebSocket.OPEN) {
      closeWaits.push(waitForClose(firstCharger));
      firstCharger.close();
    }
    if (secondCharger.readyState <= WebSocket.OPEN) {
      closeWaits.push(waitForClose(secondCharger));
      secondCharger.close();
    }

    closeWaits.push(waitForClose(secondUpstream));
    await Promise.all(closeWaits);
  });
});

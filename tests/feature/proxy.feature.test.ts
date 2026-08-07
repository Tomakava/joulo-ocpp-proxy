import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { startProxy } from "../../src/proxy";
import { rawDataToString } from "../../src/utils/websocket";

interface WsRecord {
  httpServer: ReturnType<typeof createServer>;
  server: WebSocketServer;
  connections: WebSocket[];
}

interface UrlAwareConnection {
  socket: WebSocket;
  url: string;
}

function waitForOpen(socket: WebSocket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("websocket timeout"));
    }, timeoutMs);
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
    const timeout = setTimeout(() => {
      reject(new Error("websocket close timeout"));
    }, timeoutMs);
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(10);
  }
}

/** An OCPP frame's elements, or null when the text isn't a JSON array. */
function tryParseFrame(raw: string): [number, string, ...unknown[]] | null {
  try {
    const frame: unknown = JSON.parse(raw);
    return Array.isArray(frame) ? (frame as [number, string, ...unknown[]]) : null;
  } catch {
    return null;
  }
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
    const timeout = setTimeout(() => {
      reject(new Error("websocket message timeout"));
    }, timeoutMs);
    socket.once("message", (data) => {
      clearTimeout(timeout);
      resolve(rawDataToString(data));
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
    if (httpServer.listening && existingAddress && typeof existingAddress === "object") {
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

function waitForConnection(record: WsRecord): Promise<UrlAwareConnection> {
  return new Promise((resolve) => {
    record.server.once("connection", (socket: WebSocket, request) => {
      record.connections.push(socket);
      resolve({
        socket,
        url: request.url ?? "",
      });
    });
  });
}

async function closeAll(records: WsRecord[]) {
  for (const record of records) {
    for (const socket of record.connections) {
      if (socket.readyState <= WebSocket.OPEN) socket.close();
    }
    await new Promise<void>((resolve) => {
      record.server.close(() => {
        record.httpServer.close(() => {
          resolve();
        });
      });
    });
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
        s.close(() => {
          resolve(port);
        });
      });
    });

  let stateDirectory: string;

  beforeEach(() => {
    primary = createWsServer();
    secondary = createWsServer();
    openChargers = [];
    // Keep the proxy's persisted state out of the real /data mount.
    stateDirectory = mkdtempSync(join(tmpdir(), "ocpp-proxy-state-"));
    vi.stubEnv("STATE_FILE", join(stateDirectory, "state.json"));
  });

  afterEach(async () => {
      for (const charger of openChargers) {
          if (charger.readyState <= WebSocket.OPEN) {
              charger.close();
          }
      }

      await closeAll([primary, secondary]);

      vi.unstubAllEnvs();
      rmSync(stateDirectory, { recursive: true, force: true });
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
        primaryCsms: {
          url: `ws://127.0.0.1:${String(primaryPort)}`,
          appendChargePointId: true,
        },
        secondaryCsms: [
          {
            url: `ws://127.0.0.1:${String(secondaryPort)}`,
            appendChargePointId: true,
          }
        ],
        secondariesByCharger: new Map(),
        loggerConfig: {
          logLevel: "error",
        },
      }
    );

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/charger-1`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const [{ socket: primaryConn }, { socket: secondaryConn }] =
      await Promise.all([
        primaryConnPromise,
        secondaryConnPromise,
      ]);

    const primaryMessage = waitForMessage(primaryConn, 5000);
    const secondaryMessage = waitForMessage(secondaryConn);
    charger.send(bootFrame);

    expect(await primaryMessage).toBe(bootFrame);
    expect(await secondaryMessage).toBe(bootFrame);

    const chargerMessage = waitForMessage(charger);
    primaryConn.send(responseFrame);
    expect(await chargerMessage).toBe(responseFrame);
  });

  it("mirrors charger frames to secondaries except its responses", async () => {
    const callFrame = '[2,"msg-1","Heartbeat",{}]';
    const resultFrame = '[3,"msg-2",{}]';
    const garbageFrame = "not-ocpp";

    const primaryConnPromise = waitForConnection(primary);
    const secondaryConnPromise = waitForConnection(secondary);

    const primaryPort = await startWsServer(primary);
    const secondaryPort = await startWsServer(secondary);
    const proxyPort = await allocatePort();

    startProxy({
      port: proxyPort,
      primaryCsms: {
        url: `ws://127.0.0.1:${String(primaryPort)}`,
        appendChargePointId: true,
      },
      secondaryCsms: [
        {
          url: `ws://127.0.0.1:${String(secondaryPort)}`,
          appendChargePointId: true,
        },
      ],
      secondariesByCharger: new Map(),
      loggerConfig: {
        logLevel: "error",
      },
    });

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/charger-1`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const [{ socket: primaryConn }, { socket: secondaryConn }] =
      await Promise.all([primaryConnPromise, secondaryConnPromise]);

    const primaryFrames: string[] = [];
    primaryConn.on("message", (data) => {
      primaryFrames.push(rawDataToString(data));
    });
    const secondaryFrames: string[] = [];
    secondaryConn.on("message", (data) => {
      secondaryFrames.push(rawDataToString(data));
    });

    charger.send(resultFrame);
    charger.send(garbageFrame);
    charger.send(callFrame);
    await sleep(250);

    // The primary sees everything. The secondary sees everything the charger
    // initiated — including the frame the proxy couldn't parse, so an
    // unrecognized message type is never silently dropped from the mirror —
    // but not the response, which answers a request only the primary made.
    expect(primaryFrames).toEqual([resultFrame, garbageFrame, callFrame]);
    expect(secondaryFrames).toEqual([garbageFrame, callFrame]);
  });

  it("accepts charger URLs with query parameters", async () => {
    const primaryConnPromise = waitForConnection(primary);

    const primaryPort = await startWsServer(primary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryCsms: {
          url: `ws://127.0.0.1:${String(primaryPort)}`,
          appendChargePointId: true,
        },
        secondaryCsms: [],
        secondariesByCharger: new Map(),
        loggerConfig: {
          logLevel: "error",
          debugMessageMaxLength: 120,
        },
      }
    );

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/ocpp/cp-query?foo=bar`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const { socket: primaryConn, url: upstreamPath } = await primaryConnPromise;

    expect(upstreamPath).toBe("/cp-query");
    expect(primaryConn.readyState).toBe(WebSocket.OPEN);
    expect(charger.readyState).toBe(WebSocket.OPEN);
  });

  it("keeps charge point ID in resolved primary URL when primary has query params", async () => {
    const primaryConnPromise = waitForConnection(primary);

    const primaryPort = await startWsServer(primary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryCsms: {
          url: `ws://127.0.0.1:${String(primaryPort)}/endpoint?tenant=emea`,
          appendChargePointId: true,
        },
        secondaryCsms: [],
        secondariesByCharger: new Map(),
        loggerConfig: {
          logLevel: "error",
          debugMessageMaxLength: 120,
        },
      }
    );

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/cp-query?a=b&c=d`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const { socket: primaryConn, url: upstreamUrl } = await primaryConnPromise;
    expect(upstreamUrl).toBe("/endpoint/cp-query?tenant=emea");
    expect(primaryConn.readyState).toBe(WebSocket.OPEN);
    expect(charger.readyState).toBe(WebSocket.OPEN);
  });

  it("keeps charge point ID in resolved secondary URL when secondary has query params", async () => {
    const primaryConnPromise = waitForConnection(primary);
    const secondaryConnPromise = waitForConnection(secondary);

    const primaryPort = await startWsServer(primary);
    const secondaryPort = await startWsServer(secondary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryCsms: {
          url: `ws://127.0.0.1:${String(primaryPort)}`,
          appendChargePointId: true,
        },
        secondaryCsms: [{
          url: `ws://127.0.0.1:${String(secondaryPort)}/mirror?tenant=auditor`,
          appendChargePointId: true,
        }],
        secondariesByCharger: new Map(),
        loggerConfig: {
          logLevel: "error",
          debugMessageMaxLength: 120,
        },
      }
    );

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/cp-secondary?foo=bar`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const [{ socket: primaryConn }, secondaryConn] = await Promise.all([
      primaryConnPromise,
      secondaryConnPromise,
    ]);

    expect(secondaryConn.url).toBe("/mirror/cp-secondary?tenant=auditor");
    expect(primaryConn.readyState).toBe(WebSocket.OPEN);
    expect(secondaryConn.socket.readyState).toBe(WebSocket.OPEN);
    expect(charger.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects charger connections without a charge point ID", async () => {
    const primaryPort = await startWsServer(primary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryCsms: {
          url: `ws://127.0.0.1:${String(primaryPort)}`,
          appendChargePointId: true,
        },
        secondaryCsms: [],
        secondariesByCharger: new Map(),
        loggerConfig: {
          logLevel: "error",
        },
      }
    );

    const charger = await connectWhenOpen(`ws://127.0.0.1:${String(proxyPort)}/`, "ocpp1.6");
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
        primaryCsms: {
          url: `ws://127.0.0.1:9`,
          appendChargePointId: true,
        },
        secondaryCsms: [],
        secondariesByCharger: new Map(),
        loggerConfig: {
          logLevel: "error",
        },
      }
    );

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/cp-offline`,
      "ocpp1.6"
    );
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

    expect(closed.closed).toBe(true);
    if (!closed.closed) {
      throw new Error("charger connection did not close");
    }
    expect(closed.code).toBeTypeOf("number");
    expect(Buffer.isBuffer(closed.reason)).toBe(true);
  });

  it("replaces existing session for same charge point", async () => {
    const firstPrimaryConn = waitForConnection(primary);

    const primaryPort = await startWsServer(primary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryCsms: {
          url: `ws://127.0.0.1:${String(primaryPort)}`,
          appendChargePointId: true,
        },
        secondaryCsms: [],
        secondariesByCharger: new Map(),
        loggerConfig: {
          logLevel: "error",
        },
      }
    );

    const firstCharger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/cp-reconnect`,
      "ocpp1.6"
    );
    openChargers.push(firstCharger);

    const { socket: firstUpstream } = await firstPrimaryConn;
    const firstClose = waitForClose(firstUpstream);

    const secondPrimaryConn = waitForConnection(primary);

    const secondCharger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/cp-reconnect`,
      "ocpp1.6"
    );
    openChargers.push(secondCharger);

    const { socket: secondUpstream } = await secondPrimaryConn;

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
  it("rewrites mirrored frames for a mapped secondary", async () => {
    const primaryConnPromise = waitForConnection(primary);
    const secondaryConnPromise = waitForConnection(secondary);

    const primaryPort = await startWsServer(primary);
    const secondaryPort = await startWsServer(secondary);
    const proxyPort = await allocatePort();

    startProxy({
      port: proxyPort,
      primaryCsms: {
        url: `ws://127.0.0.1:${String(primaryPort)}`,
        appendChargePointId: true,
      },
      secondaryCsms: [],
      secondariesByCharger: new Map([
        [
          "cp-mapped",
          [
            {
              url: `ws://127.0.0.1:${String(secondaryPort)}`,
              appendChargePointId: true,
              mappedChargerId: "ext-cp-mapped",
              idTag: "HARDCODED-TAG",
            },
          ],
        ],
      ]),
      loggerConfig: {
        logLevel: "error",
      },
    });

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/cp-mapped`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const [{ socket: primaryConn }, { socket: secondaryConn, url: secondaryPath }] =
      await Promise.all([primaryConnPromise, secondaryConnPromise]);

    // The secondary is reached under its mapped charger ID.
    expect(secondaryPath).toBe("/ext-cp-mapped");

    const secondaryFrames: string[] = [];
    secondaryConn.on("message", (data) => {
      const raw = rawDataToString(data);
      secondaryFrames.push(raw);

      // The proxy mirrors one CALL at a time and waits for the answer, so this
      // stand-in CSMS has to answer like a real one or nothing behind the first
      // frame ships. start-1 is left alone: the test answers that one itself,
      // with the transaction ID this secondary assigns.
      const frame = tryParseFrame(raw);
      if (frame?.[0] === 2 && frame[1] !== "start-1") {
        secondaryConn.send(JSON.stringify([3, frame[1], {}]));
      }
    });

    // BootNotification: the serial number is rewritten to the mapped ID.
    charger.send(
      '[2,"boot-1","BootNotification",{"chargePointSerialNumber":"cp-mapped"}]'
    );

    // StartTransaction: the configured idTag replaces the charger's.
    const primaryStart = waitForMessage(primaryConn, 5000);
    charger.send(
      '[2,"start-1","StartTransaction",{"connectorId":1,"idTag":"CARD-1","meterStart":0}]'
    );
    await primaryStart;

    // The mirror is sequential, so start-1 only goes out once boot-1 has been
    // answered. Wait for it to actually arrive before answering it — an answer
    // to a frame still queued is not an acknowledgement of anything.
    await waitFor(() => secondaryFrames.length >= 2);

    // Each CSMS assigns its own transaction ID.
    primaryConn.send('[3,"start-1",{"transactionId":111,"idTagInfo":{"status":"Accepted"}}]');
    secondaryConn.send('[3,"start-1",{"transactionId":222,"idTagInfo":{"status":"Accepted"}}]');
    await sleep(150);

    // MeterValues for primary transaction 111 must reach the secondary as 222.
    charger.send('[2,"meter-1","MeterValues",{"connectorId":1,"transactionId":111}]');
    await sleep(200);

    const boot = JSON.parse(secondaryFrames[0]) as [number, string, string, Record<string, unknown>];
    expect(boot[3].chargePointSerialNumber).toBe("ext-cp-mapped");

    const start = JSON.parse(secondaryFrames[1]) as [number, string, string, Record<string, unknown>];
    expect(start[3].idTag).toBe("HARDCODED-TAG");

    const meter = JSON.parse(secondaryFrames[2]) as [number, string, string, Record<string, unknown>];
    expect(meter[3].transactionId).toBe(222);

    // A frame the proxy can't parse has nothing to rewrite, so a mapped
    // secondary still receives it byte-for-byte rather than losing it.
    charger.send("not-ocpp");
    await sleep(200);
    expect(secondaryFrames[3]).toBe("not-ocpp");
  });

  it("forwards read-only secondary CALLs to the charger and refuses the rest", async () => {
    const primaryConnPromise = waitForConnection(primary);
    const secondaryConnPromise = waitForConnection(secondary);

    const primaryPort = await startWsServer(primary);
    const secondaryPort = await startWsServer(secondary);
    const proxyPort = await allocatePort();

    startProxy({
      port: proxyPort,
      primaryCsms: {
        url: `ws://127.0.0.1:${String(primaryPort)}`,
        appendChargePointId: true,
      },
      secondaryCsms: [
        {
          url: `ws://127.0.0.1:${String(secondaryPort)}`,
          appendChargePointId: true,
        },
      ],
      secondariesByCharger: new Map(),
      loggerConfig: {
        logLevel: "error",
      },
    });

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/cp-commands`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const [{ socket: primaryConn }, { socket: secondaryConn }] =
      await Promise.all([primaryConnPromise, secondaryConnPromise]);

    const chargerFrames: string[] = [];
    charger.on("message", (data) => {
      chargerFrames.push(rawDataToString(data));
    });
    const primaryFrames: string[] = [];
    primaryConn.on("message", (data) => {
      primaryFrames.push(rawDataToString(data));
    });
    const secondaryFrames: string[] = [];
    secondaryConn.on("message", (data) => {
      secondaryFrames.push(rawDataToString(data));
    });

    secondaryConn.send('[2,"trig-1","TriggerMessage",{"requestedMessage":"MeterValues"}]');
    secondaryConn.send('[2,"reset-1","Reset",{"type":"Hard"}]');
    secondaryConn.send('[2,"weird-1","MakeCoffee",{}]');
    await sleep(200);

    // Only the diagnostics CALL reaches the charger.
    expect(chargerFrames).toEqual([
      '[2,"trig-1","TriggerMessage",{"requestedMessage":"MeterValues"}]',
    ]);

    // The charger's reply goes back to that secondary only, never the primary.
    charger.send('[3,"trig-1",{"status":"Accepted"}]');
    await sleep(200);

    expect(primaryFrames).toEqual([]);
    expect(secondaryFrames).toEqual([
      '[3,"reset-1",{"status":"Rejected"}]',
      `[4,"weird-1","NotSupported","Action 'MakeCoffee' is not supported by the proxy",{}]`,
      '[3,"trig-1",{"status":"Accepted"}]',
    ]);
  });
});

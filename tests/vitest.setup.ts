import { beforeEach } from "vitest";

import { configureLogger } from "../src/logger";

const silentLoggerSink = {
  stdout: () => undefined,
  stderr: () => undefined,
};

beforeEach(() => {
  configureLogger({
    logLevel: "info",
    sink: silentLoggerSink,
  });
});

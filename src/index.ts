import type { Config } from "./config";
import { loadConfig } from "./config";
import { configureLogger, createLogger } from "./logger";
import { startProxy } from "./proxy";

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  // A missing or malformed setting is a user error, not a bug — a Home
  // Assistant user reads this line straight from the addon log, so print the
  // message rather than a stack trace, then let the supervisor restart us.
  createLogger("config").error(
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
}

configureLogger(config.loggerConfig);
startProxy(config);

import { loadConfig } from "./config";
import { configureLogger } from "./logger";
import { startProxy } from "./proxy";

const config = loadConfig();
configureLogger(config.loggerConfig);
startProxy(config);

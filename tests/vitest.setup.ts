import { beforeEach } from "vitest";

import { configureLogger } from "../src/logger";

beforeEach(() => {
  configureLogger({ logLevel: "error" });
});

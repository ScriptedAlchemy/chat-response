import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { parseAdapterConfig, type AdapterConfig } from "./config/shared.js";

export type { AdapterConfig } from "./config/shared.js";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  const parsed = parseAdapterConfig(env);

  if (parsed.sqlitePath !== ":memory:") {
    mkdirSync(dirname(parsed.sqlitePath), { recursive: true });
  }

  return parsed;
}

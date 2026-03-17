import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp(config);

await app.listen({
  host: config.host,
  port: config.port
});

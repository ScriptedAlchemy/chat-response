import { createApp } from "../../src/app.js";
import type { AdapterConfig } from "../../src/config.js";

type AdapterServerOverrides = Partial<Omit<AdapterConfig, "upstream">> & {
  upstream: Pick<AdapterConfig["upstream"], "baseUrl"> &
    Partial<Omit<AdapterConfig["upstream"], "baseUrl">>;
};

export async function startAdapterServer(overrides: AdapterServerOverrides): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const upstreamDefaults: AdapterConfig["upstream"] = {
    baseUrl: "",
    chatPath: "/v1/chat/completions",
    apiKey: "test-key",
    authMode: "bearer",
    apiKeyHeader: "Authorization",
    queryParams: {},
    headers: {},
    supportsDeveloperRole: true,
    supportsAudioInput: true,
    supportsFileParts: true
  };
  const upstream: AdapterConfig["upstream"] = {
    ...upstreamDefaults,
    ...overrides.upstream
  };
  const { upstream: _upstreamIgnored, ...rootOverrides } = overrides;

  const config: AdapterConfig = {
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    sqlitePath: ":memory:",
    adapterApiKey: undefined,
    ...rootOverrides,
    upstream
  };

  const app = createApp(config);
  await app.listen({ host: config.host, port: 0 });

  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind adapter server");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await app.close();
    }
  };
}

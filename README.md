# chat-response

Stateful adapter/proxy that exposes the OpenAI **Responses API** while talking to an upstream provider that only supports **`/v1/chat/completions`**.

This is designed for clients like **Codex** that speak the Responses API but need to run against proxies, Azure-style gateways, or other providers that still only expose the chat wire protocol.

## What it does

- Exposes Responses-compatible endpoints:
  - `POST /v1/responses`
  - `GET /v1/responses/:id`
  - `DELETE /v1/responses/:id`
  - `POST /v1/responses/:id/cancel`
  - `GET /v1/responses/:id/input_items`
  - `POST /v1/responses/input_tokens`
  - `POST /v1/responses/compact`
- Converts Responses requests into chat-completions requests
- Converts chat-completions responses and SSE chunks back into Responses objects/events
- Persists synthetic responses locally so retrieval, deletion, input-item listing, background jobs, and `previous_response_id` work
- Wraps Responses-native tool types like `apply_patch`, `shell`, and `computer` into chat-compatible function tools

## Compatibility model

This adapter supports the **full Responses HTTP surface**. That does **not** mean every upstream chat-only provider can perfectly emulate every OpenAI-hosted Responses semantic.

The adapter uses four strategies:

1. **Direct translation** for fields shared by both APIs
2. **Local emulation** for Responses-only stateful features
3. **Tool wrapping** for Responses-native tool types
4. **Explicit errors** for unsupported combinations instead of silently dropping data

### Best-effort endpoints

These endpoints are implemented, but may be approximate depending on the upstream provider:

- `POST /v1/responses/input_tokens`
- `POST /v1/responses/compact`

### Biggest caveats

- Hosted OpenAI built-in tools like native file search / remote MCP / code interpreter cannot be perfectly recreated against arbitrary chat-only backends
- Token counting is estimate-based unless you add a provider-specific exact implementation
- Compaction is adapter-driven best effort, not OpenAI-native conversation compaction

## Install

```bash
npm install
```

## Configuration

Copy the example environment file and set the upstream provider details:

```bash
cp .env.example .env
```

### Core variables

```bash
HOST=0.0.0.0
PORT=3000
SQLITE_PATH=.data/chat-response.db

UPSTREAM_BASE_URL=https://your-provider.example.com
UPSTREAM_CHAT_PATH=/v1/chat/completions
UPSTREAM_API_KEY=...
UPSTREAM_AUTH_MODE=bearer
```

### Azure / APIM style paths

If your upstream only exposes deployment-specific chat URLs, set:

```bash
UPSTREAM_BASE_URL=https://your-apim-domain.example.com
UPSTREAM_CHAT_PATH=/openai/deployments/your-deployment/chat/completions
UPSTREAM_QUERY_PARAMS={"api-version":"2025-04-01-preview"}
UPSTREAM_AUTH_MODE=header
UPSTREAM_API_KEY_HEADER=api-key
```

## Run

### Development

```bash
npm run dev
```

### Production build

```bash
npm run build
npm start
```

## Example request

```bash
curl -X POST http://localhost:3000/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "input": "Write a short hello world message"
  }'
```

## Streaming example

```bash
curl -N -X POST http://localhost:3000/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "input": "stream a greeting",
    "stream": true
  }'
```

## Codex configuration idea

Point Codex at this adapter as if it were an OpenAI Responses endpoint:

```toml
[model_providers.chatproxy]
name = "Chat Proxy"
base_url = "http://127.0.0.1:3000/v1"
env_key = "DUMMY_OR_UNUSED"
wire_api = "responses"

[profiles.chatproxy]
model_provider = "chatproxy"
model = "gpt-5"
```

Use your adapter environment to point onward to the real chat-only provider.

## Testing

```bash
npm run lint
npm test
```

## Implementation notes

- Local persistence is backed by SQLite
- Synthetic IDs are generated for responses and response items
- `previous_response_id` is reconstructed from locally stored input/output item history
- Background jobs are locally managed and cancellable
- Streaming responses are transcoded from chat-completions SSE into Responses-style SSE events

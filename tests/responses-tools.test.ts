import { afterEach, describe, expect, it } from "vitest";

import { wrappedToolName } from "../src/adapter/tool-mapper.js";
import { startAdapterServer } from "./fixtures/adapter-server.js";
import { startMockChatServer } from "./fixtures/upstream-chat-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

describe("responses tools and state", () => {
  it("wraps apply_patch tools and reconstructs previous_response_id history", async () => {
    const wrappedApplyPatch = wrappedToolName("apply_patch", "apply_patch");

    const upstream = await startMockChatServer((request) => {
      if (request.messages.some((message) => message.role === "tool")) {
        return {
          json: {
            id: "chatcmpl_followup",
            object: "chat.completion",
            created: 2,
            model: request.model,
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "Patch applied."
                }
              }
            ]
          }
        };
      }

      return {
        json: {
          id: "chatcmpl_tool",
          object: "chat.completion",
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_patch_1",
                    type: "function",
                    function: {
                      name: wrappedApplyPatch,
                      arguments: JSON.stringify({
                        type: "update_file",
                        path: "src/index.ts",
                        diff: "*** Begin Patch"
                      })
                    }
                  }
                ]
              }
            }
          ]
        }
      };
    });
    cleanups.push(upstream.close);

    const adapter = await startAdapterServer({
      upstream: {
        baseUrl: upstream.url
      }
    });
    cleanups.push(adapter.close);

    const firstResponse = await fetch(`${adapter.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        input: "make a patch",
        tools: [{ type: "apply_patch" }]
      })
    });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.output[0]).toMatchObject({
      type: "apply_patch_call",
      call_id: "call_patch_1"
    });
    expect(upstream.requests[0]?.tools?.[0]).toMatchObject({
      type: "function",
      function: {
        name: wrappedApplyPatch
      }
    });

    const secondResponse = await fetch(`${adapter.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        previous_response_id: first.id,
        input: [
          {
            type: "apply_patch_call_output",
            call_id: "call_patch_1",
            output: "patched"
          },
          {
            type: "message",
            role: "user",
            content: "continue"
          }
        ]
      })
    });

    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json();
    expect(second.output_text).toBe("Patch applied.");

    expect(upstream.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          tool_calls: [
            expect.objectContaining({
              id: "call_patch_1",
              function: expect.objectContaining({
                name: wrappedApplyPatch
              })
            })
          ]
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_patch_1"
        })
      ]),
    );
  });
});

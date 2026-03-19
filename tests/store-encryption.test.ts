import { describe, expect, it } from "vitest";

import { openStoredJson, sealStoredJson } from "../src/store/encryption.js";
import { OpenAIHttpError } from "../src/errors.js";

describe("tenant storage encryption", () => {
  it("round-trips encrypted JSON with the tenant secret", async () => {
    const context = {
      tenantId: "tenant_test1234",
      tenantSecret: "tenant_secret_test_1234"
    };
    const payload = {
      hello: "world",
      nested: {
        count: 2
      }
    };

    const sealed = await sealStoredJson(payload, context);
    expect(sealed).not.toContain("world");

    await expect(openStoredJson(sealed, context)).resolves.toEqual(payload);
  });

  it("rejects encrypted payloads when the tenant secret is missing", async () => {
    const context = {
      tenantId: "tenant_test1234",
      tenantSecret: "tenant_secret_test_1234"
    };

    const sealed = await sealStoredJson({ ok: true }, context);

    await expect(openStoredJson(sealed)).rejects.toBeInstanceOf(OpenAIHttpError);
  });
});

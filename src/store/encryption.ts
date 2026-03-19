import { unauthorized } from "../errors.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const ENCRYPTED_PAYLOAD_MARKER = "chat-response-encrypted-v1";
const TENANT_SECRET_HEADER = "X-Tenant-Secret";

export interface TenantEncryptionContext {
  tenantId: string;
  tenantSecret: string;
}

interface EncryptedPayloadEnvelope {
  marker: typeof ENCRYPTED_PAYLOAD_MARKER;
  alg: "A256GCM";
  iv: string;
  ciphertext: string;
}

function base64UrlEncode(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isEncryptedEnvelope(value: unknown): value is EncryptedPayloadEnvelope {
  return Boolean(
    value &&
      typeof value === "object" &&
      "marker" in value &&
      "alg" in value &&
      "iv" in value &&
      "ciphertext" in value &&
      (value as EncryptedPayloadEnvelope).marker === ENCRYPTED_PAYLOAD_MARKER,
  );
}

async function deriveTenantKey(context: TenantEncryptionContext): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(context.tenantSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode(`chat-response:${context.tenantId}`),
      info: textEncoder.encode("tenant-store-encryption-v1")
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealStoredJson(value: unknown, context?: TenantEncryptionContext): Promise<string> {
  const plaintext = JSON.stringify(value);
  if (!context) {
    return plaintext;
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveTenantKey(context);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv
    },
    key,
    textEncoder.encode(plaintext),
  );

  return JSON.stringify({
    marker: ENCRYPTED_PAYLOAD_MARKER,
    alg: "A256GCM",
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(ciphertext)
  } satisfies EncryptedPayloadEnvelope);
}

export async function openStoredJson<T>(value: string | null, context?: TenantEncryptionContext): Promise<T | null> {
  if (!value) {
    return null;
  }

  const parsed = JSON.parse(value) as unknown;
  if (!isEncryptedEnvelope(parsed)) {
    return parsed as T;
  }

  if (!context) {
    throw unauthorized(`This tenant uses encrypted storage. Send the ${TENANT_SECRET_HEADER} header.`);
  }

  try {
    const key = await deriveTenantKey(context);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(base64UrlDecode(parsed.iv))
      },
      key,
      toArrayBuffer(base64UrlDecode(parsed.ciphertext)),
    );

    return JSON.parse(textDecoder.decode(plaintext)) as T;
  } catch {
    throw unauthorized(`Invalid ${TENANT_SECRET_HEADER} for this tenant.`);
  }
}

export async function sealStoredText(value: string | null | undefined, context?: TenantEncryptionContext): Promise<string | null> {
  if (value === undefined || value === null) {
    return null;
  }

  return sealStoredJson({ value }, context);
}

export async function openStoredText(value: string | null, context?: TenantEncryptionContext): Promise<string | null> {
  const parsed = await openStoredJson<{ value?: string }>(value, context);
  return parsed?.value ?? null;
}

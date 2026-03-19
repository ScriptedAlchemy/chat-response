function randomHex(length = 24): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, length);
}

export function responseId(): string {
  return `resp_${randomHex()}`;
}

export function responseItemId(): string {
  return `rsi_${randomHex()}`;
}

export function toolCallId(): string {
  return `call_${randomHex()}`;
}

export function conversationId(): string {
  return `conv_${randomHex()}`;
}

export function compactionId(): string {
  return `cmp_${randomHex()}`;
}

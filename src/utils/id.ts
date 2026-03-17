import { randomBytes } from "node:crypto";

function suffix(length = 24): string {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}

export function responseId(): string {
  return `resp_${suffix()}`;
}

export function responseItemId(): string {
  return `rsi_${suffix()}`;
}

export function toolCallId(): string {
  return `call_${suffix()}`;
}

export function conversationId(): string {
  return `conv_${suffix()}`;
}

export function compactionId(): string {
  return `cmp_${suffix()}`;
}

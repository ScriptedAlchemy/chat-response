export function encodeSseFrame(event: string | null, data: unknown): string {
  const lines: string[] = [];
  if (event) {
    lines.push(`event: ${event}`);
  }

  const payload = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of payload.split("\n")) {
    lines.push(`data: ${line}`);
  }

  return `${lines.join("\n")}\n\n`;
}

export function encodeDoneFrame(): string {
  return "data: [DONE]\n\n";
}

export async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: string | null, data: string) => Promise<void> | void,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const separator = buffer.indexOf("\n\n");
      if (separator === -1) {
        break;
      }

      const rawChunk = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);

      if (!rawChunk.trim()) {
        continue;
      }

      let event: string | null = null;
      const dataLines: string[] = [];

      for (const line of rawChunk.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }

      const data = dataLines.join("\n");
      await onEvent(event, data);
    }
  }
}

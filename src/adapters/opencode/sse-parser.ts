/**
 * Lightweight SSE (text/event-stream) parser.
 *
 * Yields SseEvent objects from a ReadableStream of bytes.
 * No external dependencies.
 */

export interface SseEvent {
  data: string;
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          if (dataLines.length > 0) {
            yield { data: dataLines.join("\n") };
            dataLines = [];
          }
        } else if (line.startsWith(":")) {
        } else if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5));
        }
      }
    }

    if (dataLines.length > 0) {
      yield { data: dataLines.join("\n") };
    }
  } finally {
    reader.releaseLock();
  }
}

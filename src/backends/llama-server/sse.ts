/** One llama-server /models/sse event. The server puts the event name inside the
 * JSON payload (not the SSE `event:` field), so parsing is: concatenate `data:`
 * lines per blank-line-delimited event, JSON-parse the result. */
export interface LlamaServerSseEvent {
  model: string;
  event: string;
  data?: unknown;
}

/** Minimal SSE reader for llama-server's event stream. Ignores comments and
 * non-`data:` fields, skips unparseable payloads, and cancels the underlying
 * stream on early exit (break/throw in the consuming loop) via the generator's
 * finally block. No reconnect: when the stream ends, iteration ends. */
export async function* sseEvents(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<LlamaServerSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trim())
          .join('\n');
        if (!data) continue;
        try {
          yield JSON.parse(data) as LlamaServerSseEvent;
        } catch {
          // Malformed payload: skip it rather than killing the whole stream.
        }
      }
    }
  } finally {
    reader.releaseLock();
    await stream.cancel().catch(() => {});
  }
}

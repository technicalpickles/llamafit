import { describe, it, expect } from 'vitest';
import { sseEvents, type LlamaServerSseEvent } from '../src/backends/llama-server/sse.js';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<LlamaServerSseEvent[]> {
  const events: LlamaServerSseEvent[] = [];
  for await (const event of sseEvents(stream)) events.push(event);
  return events;
}

describe('sseEvents', () => {
  it('parses a single data event', async () => {
    const events = await collect(streamOf('data: {"model":"m","event":"download_finished"}\n\n'));
    expect(events).toEqual([{ model: 'm', event: 'download_finished' }]);
  });

  it('parses an event split across chunks', async () => {
    const events = await collect(
      streamOf('data: {"model":"m","ev', 'ent":"download_finished"}\n\n')
    );
    expect(events).toEqual([{ model: 'm', event: 'download_finished' }]);
  });

  it('parses multiple events in one chunk', async () => {
    const events = await collect(
      streamOf(
        'data: {"model":"m","event":"model_status","data":{"status":"loading"}}\n\n' +
          'data: {"model":"m","event":"download_finished"}\n\n'
      )
    );
    expect(events.map((e) => e.event)).toEqual(['model_status', 'download_finished']);
  });

  it('handles CRLF line endings', async () => {
    const events = await collect(streamOf('data: {"model":"m","event":"download_finished"}\r\n\r\n'));
    expect(events).toEqual([{ model: 'm', event: 'download_finished' }]);
  });

  it('skips SSE comments and non-data fields', async () => {
    const events = await collect(
      streamOf(': keepalive\n\nretry: 3000\n\ndata: {"model":"m","event":"download_finished"}\n\n')
    );
    expect(events).toEqual([{ model: 'm', event: 'download_finished' }]);
  });

  it('skips malformed JSON payloads instead of throwing', async () => {
    const events = await collect(
      streamOf('data: {not json}\n\ndata: {"model":"m","event":"download_finished"}\n\n')
    );
    expect(events).toEqual([{ model: 'm', event: 'download_finished' }]);
  });

  it('yields nothing for a stream that ends mid-event (no trailing blank line)', async () => {
    const events = await collect(streamOf('data: {"model":"m","event":"download_finished"}'));
    expect(events).toEqual([]);
  });
});

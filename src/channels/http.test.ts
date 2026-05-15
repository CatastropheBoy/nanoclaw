/**
 * Tests for the v2 http channel adapter.
 *
 * Exercises the HTTP surface (POST /message, GET /health), bearer auth,
 * the parseReplyToGroup helper, and the ChannelAdapter lifecycle.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpAdapter, parseReplyToGroup } from './http.js';
import type { ChannelAdapter, ChannelSetup, InboundEvent } from './adapter.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeSetup(overrides: Partial<ChannelSetup> = {}): ChannelSetup {
  return {
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
    ...overrides,
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function req(
  port: number,
  method: string,
  path: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
    const request = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode!, data: raw });
        }
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

describe('parseReplyToGroup', () => {
  it('parses simple <channel>/<id>', () => {
    expect(parseReplyToGroup('discord/123')).toEqual({ channelType: 'discord', platformId: '123' });
  });

  it('keeps slashes inside the platform id', () => {
    expect(parseReplyToGroup('slack/team/channel')).toEqual({ channelType: 'slack', platformId: 'team/channel' });
  });

  it('rejects non-strings', () => {
    expect(parseReplyToGroup(null)).toBeNull();
    expect(parseReplyToGroup(undefined)).toBeNull();
    expect(parseReplyToGroup(42)).toBeNull();
  });

  it('rejects missing separator', () => {
    expect(parseReplyToGroup('discord')).toBeNull();
  });

  it('rejects empty parts', () => {
    expect(parseReplyToGroup('/123')).toBeNull();
    expect(parseReplyToGroup('discord/')).toBeNull();
    expect(parseReplyToGroup('/')).toBeNull();
  });
});

describe('http adapter', () => {
  const TOKEN = 'test-token-abc';
  let adapter: ChannelAdapter;
  let port: number;

  beforeEach(async () => {
    port = await getFreePort();
    adapter = createHttpAdapter({ port, authToken: TOKEN });
  });

  afterEach(async () => {
    if (adapter.isConnected()) await adapter.teardown();
  });

  describe('lifecycle', () => {
    it('isConnected is false before setup', () => {
      expect(adapter.isConnected()).toBe(false);
    });

    it('isConnected is true after setup', async () => {
      await adapter.setup(makeSetup());
      expect(adapter.isConnected()).toBe(true);
    });

    it('isConnected is false after teardown', async () => {
      await adapter.setup(makeSetup());
      await adapter.teardown();
      expect(adapter.isConnected()).toBe(false);
    });

    it('teardown is a no-op before setup', async () => {
      await expect(adapter.teardown()).resolves.not.toThrow();
    });
  });

  describe('GET /health', () => {
    beforeEach(async () => {
      await adapter.setup(makeSetup());
    });

    it('returns {ok:true} without authentication', async () => {
      const { status, data } = await req(port, 'GET', '/health');
      expect(status).toBe(200);
      expect(data).toEqual({ ok: true });
    });
  });

  describe('POST /message', () => {
    let onInboundEvent: ChannelSetup['onInboundEvent'] & { mock: { calls: unknown[][] } };

    beforeEach(async () => {
      onInboundEvent = vi.fn() as unknown as typeof onInboundEvent;
      await adapter.setup(makeSetup({ onInboundEvent }));
    });

    function authHeaders(token = TOKEN): Record<string, string> {
      return { Authorization: `Bearer ${token}` };
    }

    it('rejects requests with no auth header (401)', async () => {
      const { status } = await req(
        port,
        'POST',
        '/message',
        JSON.stringify({ text: 'x', reply_to_group: 'discord/1' }),
      );
      expect(status).toBe(401);
      expect(onInboundEvent).not.toHaveBeenCalled();
    });

    it('rejects requests with the wrong token (401)', async () => {
      const { status } = await req(
        port,
        'POST',
        '/message',
        JSON.stringify({ text: 'x', reply_to_group: 'discord/1' }),
        authHeaders('wrong-token'),
      );
      expect(status).toBe(401);
      expect(onInboundEvent).not.toHaveBeenCalled();
    });

    it('returns 202 and fires onInboundEvent on success', async () => {
      const { status, data } = await req(
        port,
        'POST',
        '/message',
        JSON.stringify({ text: 'ping the team', reply_to_group: 'discord/123456789' }),
        authHeaders(),
      );
      expect(status).toBe(202);
      expect((data as { messageId: string }).messageId).toMatch(/^http-/);
      expect((data as { routedTo: { channelType: string; platformId: string } }).routedTo).toEqual({
        channelType: 'discord',
        platformId: '123456789',
      });

      // onInboundEvent is dispatched on a microtask, so let it settle.
      await new Promise((r) => setImmediate(r));

      expect(onInboundEvent).toHaveBeenCalledOnce();
      const event = onInboundEvent.mock.calls[0]![0] as InboundEvent;
      expect(event.channelType).toBe('discord');
      expect(event.platformId).toBe('123456789');
      expect(event.threadId).toBeNull();
      expect(event.message.kind).toBe('chat');
      expect(event.replyTo).toBeUndefined();
      const content = JSON.parse(event.message.content);
      expect(content).toEqual({ text: 'ping the team', sender: 'http', senderId: 'http:client' });
    });

    it('uses as_user as the senderId when provided', async () => {
      const { status } = await req(
        port,
        'POST',
        '/message',
        JSON.stringify({
          text: 'as the operator',
          reply_to_group: 'discord/X',
          as_user: 'discord:121691874942517251',
        }),
        authHeaders(),
      );
      expect(status).toBe(202);
      await new Promise((r) => setImmediate(r));
      const event = onInboundEvent.mock.calls[0]![0] as InboundEvent;
      const content = JSON.parse(event.message.content);
      expect(content).toEqual({
        text: 'as the operator',
        sender: 'http',
        senderId: 'discord:121691874942517251',
      });
    });

    it('returns 400 for invalid JSON', async () => {
      const { status } = await req(port, 'POST', '/message', 'not-json', authHeaders());
      expect(status).toBe(400);
      expect(onInboundEvent).not.toHaveBeenCalled();
    });

    it('returns 400 for missing text', async () => {
      const { status } = await req(
        port,
        'POST',
        '/message',
        JSON.stringify({ reply_to_group: 'discord/1' }),
        authHeaders(),
      );
      expect(status).toBe(400);
    });

    it('returns 400 for empty text', async () => {
      const { status } = await req(
        port,
        'POST',
        '/message',
        JSON.stringify({ text: '', reply_to_group: 'discord/1' }),
        authHeaders(),
      );
      expect(status).toBe(400);
    });

    it('returns 400 for missing reply_to_group', async () => {
      const { status } = await req(port, 'POST', '/message', JSON.stringify({ text: 'hi' }), authHeaders());
      expect(status).toBe(400);
    });

    it('returns 400 for malformed reply_to_group', async () => {
      const { status } = await req(
        port,
        'POST',
        '/message',
        JSON.stringify({ text: 'hi', reply_to_group: 'no-slash' }),
        authHeaders(),
      );
      expect(status).toBe(400);
    });
  });

  describe('routing', () => {
    it('returns 404 for unknown paths', async () => {
      await adapter.setup(makeSetup());
      const { status } = await req(port, 'GET', '/unknown');
      expect(status).toBe(404);
    });

    it('returns 404 for unsupported methods on /message', async () => {
      await adapter.setup(makeSetup());
      const { status } = await req(port, 'GET', '/message');
      expect(status).toBe(404);
    });
  });

  describe('deliver', () => {
    it('is a silent no-op (http is inject-only)', async () => {
      await adapter.setup(makeSetup());
      const result = await adapter.deliver('anything', null, { kind: 'chat', content: { text: 'x' } });
      expect(result).toBeUndefined();
    });
  });
});

/**
 * /transcribe needs a configurable upstream URL, so these tests bring their
 * own adapter (with `transcribeUrl` overridden) instead of reusing the
 * top-level `beforeEach` fixture. A stub whisper server runs on a separate
 * port and is wired in via the adapter options.
 */
describe('http adapter — POST /transcribe', () => {
  const TOKEN = 'transcribe-token';

  let adapter: ChannelAdapter | null = null;
  let port: number;
  let whisper: http.Server | null = null;
  let whisperPort: number;
  let lastWhisperRequest: { contentLength: number; bodyHead: string } | null = null;

  beforeEach(async () => {
    port = await getFreePort();
    whisperPort = await getFreePort();
    lastWhisperRequest = null;
  });

  afterEach(async () => {
    if (adapter && adapter.isConnected()) await adapter.teardown();
    adapter = null;
    if (whisper) {
      await new Promise<void>((resolve) => whisper!.close(() => resolve()));
      whisper = null;
    }
  });

  /** Start a stub whisper server that always responds with the given JSON for /v1/audio/transcriptions. */
  async function startWhisper(response: { status?: number; body?: unknown } = {}): Promise<string> {
    const status = response.status ?? 200;
    const body = response.body ?? { text: 'stub transcription' };
    whisper = http.createServer((req, res) => {
      // Capture the incoming request shape for assertions.
      let received = 0;
      const head: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (head.length < 4) head.push(chunk);
      });
      req.on('end', () => {
        lastWhisperRequest = {
          contentLength: received,
          bodyHead: Buffer.concat(head).slice(0, 200).toString('binary'),
        };
        if (status >= 400) {
          res.writeHead(status, { 'Content-Type': 'text/plain' }).end('upstream error');
        } else {
          res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      whisper!.once('error', reject);
      whisper!.listen(whisperPort, '127.0.0.1', () => resolve());
    });
    return `http://127.0.0.1:${whisperPort}/v1/audio/transcriptions`;
  }

  async function bootAdapter(
    transcribeUrl: string | undefined,
    overrides: Partial<ChannelSetup> = {},
  ): Promise<ChannelSetup['onInboundEvent'] & { mock: { calls: unknown[][] } }> {
    adapter = createHttpAdapter({ port, authToken: TOKEN, transcribeUrl });
    const onInboundEvent = vi.fn() as unknown as ChannelSetup['onInboundEvent'] & { mock: { calls: unknown[][] } };
    await adapter.setup(makeSetup({ onInboundEvent, ...overrides }));
    return onInboundEvent;
  }

  /** POST with a Buffer body (e.g. raw audio). */
  async function postBinary(
    path: string,
    body: Buffer,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path,
          headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(body.length), ...headers },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode!, data: JSON.parse(raw) });
            } catch {
              resolve({ status: res.statusCode!, data: raw });
            }
          });
        },
      );
      request.on('error', reject);
      request.write(body);
      request.end();
    });
  }

  const TINY_WAV = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt placeholder', 'binary');

  it('rejects requests with no auth header (401)', async () => {
    const url = await startWhisper();
    const onInboundEvent = await bootAdapter(url);
    const { status } = await postBinary('/transcribe?reply_to_group=discord/X&as_user=u', TINY_WAV);
    expect(status).toBe(401);
    expect(onInboundEvent).not.toHaveBeenCalled();
    expect(lastWhisperRequest).toBeNull();
  });

  it('rejects missing reply_to_group (400)', async () => {
    const url = await startWhisper();
    const onInboundEvent = await bootAdapter(url);
    const { status } = await postBinary('/transcribe?as_user=u', TINY_WAV, {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(400);
    expect(onInboundEvent).not.toHaveBeenCalled();
    expect(lastWhisperRequest).toBeNull();
  });

  it('rejects malformed reply_to_group (400)', async () => {
    const url = await startWhisper();
    await bootAdapter(url);
    const { status } = await postBinary('/transcribe?reply_to_group=no-slash&as_user=u', TINY_WAV, {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(400);
  });

  it('rejects empty body (400)', async () => {
    const url = await startWhisper();
    await bootAdapter(url);
    const { status } = await postBinary('/transcribe?reply_to_group=discord/X&as_user=u', Buffer.alloc(0), {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(400);
  });

  it('returns 200, transcribes, and dispatches onInboundEvent', async () => {
    const url = await startWhisper({ body: { text: 'hello from whisper' } });
    const onInboundEvent = await bootAdapter(url);

    const { status, data } = await postBinary(
      '/transcribe?reply_to_group=discord/discord:@me:42&as_user=discord:owner',
      TINY_WAV,
      { Authorization: `Bearer ${TOKEN}` },
    );

    expect(status).toBe(200);
    expect(data).toMatchObject({
      text: 'hello from whisper',
      routedTo: { channelType: 'discord', platformId: 'discord:@me:42' },
    });
    expect((data as { messageId: string }).messageId).toMatch(/^http-/);

    // Whisper actually received the audio bytes as multipart form-data.
    expect(lastWhisperRequest).not.toBeNull();
    expect(lastWhisperRequest!.contentLength).toBeGreaterThan(TINY_WAV.length);
    expect(lastWhisperRequest!.bodyHead).toContain('Content-Disposition');
    expect(lastWhisperRequest!.bodyHead).toContain('name="file"');
  });

  it('dispatches with the transcribed text as message content', async () => {
    const url = await startWhisper({ body: { text: 'route this please' } });
    const onInboundEvent = await bootAdapter(url);

    await postBinary(
      '/transcribe?reply_to_group=discord/dm-1&as_user=discord:owner',
      TINY_WAV,
      { Authorization: `Bearer ${TOKEN}` },
    );

    // wait for the fire-and-forget dispatch
    await new Promise((r) => setImmediate(r));

    expect(onInboundEvent).toHaveBeenCalledOnce();
    const event = onInboundEvent.mock.calls[0]![0] as InboundEvent;
    expect(event.channelType).toBe('discord');
    expect(event.platformId).toBe('dm-1');
    const content = JSON.parse(event.message.content);
    expect(content).toEqual({ text: 'route this please', sender: 'http', senderId: 'discord:owner' });
  });

  it('defaults as_user to http:client when query param missing', async () => {
    const url = await startWhisper({ body: { text: 'no asuser' } });
    const onInboundEvent = await bootAdapter(url);
    await postBinary('/transcribe?reply_to_group=discord/X', TINY_WAV, {
      Authorization: `Bearer ${TOKEN}`,
    });
    await new Promise((r) => setImmediate(r));
    const event = onInboundEvent.mock.calls[0]![0] as InboundEvent;
    expect(JSON.parse(event.message.content)).toMatchObject({ senderId: 'http:client' });
  });

  it('does NOT dispatch on empty transcription', async () => {
    const url = await startWhisper({ body: { text: '   ' } });
    const onInboundEvent = await bootAdapter(url);

    const { status, data } = await postBinary(
      '/transcribe?reply_to_group=discord/X&as_user=u',
      TINY_WAV,
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(status).toBe(200);
    expect(data).toMatchObject({ text: '', messageId: null, routedTo: null });
    await new Promise((r) => setImmediate(r));
    expect(onInboundEvent).not.toHaveBeenCalled();
  });

  it('returns 502 when whisper returns a non-2xx', async () => {
    const url = await startWhisper({ status: 500, body: 'boom' });
    const onInboundEvent = await bootAdapter(url);

    const { status, data } = await postBinary(
      '/transcribe?reply_to_group=discord/X&as_user=u',
      TINY_WAV,
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(status).toBe(502);
    expect(data).toMatchObject({ error: expect.stringContaining('500') });
    expect(onInboundEvent).not.toHaveBeenCalled();
  });

  it('returns 502 when whisper is unreachable', async () => {
    // Boot adapter with an unused port — no upstream listening.
    const unreachable = `http://127.0.0.1:${whisperPort}/v1/audio/transcriptions`;
    const onInboundEvent = await bootAdapter(unreachable);

    const { status } = await postBinary(
      '/transcribe?reply_to_group=discord/X&as_user=u',
      TINY_WAV,
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(status).toBe(502);
    expect(onInboundEvent).not.toHaveBeenCalled();
  });

  it('returns 503 when transcribeUrl is explicitly empty', async () => {
    const onInboundEvent = await bootAdapter('');
    const { status, data } = await postBinary(
      '/transcribe?reply_to_group=discord/X&as_user=u',
      TINY_WAV,
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(status).toBe(503);
    expect(data).toMatchObject({ error: expect.stringContaining('not configured') });
    expect(onInboundEvent).not.toHaveBeenCalled();
  });
});

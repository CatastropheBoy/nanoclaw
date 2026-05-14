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

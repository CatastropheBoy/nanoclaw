/**
 * HTTP channel adapter (v2) — local injection endpoint.
 *
 * Stands up a bearer-authed HTTP listener so external scripts / cron jobs /
 * CLI tools can inject messages without holding a real chat-platform identity.
 * Single direction only — POST /message → router. Agent replies are routed to
 * the channel named in `reply_to_group` (e.g. `discord/<channel-id>`), not
 * back to the HTTP caller. There is no reply-poll endpoint; HTTP is an
 * "inject-and-forget" admin transport, mirroring the CLI adapter's `to`/
 * `reply_to` pattern (`src/channels/cli.ts`).
 *
 * Note on runtime: the host process is Node, not Bun, so this uses Node's
 * built-in `http` module rather than `Bun.serve`. Same shape as the emacs
 * adapter, which has been running on Node for the lifetime of v2.
 *
 * Wire format:
 *   POST /message
 *     Authorization: Bearer <NANOCLAW_HTTP_TOKEN>
 *     { "text": "ping the team", "reply_to_group": "discord/123456789" }
 *     → 202 { "messageId": "...", "routedTo": { channelType, platformId } }
 *
 *   GET /health → 200 { "ok": true }   (unauthenticated)
 *
 * `reply_to_group` is parsed as `<channelType>/<platformId>`; everything after
 * the first slash is the platform id (Slack/Discord/Matrix ids can contain
 * slashes). The parsed address becomes the InboundEvent's `channelType` /
 * `platformId`, so the message lands in that messaging group's session and
 * the agent's reply naturally flows through that channel's delivery adapter.
 */
import http from 'http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundEvent, OutboundMessage } from './adapter.js';

interface HttpAdapterOptions {
  port: number;
  authToken: string;
}

function parseReplyToGroup(raw: unknown): { channelType: string; platformId: string } | null {
  if (typeof raw !== 'string') return null;
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return null;
  const channelType = raw.slice(0, slash).trim();
  const platformId = raw.slice(slash + 1).trim();
  if (!channelType || !platformId) return null;
  return { channelType, platformId };
}

function createHttpAdapter(opts: HttpAdapterOptions): ChannelAdapter {
  let server: http.Server | null = null;
  let setupConfig: ChannelSetup | null = null;

  function unauthorized(res: http.ServerResponse): void {
    res
      .writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ error: 'Unauthorized' }));
  }

  function badRequest(res: http.ServerResponse, error: string): void {
    res
      .writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ error }));
  }

  function handleMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.headers['authorization'] !== `Bearer ${opts.authToken}`) {
      unauthorized(res);
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed: { text?: unknown; reply_to_group?: unknown };
      try {
        parsed = JSON.parse(body);
      } catch {
        badRequest(res, 'Invalid JSON');
        return;
      }

      if (typeof parsed.text !== 'string' || parsed.text.length === 0) {
        badRequest(res, 'text required');
        return;
      }

      const target = parseReplyToGroup(parsed.reply_to_group);
      if (!target) {
        badRequest(res, 'reply_to_group required (format: "<channel>/<platform-id>")');
        return;
      }

      const id = `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const event: InboundEvent = {
        channelType: target.channelType,
        platformId: target.platformId,
        threadId: null,
        message: {
          id,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({
            text: parsed.text,
            sender: 'http',
            senderId: 'http:client',
          }),
        },
      };

      void Promise.resolve()
        .then(() => setupConfig?.onInboundEvent(event))
        .catch((err) => log.error('HTTP onInboundEvent threw', { err }));

      res
        .writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(
          JSON.stringify({
            messageId: id,
            routedTo: { channelType: target.channelType, platformId: target.platformId },
          }),
        );
    });
  }

  return {
    name: 'http',
    channelType: 'http',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;

      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);
        if (req.method === 'GET' && url.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/message') {
          handleMessage(req, res);
          return;
        }
        res
          .writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ error: 'Not found' }));
      });

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(opts.port, '127.0.0.1', () => {
          log.info('HTTP channel listening', { port: opts.port });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
      log.info('HTTP channel stopped');
    },

    isConnected(): boolean {
      return server?.listening ?? false;
    },

    async deliver(_platformId: string, _threadId: string | null, _message: OutboundMessage): Promise<string | undefined> {
      // Inject-only transport — replies flow through `reply_to_group`'s adapter,
      // never back to HTTP. If a wiring accidentally targets `http` as a
      // destination, drop silently rather than buffer (no poll endpoint to drain).
      return undefined;
    },
  };
}

registerChannelAdapter('http', {
  factory: () => {
    const env = readEnvFile(['NANOCLAW_HTTP_PORT', 'NANOCLAW_HTTP_TOKEN']);
    const authToken = process.env.NANOCLAW_HTTP_TOKEN || env.NANOCLAW_HTTP_TOKEN;
    if (!authToken) return null;

    const portStr = process.env.NANOCLAW_HTTP_PORT || env.NANOCLAW_HTTP_PORT || '8787';
    const port = parseInt(portStr, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      log.warn('HTTP channel: invalid NANOCLAW_HTTP_PORT, skipping', { portStr });
      return null;
    }

    return createHttpAdapter({ port, authToken });
  },
});

export { createHttpAdapter, parseReplyToGroup };

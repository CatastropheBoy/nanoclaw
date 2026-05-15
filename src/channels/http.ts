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
 *   POST /transcribe?reply_to_group=<channel>/<id>&as_user=<userId>
 *     Authorization: Bearer <NANOCLAW_HTTP_TOKEN>
 *     Content-Type: audio/wav
 *     <raw WAV bytes>
 *     → 200 { text, messageId, routedTo }   sync — body forwarded to
 *       faster-whisper-server (OpenAI-compatible /v1/audio/transcriptions),
 *       returned text is then routed through the same path as /message.
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
  /**
   * Bind address. Defaults to `127.0.0.1` (loopback-only). Set to `0.0.0.0`
   * to expose on every interface — only do this on trusted networks; the
   * bearer token is the sole access control.
   */
  bind?: string;
  /**
   * Upstream transcription endpoint (OpenAI-compatible
   * `/v1/audio/transcriptions`). Empty string disables /transcribe (returns
   * 503). Default supplied by the factory.
   */
  transcribeUrl?: string;
  /** Model id to forward to the upstream as the `model` form field. */
  transcribeModel?: string;
}

const DEFAULT_TRANSCRIBE_URL = 'http://127.0.0.1:8786/v1/audio/transcriptions';
const DEFAULT_TRANSCRIBE_MODEL = 'Systran/faster-distil-whisper-large-v3';
/** Cap on inbound audio body size — guards against OOM from /dev/urandom POSTs. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

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

  const transcribeUrl = opts.transcribeUrl ?? DEFAULT_TRANSCRIBE_URL;
  const transcribeModel = opts.transcribeModel ?? DEFAULT_TRANSCRIBE_MODEL;

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

  function jsonError(res: http.ServerResponse, status: number, error: string): void {
    res
      .writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ error }));
  }

  /**
   * Build the InboundEvent that /message and /transcribe both produce and
   * hand it to the router. Fire-and-forget — caller already responded.
   * Returns the generated message id for the response payload.
   */
  function dispatchInbound(text: string, target: { channelType: string; platformId: string }, asUser: string): string {
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
          text,
          sender: 'http',
          senderId: asUser,
        }),
      },
    };
    void Promise.resolve()
      .then(() => setupConfig?.onInboundEvent(event))
      .catch((err) => log.error('HTTP onInboundEvent threw', { err }));
    return id;
  }

  function handleMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.headers['authorization'] !== `Bearer ${opts.authToken}`) {
      unauthorized(res);
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed: { text?: unknown; reply_to_group?: unknown; as_user?: unknown };
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

      // The bearer token authenticates the operator; `as_user` names which
      // chat-user identity the operator is acting as. Must be a recognized
      // user (owner / admin / member of the target agent group) for the
      // access gate to let the message through — otherwise it lands in
      // unregistered_senders and stays dropped. Defaults to a synthetic id
      // so unattended POSTs don't accidentally route as the operator.
      const asUser = typeof parsed.as_user === 'string' && parsed.as_user.length > 0 ? parsed.as_user : 'http:client';

      const id = dispatchInbound(parsed.text, target, asUser);

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

  /**
   * POST /transcribe — body is raw audio (audio/wav etc.), routing metadata in
   * query params. Forwards to the upstream OpenAI-compatible transcription
   * endpoint, then routes the resulting text identically to /message.
   *
   * Sync response: caller sees both the transcription and the routing intent.
   * Empty transcription (silence / non-speech audio) is returned with no
   * routing — sending zero-text into the router would just land it in the
   * unregistered-senders bucket or wake a container for nothing.
   */
  function handleTranscribe(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.headers['authorization'] !== `Bearer ${opts.authToken}`) {
      unauthorized(res);
      return;
    }
    if (!transcribeUrl) {
      jsonError(res, 503, 'transcription not configured (NANOCLAW_TRANSCRIBE_URL unset)');
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);
    const target = parseReplyToGroup(url.searchParams.get('reply_to_group'));
    if (!target) {
      badRequest(res, 'reply_to_group query param required (format: "<channel>/<platform-id>")');
      return;
    }
    const asUser = url.searchParams.get('as_user') || 'http:client';

    const chunks: Buffer[] = [];
    let total = 0;
    let exceeded = false;

    req.on('data', (chunk: Buffer) => {
      if (exceeded) return;
      total += chunk.length;
      if (total > MAX_AUDIO_BYTES) {
        exceeded = true;
        jsonError(res, 413, `body exceeds ${MAX_AUDIO_BYTES} bytes`);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (exceeded) return;
      if (total === 0) {
        badRequest(res, 'empty body — expected audio bytes');
        return;
      }

      void (async () => {
        const audio = Buffer.concat(chunks);
        const contentType =
          typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : 'audio/wav';

        let text: string;
        try {
          const form = new FormData();
          form.append('file', new Blob([audio], { type: contentType }), 'audio.wav');
          form.append('model', transcribeModel);
          const r = await fetch(transcribeUrl, { method: 'POST', body: form });
          if (!r.ok) {
            const detail = await r.text().catch(() => '');
            log.warn('Whisper upstream non-OK', { status: r.status, detail: detail.slice(0, 200) });
            jsonError(res, 502, `transcription upstream returned ${r.status}`);
            return;
          }
          const body = (await r.json()) as { text?: unknown };
          text = typeof body.text === 'string' ? body.text.trim() : '';
        } catch (err) {
          log.warn('Whisper upstream unreachable', { err, url: transcribeUrl });
          jsonError(res, 502, 'transcription upstream unreachable');
          return;
        }

        if (text.length === 0) {
          res
            .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            .end(JSON.stringify({ text: '', messageId: null, routedTo: null, note: 'empty transcription — not routed' }));
          return;
        }

        const id = dispatchInbound(text, target, asUser);
        res
          .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(
            JSON.stringify({
              text,
              messageId: id,
              routedTo: { channelType: target.channelType, platformId: target.platformId },
            }),
          );
      })();
    });

    req.on('error', (err) => {
      log.warn('HTTP /transcribe request error', { err });
      if (!res.headersSent) jsonError(res, 500, 'request error');
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
        if (req.method === 'POST' && url.pathname === '/transcribe') {
          handleTranscribe(req, res);
          return;
        }
        res
          .writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ error: 'Not found' }));
      });

      const bind = opts.bind ?? '127.0.0.1';
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(opts.port, bind, () => {
          log.info('HTTP channel listening', { port: opts.port, bind });
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
    const env = readEnvFile([
      'NANOCLAW_HTTP_PORT',
      'NANOCLAW_HTTP_TOKEN',
      'NANOCLAW_HTTP_BIND',
      'NANOCLAW_TRANSCRIBE_URL',
      'NANOCLAW_TRANSCRIBE_MODEL',
    ]);
    const authToken = process.env.NANOCLAW_HTTP_TOKEN || env.NANOCLAW_HTTP_TOKEN;
    if (!authToken) return null;

    const portStr = process.env.NANOCLAW_HTTP_PORT || env.NANOCLAW_HTTP_PORT || '8787';
    const port = parseInt(portStr, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      log.warn('HTTP channel: invalid NANOCLAW_HTTP_PORT, skipping', { portStr });
      return null;
    }

    const bind = process.env.NANOCLAW_HTTP_BIND || env.NANOCLAW_HTTP_BIND || '127.0.0.1';

    // Empty string means "explicitly disabled". Missing var means "use default".
    const rawTranscribe = process.env.NANOCLAW_TRANSCRIBE_URL ?? env.NANOCLAW_TRANSCRIBE_URL;
    const transcribeUrl = rawTranscribe === undefined ? DEFAULT_TRANSCRIBE_URL : rawTranscribe;
    const transcribeModel =
      process.env.NANOCLAW_TRANSCRIBE_MODEL || env.NANOCLAW_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL;

    return createHttpAdapter({ port, authToken, bind, transcribeUrl, transcribeModel });
  },
});

export { createHttpAdapter, parseReplyToGroup };

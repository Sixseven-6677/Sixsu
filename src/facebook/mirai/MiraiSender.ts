import { ISender }        from '../types/ISender';
import { MiraiTransport } from './MiraiTransport';
import { LoggerManager }  from '../../logger/LoggerManager';

const log = LoggerManager.getLogger('MiraiSender');

const RETRYABLE_ERRORS = [
  'client disconnecting',
  'not connected',
  'api not connected',
  'facebook api not connected',
  'timed out',
];

function isRetryable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return RETRYABLE_ERRORS.some(e => msg.includes(e));
}

/** Race a promise against a timeout. Rejects with Error('timed out') if timeoutMs elapses. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out: ${label} after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export class MiraiSender implements ISender {
  private readonly transport: MiraiTransport;

  constructor(transport: MiraiTransport) {
    this.transport = transport;
  }

  /** Poll until the transport has a live API, or timeoutMs elapses. */
  private async waitForApi(timeoutMs = 20_000): Promise<ReturnType<MiraiTransport['getApi']>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const api = this.transport.getApi();
      if (api) return api;
      await new Promise<void>(r => setTimeout(r, 500));
    }
    return null;
  }

  /** Send text with timeout + retry on transient MQTT errors. */
  async sendText(recipientId: string, text: string): Promise<void> {
    const MAX_ATTEMPTS    = 4;
    const SEND_TIMEOUT_MS = 10_000;  // if sendMessage callback not called in 10s → retry
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // ── Ensure the API is alive before attempting send ───────────────────
      let api = this.transport.getApi();
      if (!api) {
        log.warn('MiraiSender.sendText: API null — waiting for reconnect.', { to: recipientId, attempt });
        api = await this.waitForApi(20_000);
        if (!api) {
          throw new Error('Facebook API not connected after 20s wait.');
        }
        log.info('MiraiSender.sendText: API recovered — proceeding.', { to: recipientId, attempt });
      }

      log.debug('MiraiSender: sending text.', {
        to: recipientId, chars: text.length, preview: text.slice(0, 60), attempt,
      });

      try {
        const sendPromise = new Promise<void>((resolve, reject) => {
          api!.sendMessage(text, recipientId, (err: Error | null, info: { messageID?: string } | null) => {
            if (err) { reject(err); return; }
            log.info('MiraiSender: reply sent.', {
              to: recipientId, messageID: info?.messageID, chars: text.length,
            });
            resolve();
          });
        });

        await withTimeout(sendPromise, SEND_TIMEOUT_MS, `sendMessage to ${recipientId}`);
        return; // ✓ success

      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);

        if (isRetryable(err) && attempt < MAX_ATTEMPTS) {
          const waitMs = attempt * 2_000;
          log.warn(`MiraiSender: attempt ${attempt} failed (${msg}) — retrying in ${waitMs}ms.`, { to: recipientId });
          await new Promise<void>(r => setTimeout(r, waitMs));
          // Force re-check of API on next iteration
          continue;
        }

        log.error('MiraiSender: sendText permanently failed.', { to: recipientId, error: msg, attempt });
        throw err;
      }
    }

    throw lastErr;
  }

  /** Send typing indicator — best-effort, never throws. */
  async sendTyping(recipientId: string): Promise<void> {
    const api = this.transport.getApi();
    if (!api) return;

    log.debug('MiraiSender: sending typing indicator.', { to: recipientId });

    return new Promise<void>((resolve) => {
      try {
        api.sendTypingIndicator(recipientId, (err?: Error) => {
          if (err) log.warn('MiraiSender.sendTyping: failed.', { to: recipientId, error: err.message });
          resolve();
        });
      } catch (e: unknown) {
        log.warn('MiraiSender.sendTyping: threw.', {
          to: recipientId, error: e instanceof Error ? e.message : String(e),
        });
        resolve();
      }
    });
  }

  /** React to a message — best-effort, never throws. */
  async sendReaction(messageId: string, _recipientId: string, emoji: string): Promise<void> {
    const api = this.transport.getApi();
    if (!api) return;
    log.debug('MiraiSender: setting reaction.', { messageId, emoji });
    try { api.setMessageReaction(emoji, messageId, undefined, true); } catch { /* best-effort */ }
  }
}

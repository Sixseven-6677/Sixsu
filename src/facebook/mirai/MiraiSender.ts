import { FcaApi }        from './FcaTypes';
import { ISender }       from '../types/ISender';
import { LoggerManager } from '../../logger/LoggerManager';

const log = LoggerManager.getLogger('MiraiSender');

const RETRYABLE = ['client disconnecting', 'not connected', 'api not connected', 'timed out'];

function isRetryable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return RETRYABLE.some(e => msg.includes(e));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out: ' + label + ' after ' + ms + 'ms')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>(r => setTimeout(r, ms));
}

/** Minimal interface — satisfied by both MiraiTransport and MiraiConnectionManager. */
export interface ApiProvider {
  getApi(): FcaApi | null;
}

export class MiraiSender implements ISender {
  private readonly provider: ApiProvider;

  constructor(provider: ApiProvider) { this.provider = provider; }

  private async waitForApi(timeoutMs = 20_000): Promise<FcaApi | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const api = this.provider.getApi();
      if (api) return api;
      await sleep(500);
    }
    return null;
  }

  async sendText(recipientId: string, text: string): Promise<void> {
    const MAX_ATTEMPTS    = 4;
    const SEND_TIMEOUT_MS = 10_000;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let api = this.provider.getApi();
      if (!api) {
        log.warn('MiraiSender.sendText: API null — waiting.', { to: recipientId, attempt });
        api = await this.waitForApi(20_000);
        if (!api) throw new Error('Facebook API unavailable after 20s.');
        log.info('MiraiSender.sendText: API recovered.', { to: recipientId, attempt });
      }

      log.debug('MiraiSender: sending text.', { to: recipientId, chars: text.length, attempt });

      try {
        await withTimeout(
          new Promise<void>((resolve, reject) => {
            api!.sendMessage(text, recipientId, (err: Error | null, info: { messageID?: string } | null) => {
              if (err) { reject(err); return; }
              log.info('MiraiSender: reply sent.', { to: recipientId, messageID: info?.messageID, chars: text.length });
              resolve();
            });
          }),
          SEND_TIMEOUT_MS,
          'sendMessage to ' + recipientId,
        );
        return;

      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (isRetryable(err) && attempt < MAX_ATTEMPTS) {
          const waitMs = attempt * 2_000;
          log.warn('MiraiSender: attempt ' + attempt + ' failed (' + msg + ') — retrying in ' + waitMs + 'ms.', { to: recipientId });
          await sleep(waitMs);
          continue;
        }
        log.error('MiraiSender: sendText permanently failed.', { to: recipientId, error: msg, attempts: attempt });
        throw err;
      }
    }
    throw lastErr;
  }

  async sendTyping(recipientId: string): Promise<void> {
    const api = this.provider.getApi();
    if (!api) return;

    log.debug('MiraiSender: sending typing indicator.', { to: recipientId });

    const indicatorPromise = new Promise<void>((resolve) => {
      try {
        api.sendTypingIndicator(recipientId, (err?: Error) => {
          if (err) log.warn('MiraiSender.sendTyping: failed.', { to: recipientId, error: err.message });
          resolve();
        });
      } catch (e) {
        log.warn('MiraiSender.sendTyping: threw.', { to: recipientId, error: e instanceof Error ? e.message : String(e) });
        resolve();
      }
    });

    try {
      await withTimeout(indicatorPromise, 3_000, 'sendTypingIndicator to ' + recipientId);
    } catch {
      log.warn('MiraiSender.sendTyping: timed out — continuing.', { to: recipientId });
    }
  }

  async sendReaction(messageId: string, _recipientId: string, emoji: string): Promise<void> {
    const api = this.provider.getApi();
    if (!api) return;
    log.debug('MiraiSender: setting reaction.', { messageId, emoji });
    try { api.setMessageReaction(emoji, messageId, undefined, true); } catch { /* best-effort */ }
  }
}

import { ISender }        from '../types/ISender';
import { MiraiTransport } from './MiraiTransport';
import { LoggerManager }  from '../../logger/LoggerManager';

const log = LoggerManager.getLogger('MiraiSender');

const RETRYABLE_ERRORS = [
  'client disconnecting',
  'not connected',
  'api not connected',
  'facebook api not connected',
];

function isRetryable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return RETRYABLE_ERRORS.some(e => msg.includes(e));
}

export class MiraiSender implements ISender {
  private readonly transport: MiraiTransport;

  constructor(transport: MiraiTransport) {
    this.transport = transport;
  }

  /**
   * Wait until the transport has a live API object, or until timeoutMs elapses.
   * Returns the API if available, null on timeout.
   */
  private async waitForApi(timeoutMs = 15_000): Promise<ReturnType<MiraiTransport['getApi']>> {
    const pollMs  = 500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const api = this.transport.getApi();
      if (api) return api;
      await new Promise<void>(r => setTimeout(r, pollMs));
    }
    return null;
  }

  /** Send a plain-text message to a Messenger thread (with reconnect-retry). */
  async sendText(recipientId: string, text: string): Promise<void> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // ── Wait for a live API (handles the case where MQTT just dropped) ──
      let api = this.transport.getApi();
      if (!api) {
        log.warn('MiraiSender.sendText: API not ready — waiting for reconnect.', {
          to: recipientId, attempt,
        });
        api = await this.waitForApi(15_000);
        if (!api) {
          log.warn('MiraiSender.sendText: timed out waiting for API — message dropped.', {
            to: recipientId,
          });
          throw new Error('Facebook API not connected (MiraiTransport not logged in).');
        }
      }

      log.debug('MiraiSender: sending text…', {
        to:      recipientId,
        chars:   text.length,
        preview: text.slice(0, 60),
        attempt,
      });

      try {
        await new Promise<void>((resolve, reject) => {
          api!.sendMessage(text, recipientId, (err, info) => {
            if (err) {
              log.warn('MiraiSender: sendText failed.', { to: recipientId, error: (err as Error).message, attempt });
              reject(err);
              return;
            }
            log.info('MiraiSender: reply sent.', {
              to:        recipientId,
              messageID: info?.messageID,
              chars:     text.length,
            });
            resolve();
          });
        });
        return; // success
      } catch (err) {
        lastErr = err;
        if (isRetryable(err) && attempt < MAX_ATTEMPTS) {
          const delayMs = attempt * 3_000;
          log.warn(`MiraiSender: retryable error — waiting ${delayMs}ms before retry.`, {
            to: recipientId, attempt, error: err instanceof Error ? err.message : String(err),
          });
          // Null out our local ref — force waitForApi on next loop iteration
          await new Promise<void>(r => setTimeout(r, delayMs));
          continue;
        }
        throw err;
      }
    }

    throw lastErr;
  }

  async sendTyping(recipientId: string): Promise<void> {
    const api = this.transport.getApi();
    if (!api) return;

    log.debug('MiraiSender: sending typing indicator.', { to: recipientId });

    return new Promise<void>((resolve) => {
      try {
        api.sendTypingIndicator(recipientId, (err?: Error) => {
          if (err) {
            log.warn('MiraiSender.sendTyping: indicator failed.', {
              to:    recipientId,
              error: err.message,
            });
          }
          resolve();
        });
      } catch (e: unknown) {
        log.warn('MiraiSender.sendTyping: threw.', {
          to:    recipientId,
          error: e instanceof Error ? e.message : String(e),
        });
        resolve();
      }
    });
  }

  async sendReaction(
    messageId:    string,
    _recipientId: string,
    emoji:        string,
  ): Promise<void> {
    const api = this.transport.getApi();
    if (!api) return;

    log.debug('MiraiSender: setting reaction.', { messageId, emoji });

    try {
      api.setMessageReaction(emoji, messageId, undefined, true);
    } catch {
      // Reactions are best-effort.
    }
  }
}

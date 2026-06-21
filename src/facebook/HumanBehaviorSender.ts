import { ISender }       from './types/ISender';
import { LoggerManager } from '../logger/LoggerManager';

const log = LoggerManager.getLogger('HumanBehaviorSender');

/**
 * Adds human-like typing delay before every text message.
 *
 * Delay model (bell-curve via two uniform random samples):
 *   Short  (<80 chars)   -> 600-1600 ms  (avg ~1100 ms)
 *   Medium (<250 chars)  -> 1200-2600 ms (avg ~1900 ms)
 *   Long   (>=250 chars) -> 1800-4000 ms (avg ~2900 ms)
 *
 * Using r1+r2 produces a triangle/bell distribution — real typists
 * cluster near the midpoint, rarely at extremes. Harder to fingerprint
 * than a single Math.random() uniform distribution.
 */
export class HumanBehaviorSender implements ISender {
  private readonly inner: ISender;

  constructor(inner: ISender) {
    this.inner = inner;
  }

  async sendText(recipientId: string, text: string): Promise<void> {
    const delayMs = HumanBehaviorSender.calculateDelay(text);

    log.debug('HumanBehaviorSender: queuing message with human delay.', {
      to: recipientId, chars: text.length, delayMs: Math.round(delayMs),
    });

    // Show typing indicator first (best-effort)
    try { await this.inner.sendTyping(recipientId); } catch { /* ignore */ }

    // Brief human-like pause
    await HumanBehaviorSender.sleep(delayMs);

    // Actual send (has its own retry+timeout logic in MiraiSender)
    await this.inner.sendText(recipientId, text);
  }

  async sendTyping(recipientId: string): Promise<void> {
    return this.inner.sendTyping(recipientId);
  }

  async sendReaction(messageId: string, recipientId: string, emoji: string): Promise<void> {
    return this.inner.sendReaction(messageId, recipientId, emoji);
  }

  /**
   * Bell-curve delay: sum of two uniform samples gives triangle distribution.
   * More values near midpoint, fewer at extremes — closer to real typing rhythm.
   */
  private static calculateDelay(text: string): number {
    const bell = Math.random() + Math.random(); // [0,2], peak at 1
    const len  = text.length;
    if (len < 80)  return 600  + bell * 500;   // 600-1600 ms
    if (len < 250) return 1200 + bell * 700;   // 1200-2600 ms
    return               1800 + bell * 1100;   // 1800-4000 ms
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const id = setTimeout(resolve, ms);
      if (typeof (id as NodeJS.Timeout).unref === 'function') {
        (id as NodeJS.Timeout).unref();
      }
    });
  }
}
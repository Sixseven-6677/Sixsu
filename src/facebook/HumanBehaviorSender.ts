import { ISender }       from './types/ISender';
import { LoggerManager } from '../logger/LoggerManager';

const log = LoggerManager.getLogger('HumanBehaviorSender');

/**
 * Adds human-like typing delay before every text message.
 * Delay bands (scales with message length):
 *   Short  (<100 chars)  -> 800-1500 ms
 *   Medium (<300 chars)  -> 1500-2500 ms
 *   Long   (>=300 chars) -> 2000-3500 ms
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

  private static calculateDelay(text: string): number {
    const len = text.length;
    if (len < 100) return 800  + Math.random() * 700;   // 0.8-1.5 s
    if (len < 300) return 1500 + Math.random() * 1000;  // 1.5-2.5 s
    return               2000 + Math.random() * 1500;   // 2.0-3.5 s
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

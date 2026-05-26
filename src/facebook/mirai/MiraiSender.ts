import { ISender }        from "../types/ISender";
import { MiraiTransport } from "./MiraiTransport";
import { LoggerManager }  from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("MiraiSender");

/**
 * MiraiSender — ISender implementation backed by fca-unofficial.
 *
 * All outbound messages are sent through the live FcaApi managed by
 * MiraiTransport.  Using the same session for both listening and sending
 * avoids the cookie-conflict issues that arise when two different auth
 * mechanisms share one Facebook account.
 */
export class MiraiSender implements ISender {
  private readonly transport: MiraiTransport;

  constructor(transport: MiraiTransport) {
    this.transport = transport;
  }

  /** Send a plain-text message to a Messenger thread. */
  async sendText(recipientId: string, text: string): Promise<void> {
    const api = this.transport.getApi();
    if (!api) {
      log.warn("MiraiSender.sendText: API not ready — message dropped.", {
        to: recipientId,
      });
      throw new Error("Facebook API not connected (MiraiTransport not logged in).");
    }

    log.debug("MiraiSender: sending text…", {
      to:      recipientId,
      chars:   text.length,
      preview: text.slice(0, 60),
    });

    return new Promise<void>((resolve, reject) => {
      api.sendMessage(text, recipientId, (err, info) => {
        if (err) {
          log.warn("MiraiSender: sendText failed.", {
            to:    recipientId,
            error: err.message,
          });
          reject(err);
          return;
        }

        // ── [DEBUG-5] Reply sent successfully ───────────────────────────
        log.info("MiraiSender: reply sent.", {
          to:        recipientId,
          messageID: info?.messageID,
          chars:     text.length,
        });

        resolve();
      });
    });
  }

  /** Send a typing indicator (best-effort, never throws). */
  async sendTyping(recipientId: string): Promise<void> {
    const api = this.transport.getApi();
    if (!api) return;

    log.debug("MiraiSender: sending typing indicator.", { to: recipientId });

    try {
      api.sendTypingIndicator(recipientId);
    } catch {
      // Typing indicators are best-effort — never propagate errors.
    }
  }

  /** Add an emoji reaction to a message (best-effort, never throws). */
  async sendReaction(
    messageId:    string,
    _recipientId: string,
    emoji:        string,
  ): Promise<void> {
    const api = this.transport.getApi();
    if (!api) return;

    log.debug("MiraiSender: setting reaction.", { messageId, emoji });

    try {
      api.setMessageReaction(emoji, messageId, undefined, true);
    } catch {
      // Reactions are best-effort.
    }
  }
}

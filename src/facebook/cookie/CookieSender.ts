import crypto from "crypto";
import { ISender } from "../types/ISender";
import { CookieHttpClient } from "./CookieHttpClient";
import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("CookieSender");

/**
 * Sends Facebook Messenger messages using AppState browser cookies.
 *
 * This replaces the Graph API approach (which needs a Page Access Token) and
 * allows the bot to operate as a regular Facebook user account.
 *
 * Internally uses Facebook's internal GraphQL API — the same endpoint the
 * facebook.com/messages page uses in a browser.
 *
 * ⚠️  Note on doc_ids:
 *   Facebook's internal GraphQL operations are identified by numeric doc_ids
 *   that can change with Facebook deployments.  If a mutation stops working,
 *   update the corresponding constant below and open an issue in the repo.
 *   The bot logs every API error in detail to make troubleshooting easy.
 */
export class CookieSender implements ISender {
  /**
   * LSPlatform send-message mutation doc_id.
   * Last verified: 2025-Q1.  Update here if Facebook changes it.
   */
  private static readonly DOC_SEND    = "6857744677690810";
  private static readonly DOC_TYPING  = "3834680799968489";
  private static readonly DOC_REACT   = "1491557557614720";

  private readonly client: CookieHttpClient;

  constructor(client: CookieHttpClient) {
    this.client = client;
  }

  /** Send a plain-text message to a Messenger thread. */
  async sendText(recipientId: string, text: string): Promise<void> {
    log.debug(`Sending text message.`, {
      to:    recipientId,
      chars: text.length,
    });

    try {
      const res = await this.client.graphql({
        doc_id:    CookieSender.DOC_SEND,
        variables: JSON.stringify({
          input: {
            client_mutation_id:   crypto.randomUUID(),
            actor_id:             this.client.getUserId(),
            thread_id:            { id: recipientId },
            message:              { body: text },
            offline_threading_id: this.offlineId(),
          },
        }),
      });

      this.checkForError(res, "sendText");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Expired cookies → invalidate so the next request re-fetches tokens.
      if (msg.includes("auth") || msg.includes("token") || msg.includes("login")) {
        this.client.invalidateTokens();
      }

      throw new Error(`[CookieSender.sendText → ${recipientId}] ${msg}`);
    }
  }

  /** Send a typing indicator (best-effort, never throws). */
  async sendTyping(recipientId: string): Promise<void> {
    try {
      await this.client.graphql({
        doc_id:    CookieSender.DOC_TYPING,
        variables: JSON.stringify({
          input: {
            actor_id:  this.client.getUserId(),
            thread_id: { id: recipientId },
            state:     true,
          },
        }),
      });
    } catch {
      // Typing indicators are best-effort — never propagate errors.
    }
  }

  /** Add an emoji reaction to a message (best-effort, never throws). */
  async sendReaction(
    messageId:   string,
    recipientId: string,
    emoji:       string
  ): Promise<void> {
    try {
      await this.client.graphql({
        doc_id:    CookieSender.DOC_REACT,
        variables: JSON.stringify({
          input: {
            actor_id:   this.client.getUserId(),
            message_id: messageId,
            reaction:   emoji,
            action:     "ADD_REACTION",
            // recipientId kept for routing context but not sent to API
          },
        }),
      });
    } catch {
      // Reactions are best-effort.
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Generate a unique offline_threading_id in Facebook's expected format.
   * Uses a 64-bit value: current milliseconds shifted left by 12 bits, OR'd
   * with a random 12-bit value.
   */
  private offlineId(): string {
    const t = BigInt(Date.now()) << BigInt(12);
    const r = BigInt(Math.floor(Math.random() * 4096));
    return String(t | r);
  }

  /** Inspect the raw API response and throw if it signals an error. */
  private checkForError(res: unknown, operation: string): void {
    if (typeof res !== "object" || res === null) return;

    const obj = res as Record<string, unknown>;

    // Top-level errors array
    if (Array.isArray(obj["errors"])) {
      const first = (obj["errors"] as Array<Record<string, unknown>>)[0];
      const msg   = (first?.["message"] as string) ?? JSON.stringify(first);
      throw new Error(`Facebook API error in ${operation}: ${msg}`);
    }

    // data.message_send errors
    const data = obj["data"] as Record<string, unknown> | undefined;
    if (data?.["error"]) {
      throw new Error(
        `Facebook API data error in ${operation}: ${JSON.stringify(data["error"])}`
      );
    }
  }
}

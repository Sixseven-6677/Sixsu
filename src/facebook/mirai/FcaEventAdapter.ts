import { MessagingEntry, Attachment } from "../../types";
import { FcaEvent, FcaMessageEvent, FcaGroupEvent, FcaAttachment } from "./FcaTypes";
import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("FcaEventAdapter");

/**
 * FcaEventAdapter — converts raw FCA events into Sixsu's MessagingEntry format.
 *
 * Design decisions:
 *
 *  1. sender.id is mapped from FCA's threadID (not senderID).
 *     This ensures ctx.reply() sends to the correct conversation for both
 *     DMs (where threadID === senderID) and group chats (where they differ).
 *
 *  2. recipient.id is always the bot's own Facebook user ID.
 *
 *  3. Only "message", "message_reply", and group action events are adapted.
 *     All other FCA event types (typ, read_receipt, presence, etc.) are
 *     silently dropped to avoid polluting the command pipeline.
 *
 *  4. The bot's own messages are dropped (self-listen disabled).
 */
export class FcaEventAdapter {
  private readonly botUserId: string;

  constructor(botUserId: string) {
    this.botUserId = botUserId;
    log.info("FcaEventAdapter: initialized.", { botUserId });
  }

  /**
   * Convert a raw FCA event into a MessagingEntry array.
   * Returns [] if the event should be ignored.
   */
  adapt(event: FcaEvent): MessagingEntry[] {
    switch (event.type) {
      case "message":
      case "message_reply":
        return this.adaptMessage(event as FcaMessageEvent);

      case "event":
        return this.adaptGroupEvent(event as FcaGroupEvent);

      default:
        log.debug("FcaEventAdapter: dropping non-actionable event.", {
          type: event.type,
        });
        return [];
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private adaptMessage(event: FcaMessageEvent): MessagingEntry[] {
    // Drop messages sent by the bot itself
    if (event.senderID === this.botUserId) {
      log.debug("FcaEventAdapter: dropping own message.");
      return [];
    }

    // Must have text or attachments to be actionable
    if (!event.body && !event.attachments?.length) {
      log.debug("FcaEventAdapter: dropping empty message.", { type: event.type });
      return [];
    }

    const ts = typeof event.timestamp === "string"
      ? parseInt(event.timestamp, 10)
      : event.timestamp;

    const attachments: Attachment[] = (event.attachments ?? []).map(
      (a) => this.adaptAttachment(a),
    );

    // Use threadID as sender.id — this is the conversation the bot replies to
    const entry: MessagingEntry = {
      sender:    { id: event.threadID },
      recipient: { id: this.botUserId },
      timestamp: ts,
      message: {
        mid:         event.messageID,
        text:        event.body || undefined,
        attachments,
      },
    };

    // ── [DEBUG-2] MessagingEntry created — entering pipeline ───────────
    log.info("FcaEventAdapter: message adapted → entering pipeline.", {
      from:        event.senderID,
      thread:      event.threadID,
      isGroup:     event.isGroup,
      messageID:   event.messageID,
      text:        (event.body ?? "").slice(0, 120),
      attachments: attachments.length,
    });

    return [entry];
  }

  private adaptGroupEvent(event: FcaGroupEvent): MessagingEntry[] {
    const ts = typeof event.timestamp === "string"
      ? parseInt(event.timestamp, 10)
      : (event.timestamp as number);

    switch (event.logMessageType) {
      case "log:subscribe": {
        const added = (event.logMessageData.addedParticipants ?? [])
          .map((p) => ({ id: p.userFbId }));
        if (!added.length) return [];

        const entry: MessagingEntry = {
          sender:             { id: event.threadID },
          recipient:          { id: this.botUserId },
          timestamp:          ts,
          thread_action:      "added_participants",
          added_participants: added,
        };

        log.info("FcaEventAdapter: member(s) joined.", {
          threadID: event.threadID,
          added:    added.map((p) => p.id),
        });

        return [entry];
      }

      case "log:unsubscribe": {
        const leftId = event.logMessageData.leftParticipantFbId;
        if (!leftId) return [];

        const entry: MessagingEntry = {
          sender:               { id: event.threadID },
          recipient:            { id: this.botUserId },
          timestamp:            ts,
          thread_action:        "removed_participants",
          removed_participants: [{ id: leftId }],
        };

        log.info("FcaEventAdapter: member left.", {
          threadID: event.threadID,
          leftId,
        });

        return [entry];
      }

      default:
        log.debug("FcaEventAdapter: dropping group event.", {
          logMessageType: event.logMessageType,
        });
        return [];
    }
  }

  private adaptAttachment(att: FcaAttachment): Attachment {
    let type: Attachment["type"];

    switch (att.type) {
      case "photo":    type = "image";    break;
      case "video":    type = "video";    break;
      case "audio":    type = "audio";    break;
      case "sticker":  type = "image";    break;
      case "location": type = "location"; break;
      default:         type = "file";     break;
    }

    const payload: Attachment["payload"] = {
      url: att.url ?? att.previewUrl,
    };

    if (att.latitude != null && att.longitude != null) {
      payload.coordinates = { lat: att.latitude, long: att.longitude };
    }

    return { type, payload };
  }
}

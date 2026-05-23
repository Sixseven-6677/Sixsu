import { MessagingEntry } from "../types";
import {
  FBEvent,
  FBMessageEvent,
  FBPostbackEvent,
  FBUnknownEvent,
  FBAttachment,
} from "./types/events";

export class FacebookEventNormalizer {
  normalize(entry: MessagingEntry): FBEvent {
    const base = {
      senderId: entry.sender.id,
      pageId: entry.recipient.id,
      timestamp: entry.timestamp,
    };

    if (entry.postback) {
      const event: FBPostbackEvent = {
        ...base,
        type: "postback",
        payload: entry.postback.payload,
        title: entry.postback.title,
      };
      return event;
    }

    if (entry.message) {
      const attachments: FBAttachment[] = (
        entry.message.attachments ?? []
      ).map((att) => ({
        type: att.type,
        url: att.payload.url,
        coordinates: att.payload.coordinates,
      }));

      const event: FBMessageEvent = {
        ...base,
        type: "message",
        messageId: entry.message.mid,
        text: entry.message.text,
        attachments,
      };
      return event;
    }

    const unknown: FBUnknownEvent = { ...base, type: "unknown" };
    return unknown;
  }

  normalizeMany(entries: MessagingEntry[]): FBEvent[] {
    return entries.map((e) => this.normalize(e));
  }
}

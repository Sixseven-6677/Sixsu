import { MessagingEntry } from "../types";
import {
  FBEvent,
  FBMessageEvent,
  FBPostbackEvent,
  FBMemberJoinedEvent,
  FBMemberLeftEvent,
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

    if (entry.thread_action === "added_participants") {
      const event: FBMemberJoinedEvent = {
        ...base,
        type: "member_joined",
        addedByUserId: entry.sender.id,
        members: (entry.added_participants ?? []).map((p) => p.id),
      };
      return event;
    }

    if (entry.thread_action === "removed_participants") {
      const event: FBMemberLeftEvent = {
        ...base,
        type: "member_left",
        members: (entry.removed_participants ?? []).map((p) => p.id),
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

import { ISender } from "../facebook/types/ISender";
import { FBEvent, FBMessageEvent, FBPostbackEvent } from "../facebook/types/events";
import { Context } from "./Context";
import { ContextUser, ContextThread, ContextMessage, ContextAttachment } from "./types";

export class ContextBuilder {
  private readonly sender: ISender;

  constructor(sender: ISender) {
    this.sender = sender;
  }

  build(event: FBEvent): Context {
    if (event.type === "unknown") {
      throw new Error("Cannot build context for unknown event type.");
    }

    const user: ContextUser = { id: event.senderId };
    const thread: ContextThread = { id: event.senderId, pageId: event.pageId };
    const message = this.buildMessage(event);

    return new Context(user, thread, message, this.sender);
  }

  private buildMessage(
    event: FBMessageEvent | FBPostbackEvent
  ): ContextMessage {
    if (event.type === "postback") {
      return {
        id: `postback-${event.timestamp}`,
        text: event.payload,
        attachments: [],
        timestamp: event.timestamp,
        isPostback: true,
        postbackPayload: event.payload,
      };
    }

    const attachments: ContextAttachment[] = event.attachments.map((att) => ({
      type: att.type,
      url: att.url,
      coordinates: att.coordinates,
    }));

    return {
      id: event.messageId,
      text: event.text,
      attachments,
      timestamp: event.timestamp,
      isPostback: false,
    };
  }
}

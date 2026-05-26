/**
 * TypeScript declarations for the fca-unofficial / isoy-fca Facebook Chat API.
 *
 * fca-unofficial ships no @types package; these declarations cover the subset
 * of the API used by MiraiTransport and MiraiSender.
 */

export interface FcaAttachment {
  type: string; // "photo" | "video" | "audio" | "file" | "sticker" | "location"
  url?: string;
  previewUrl?: string;
  latitude?: number;
  longitude?: number;
  address?: string;
  filename?: string;
  fileSize?: number;
  mimeType?: string;
  duration?: number;
}

/** A chat message or reply event from FCA. */
export interface FcaMessageEvent {
  type: "message" | "message_reply";
  senderID: string;
  threadID: string;
  messageID: string;
  body: string;
  attachments: FcaAttachment[];
  isGroup: boolean;
  timestamp: string | number;
  mentions?: Record<string, string>;
  messageReply?: FcaMessageEvent;
}

/** A group action event (subscribe / unsubscribe / rename etc.) from FCA. */
export interface FcaGroupEvent {
  type: "event";
  senderID: string;
  threadID: string;
  messageID: string;
  logMessageType: string;
  logMessageData: {
    addedParticipants?: Array<{ userFbId: string; name?: string }>;
    leftParticipantFbId?: string;
    name?: string;
  };
  logMessageBody: string;
  author: string;
  timestamp: string | number;
  participantIDs?: string[];
}

/** Union of all FCA event types. */
export type FcaEvent =
  | FcaMessageEvent
  | FcaGroupEvent
  | { type: string; [k: string]: unknown };

/** Minimal FCA API surface used by this adapter. */
export interface FcaApi {
  listen(
    callback: (err: Error | null, event: FcaEvent) => void,
  ): () => void;
  sendMessage(
    message: string,
    threadID: string,
    callback?: (err: Error | null, info: { messageID: string }) => void,
    replyMessageID?: string,
  ): void;
  sendTypingIndicator(
    threadID: string,
    callback?: (err?: Error) => void,
  ): () => void;
  setMessageReaction(
    reaction: string,
    messageID: string,
    callback?: (err?: Error) => void,
    forceCustomReactions?: boolean,
  ): void;
  setOptions(options: Record<string, unknown>): void;
  getAppState(): FcaCookie[];
  getCurrentUserID(): string;
  logout(callback?: (err?: Error) => void): void;
}

/** Cookie entry stored in the AppState array. */
export interface FcaCookie {
  key: string;
  value: string;
  domain: string;
  path: string;
  hostOnly?: boolean;
  creation?: string;
  lastAccessed?: string;
  expires?: number | string;
}

export interface MessagingEntry {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: IncomingMessage;
  postback?: Postback;
  thread_action?: "added_participants" | "removed_participants";
  added_participants?: Array<{ id: string }>;
  removed_participants?: Array<{ id: string }>;
}

export interface IncomingMessage {
  mid: string;
  text?: string;
  attachments?: Attachment[];
}

export interface Attachment {
  type: "image" | "video" | "audio" | "file" | "location";
  payload: {
    url?: string;
    coordinates?: { lat: number; long: number };
  };
}

export interface Postback {
  title: string;
  payload: string;
}

export interface WebhookEntry {
  id: string;
  time: number;
  messaging: MessagingEntry[];
}

export interface WebhookBody {
  object: string;
  entry: WebhookEntry[];
}

export interface SendMessagePayload {
  recipient: { id: string };
  message: { text: string } | { attachment: object };
}

// ─── AppState ─────────────────────────────────────────────────────────────────

export interface FcaCookie {
  key:           string;
  value:         string;
  domain:        string;
  path:          string;
  hostOnly?:     boolean;
  creation?:     string;
  lastAccessed?: string;
  expires?:      number | string;
}

export type AppState = FcaCookie[];

// ─── FCA API ──────────────────────────────────────────────────────────────────

export type FcaRawEvent = { type: string; [k: string]: unknown };

export interface FcaApi {
  listen(callback: (err: Error | null, event: FcaRawEvent) => void): () => void;
  sendMessage(
    message:         string | { body?: string; attachment?: unknown },
    threadID:        string,
    callback?:       (err: Error | null, info: { messageID: string }) => void,
    replyMessageID?: string,
  ): void;
  setOptions(options: Record<string, unknown>): void;
  getAppState():      FcaCookie[];
  getCurrentUserID(): string;
  logout(callback?: (err?: Error) => void): void;
}

export type FcaLoginFn = (
  options:  { appState: AppState; pageID?: string },
  callback: (err: Error | null, api: FcaApi | null) => void,
) => void;

// ─── Events emitted by FacebookTransport ──────────────────────────────────────

export type TransportEvent =
  | { type: "login:started"  }
  | { type: "login:success";     userId: string; freshCookies: AppState }
  | { type: "login:failed";      error:  string }
  | { type: "mqtt:connected";    userId: string }
  | { type: "mqtt:disconnected"; errorCode?: number; errorMsg: string };
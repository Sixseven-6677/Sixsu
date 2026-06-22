export { FacebookTransport }    from "./FacebookTransport.js";
export { SessionManager }       from "./SessionManager.js";
export { ConnectionController } from "./ConnectionController.js";

export type {
  AppState,
  FcaCookie,
  FcaApi,
  FcaLoginFn,
  FcaRawEvent,
  TransportEvent,
} from "./types.js";

export type { LoadSource, SaveTarget, SaveBase64Result } from "./SessionManager.js";
export type { ConnectionStatus, EventRecord }            from "./ConnectionController.js";
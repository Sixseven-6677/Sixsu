export interface AppStateCookie {
  key: string;
  value: string;
  domain: string;
  path: string;
  hostOnly?: boolean;
  creation?: string;
  lastAccessed?: string;
  expires?: number;
}

export type AppState = AppStateCookie[];

export enum AuthStatus {
  AUTHENTICATED   = "AUTHENTICATED",
  UNAUTHENTICATED = "UNAUTHENTICATED",
  EXPIRED         = "EXPIRED",
  CORRUPTED       = "CORRUPTED",
  LOADING         = "LOADING",
}

export interface AuthCredentials {
  accountId: string;
  appState: AppState;
  loadedAt: Date;
}

export interface AuthResult {
  success: boolean;
  accountId?: string;
  error?: string;
  status: AuthStatus;
}

export interface IAuthProvider {
  load(): Promise<AppState>;
  validate(appState: AppState): boolean;
}

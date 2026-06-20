/**
 * Shared promise wrappers around FCA callback-based API methods.
 * Import these instead of duplicating the wrapper pattern in each plugin.
 */

// ─── Minimal shared FCA interface ────────────────────────────────────────────

export interface FcaThreadAdminEntry {
  id: string;
}

export interface FcaThreadUserInfo {
  name:       string;
  firstName?: string;
  isFriend?:  boolean;
  gender?:    number;
  type?:      string;
}

export interface FcaThreadInfo {
  threadID:       string;
  participantIDs: string[];
  adminIDs:       FcaThreadAdminEntry[];
  name:           string;
  isGroup:        boolean;
  userInfo:       Record<string, FcaThreadUserInfo>;
  nicknames?:     Record<string, string | null>;
}

/** Minimal FCA API surface shared across plugins. */
export interface IFcaApiBase {
  getThreadInfo(
    threadID: string,
    callback: (err: Error | null, info: FcaThreadInfo) => void,
  ): void;
}

/** Extension for plugins that manage group admins. */
export interface IFcaApiWithAdmin extends IFcaApiBase {
  changeAdminStatus(
    threadID:    string,
    userIDs:     string[],
    adminStatus: boolean,
    callback?:   (err: Error | null) => void,
  ): void;
}

// ─── Promise wrappers ─────────────────────────────────────────────────────────

/**
 * Promisified wrapper for `api.getThreadInfo`.
 * Used by admin and management plugins.
 */
export function fetchThreadInfo(
  api:      IFcaApiBase,
  threadID: string,
): Promise<FcaThreadInfo> {
  return new Promise((resolve, reject) => {
    api.getThreadInfo(threadID, (err, info) => {
      if (err) reject(err);
      else     resolve(info);
    });
  });
}

/**
 * Promisified wrapper for `api.changeAdminStatus`.
 * Used by the admin plugin.
 */
export function setAdminStatus(
  api:      IFcaApiWithAdmin,
  threadID: string,
  userIDs:  string[],
  isAdmin:  boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    api.changeAdminStatus(threadID, userIDs, isAdmin, (err) => {
      if (err) reject(err);
      else     resolve();
    });
  });
}

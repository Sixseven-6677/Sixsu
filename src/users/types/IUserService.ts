import type { UserRole, UserPreferences } from "../../database/models/user.model";

export type { UserRole, UserPreferences };

/** A fully-resolved user record exposed to the rest of the system. */
export interface IUserRecord {
  /** Facebook user ID */
  readonly fbId: string;
  /** Display name from Facebook (if available) */
  readonly name?: string;
  /** Access role */
  readonly role: UserRole;
  /** Whether the user is currently blocked from interacting */
  readonly isBlocked: boolean;
  /** Last time the user sent a message */
  readonly lastSeenAt: Date;
  /** Total messages sent to the bot */
  readonly messageCount: number;
  /** User-defined key/value preferences */
  readonly preferences: UserPreferences;
  /** When the user first interacted with the bot */
  readonly createdAt: Date;
  /** True if this was the very first message from this user */
  readonly isNew: boolean;
}

export interface IUserService {
  /**
   * Finds an existing user or creates a new one.
   * Increments messageCount and updates lastSeenAt on every call.
   * Results are served from cache on subsequent calls (fire-and-forget DB refresh).
   */
  findOrCreate(fbId: string, name?: string): Promise<IUserRecord>;

  /** Update arbitrary profile fields. Invalidates the cache entry. */
  updateProfile(fbId: string, data: { name?: string; role?: UserRole }): Promise<void>;

  /** Read a single preference value with a typed default. */
  getPreference<T>(fbId: string, key: string, defaultValue: T): Promise<T>;

  /** Persist a single preference value. Invalidates the cache entry. */
  setPreference(fbId: string, key: string, value: unknown): Promise<void>;
}

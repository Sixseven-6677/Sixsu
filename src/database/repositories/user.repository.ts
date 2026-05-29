import { UserModel, UserDocument, IUser } from "../models/user.model";
import { BaseRepository }                   from "./BaseRepository";

export type CreateUserDTO = Pick<IUser, "fbId"> & Partial<Omit<IUser, "fbId">>;
export type UpdateUserDTO = Partial<Omit<IUser, "fbId">>;

export interface TrackActivityResult {
  doc:   UserDocument;
  isNew: boolean;
}

export class UserRepository extends BaseRepository<
  UserDocument,
  CreateUserDTO,
  UpdateUserDTO
> {
  constructor() {
    super(UserModel);
  }

  async findByFbId(fbId: string): Promise<UserDocument | null> {
    return this.findOne({ fbId });
  }

  /**
   * Atomically upserts the user record on every incoming message:
   *   - Creates the document on first seen (role "user", messageCount defaults to 0 via schema).
   *   - Updates lastSeenAt and name (when provided) on every call.
   *   - Increments messageCount by 1 atomically via $inc.
   *
   * NOTE: messageCount is intentionally NOT in $setOnInsert.
   * Specifying the same path in both $setOnInsert and $inc in the same update
   * causes a MongoDB "Conflicting update operators" error (MongoServerError code 40).
   * The schema default of 0 handles the initial value; $inc brings it to 1.
   */
  async trackActivity(
    fbId:  string,
    name?: string
  ): Promise<TrackActivityResult> {
    try {
      const nameSet = name ? { name } : {};

      const raw = await UserModel.findOneAndUpdate(
        { fbId },
        {
          $setOnInsert: { fbId, role: "user", preferences: {} },
          $set:         { lastSeenAt: new Date(), ...nameSet },
          $inc:         { messageCount: 1 },
        },
        { upsert: true, new: true, rawResult: true, runValidators: true }
      ).exec();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isNew = (raw as any).lastErrorObject?.updatedExisting === false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { doc: (raw as any).value as UserDocument, isNew };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[UserRepository.trackActivity] ${msg}`);
    }
  }

  async upsertByFbId(
    fbId: string,
    data: UpdateUserDTO = {}
  ): Promise<UserDocument> {
    try {
      const doc = await UserModel.findOneAndUpdate(
        { fbId },
        {
          $set:         { ...data, lastSeenAt: new Date() },
          $setOnInsert: { fbId },
        },
        { upsert: true, new: true, runValidators: true }
      ).exec();
      return doc!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[UserRepository.upsertByFbId] ${msg}`);
    }
  }

  async setBlocked(fbId: string, blocked: boolean): Promise<boolean> {
    try {
      const result = await UserModel.updateOne(
        { fbId },
        { $set: { isBlocked: blocked } }
      ).exec();
      return result.modifiedCount > 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[UserRepository.setBlocked] ${msg}`);
    }
  }

  async isBlocked(fbId: string): Promise<boolean> {
    try {
      const result = await UserModel.exists({ fbId, isBlocked: true }).exec();
      return result !== null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[UserRepository.isBlocked] ${msg}`);
    }
  }

  async setPreference(
    fbId:  string,
    key:   string,
    value: unknown
  ): Promise<boolean> {
    try {
      const result = await UserModel.updateOne(
        { fbId },
        { $set: { [`preferences.${key}`]: value } }
      ).exec();
      return result.modifiedCount > 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[UserRepository.setPreference] ${msg}`);
    }
  }

  async setRole(fbId: string, role: IUser["role"]): Promise<boolean> {
    try {
      const result = await UserModel.updateOne(
        { fbId },
        { $set: { role } }
      ).exec();
      return result.modifiedCount > 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[UserRepository.setRole] ${msg}`);
    }
  }
}

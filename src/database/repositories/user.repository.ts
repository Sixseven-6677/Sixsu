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
   *   - Creates the document with role "user" if it does not exist.
   *   - Updates lastSeenAt and name (when provided) on every call.
   *   - Increments messageCount by 1 atomically via $inc.
   *
   * Returns the updated document and whether it was newly created.
   */
  async trackActivity(
    fbId:  string,
    name?: string
  ): Promise<TrackActivityResult> {
    try {
      const nameSet = name ? { name } : {};

      // rawResult: true gives us lastErrorObject so we can detect upserts
      const raw = await UserModel.findOneAndUpdate(
        { fbId },
        {
          $setOnInsert: { fbId, role: "user", preferences: {}, messageCount: 0 },
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

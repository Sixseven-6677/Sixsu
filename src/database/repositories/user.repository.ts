import { UserModel, UserDocument, IUser } from "../models/user.model";
import { BaseRepository } from "./BaseRepository";

export type CreateUserDTO = Pick<IUser, "fbId"> & Partial<Omit<IUser, "fbId">>;
export type UpdateUserDTO = Partial<Omit<IUser, "fbId">>;

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

  async upsertByFbId(
    fbId: string,
    data: UpdateUserDTO = {}
  ): Promise<UserDocument> {
    try {
      const doc = await UserModel.findOneAndUpdate(
        { fbId },
        {
          $set: { ...data, lastSeenAt: new Date() },
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
}

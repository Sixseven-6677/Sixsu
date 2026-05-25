import { Schema, model, Document } from "mongoose";

export type UserRole = "user" | "moderator" | "admin" | "owner";

export interface UserPreferences {
  language?: string;
  notifications?: boolean;
  [key: string]: unknown;
}

export interface IUser {
  fbId: string;
  name?: string;
  role: UserRole;
  isBlocked: boolean;
  lastSeenAt: Date;
  messageCount: number;
  preferences: UserPreferences;
}

export interface UserDocument extends IUser, Document {
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<UserDocument>(
  {
    fbId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
    },
    role: {
      type: String,
      enum: ["user", "moderator", "admin", "owner"],
      default: "user",
    },
    isBlocked: {
      type: Boolean,
      default: false,
    },
    lastSeenAt: {
      type: Date,
      default: () => new Date(),
    },
    messageCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    preferences: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

export const UserModel = model<UserDocument>("User", UserSchema);

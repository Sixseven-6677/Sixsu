import mongoose, { Connection } from "mongoose";
import { ISystem } from "../core/interfaces/ISystem";
import { config } from "../config/env";
import { LoggerManager } from "../logger/LoggerManager";

const log = LoggerManager.getLogger("DatabaseManager");

export class DatabaseManager implements ISystem {
  readonly name = "database";

  private connection: Connection | null = null;

  async initialize(): Promise<void> {
    const uri = config.database.mongoUri;

    if (!uri) {
      throw new Error("MONGODB_URI is not set in environment variables.");
    }

    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS:          45_000,
    });

    this.connection = mongoose.connection;

    this.connection.on("disconnected", () => {
      log.warn(
        "MongoDB disconnected. Mongoose will attempt automatic reconnection. " +
        "If the bot is not in shutdown, check your network and MongoDB host."
      );
    });

    this.connection.on("reconnected", () => {
      log.info("MongoDB reconnected successfully.");
    });

    this.connection.on("error", (err: Error) => {
      log.error("MongoDB connection error.", err);
    });

    log.info("Connected to MongoDB.", {
      host: mongoose.connection.host,
      name: mongoose.connection.name,
    });
  }

  async destroy(): Promise<void> {
    if (this.connection) {
      await mongoose.disconnect();
      this.connection = null;
      log.info("Disconnected from MongoDB.");
    }
  }

  isConnected(): boolean {
    return mongoose.connection.readyState === 1;
  }

  getConnection(): Connection {
    if (!this.connection || !this.isConnected()) {
      throw new Error("Not connected to MongoDB.");
    }
    return this.connection;
  }
}

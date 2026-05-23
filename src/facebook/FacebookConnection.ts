import crypto from "crypto";
import { config } from "../config/env";

export enum ConnectionState {
  CONNECTED = "CONNECTED",
  DISCONNECTED = "DISCONNECTED",
}

export class FacebookConnection {
  static readonly API_VERSION = "v19.0";
  static readonly BASE_URL = `https://graph.facebook.com/${FacebookConnection.API_VERSION}`;

  private state: ConnectionState = ConnectionState.DISCONNECTED;

  get accessToken(): string {
    return config.facebook.pageAccessToken;
  }

  get verifyToken(): string {
    return config.facebook.verifyToken;
  }

  verifyWebhookChallenge(
    mode: unknown,
    token: unknown,
    challenge: unknown
  ): string | null {
    if (mode === "subscribe" && token === this.verifyToken) {
      return String(challenge);
    }
    return null;
  }

  verifySignature(rawBody: string, signature: string): boolean {
    try {
      const expected = `sha256=${crypto
        .createHmac("sha256", config.facebook.appSecret)
        .update(rawBody)
        .digest("hex")}`;
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
      );
    } catch {
      return false;
    }
  }

  connect(): void {
    this.state = ConnectionState.CONNECTED;
    console.log("[FacebookConnection] Connected.");
  }

  disconnect(): void {
    this.state = ConnectionState.DISCONNECTED;
    console.log("[FacebookConnection] Disconnected.");
  }

  getState(): ConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED;
  }
}

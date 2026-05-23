import axios from "axios";
import { config } from "../config/env";
import { SendMessagePayload } from "../types";

const GRAPH_API_URL = "https://graph.facebook.com/v19.0/me/messages";

export class MessengerService {
  private readonly accessToken: string;

  constructor() {
    this.accessToken = config.facebook.pageAccessToken;
  }

  async sendText(recipientId: string, text: string): Promise<void> {
    const payload: SendMessagePayload = {
      recipient: { id: recipientId },
      message: { text },
    };
    await this.send(payload);
  }

  async sendTypingOn(recipientId: string): Promise<void> {
    await axios.post(
      GRAPH_API_URL,
      {
        recipient: { id: recipientId },
        sender_action: "typing_on",
      },
      { params: { access_token: this.accessToken } }
    );
  }

  async sendReaction(
    messageId: string,
    recipientId: string,
    emoji: string
  ): Promise<void> {
    await axios.post(
      GRAPH_API_URL,
      {
        recipient: { id: recipientId },
        sender_action: "react",
        payload: {
          message_id: messageId,
          reaction: emoji,
        },
      },
      { params: { access_token: this.accessToken } }
    );
  }

  private async send(payload: SendMessagePayload): Promise<void> {
    try {
      await axios.post(GRAPH_API_URL, payload, {
        params: { access_token: this.accessToken },
      });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Messenger API error: ${error.response?.data?.error?.message ?? error.message}`
        );
      }
      throw error;
    }
  }
}

export const messengerService = new MessengerService();

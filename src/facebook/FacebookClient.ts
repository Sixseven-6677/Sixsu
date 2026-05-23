import axios, { AxiosInstance } from "axios";
import { FacebookConnection } from "./FacebookConnection";

export class FacebookClient {
  private readonly http: AxiosInstance;
  private readonly connection: FacebookConnection;

  constructor(connection: FacebookConnection) {
    this.connection = connection;
    this.http = axios.create({
      baseURL: FacebookConnection.BASE_URL,
    });
  }

  async post(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.http.post(endpoint, body, {
        params: { access_token: this.connection.accessToken },
      });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message =
          error.response?.data?.error?.message ?? error.message;
        throw new Error(
          `[FacebookClient] API error on ${endpoint}: ${message}`
        );
      }
      throw error;
    }
  }
}

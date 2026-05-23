import axios from "axios";
import {
  IFacebookProfileService,
  FacebookProfile,
} from "./IUtilityServices";

const GRAPH_BASE = "https://graph.facebook.com/v19.0";

/**
 * Fetches Messenger user profile data from the Facebook Graph API.
 * Uses the Page Access Token — must be authorised on the page that
 * received the message.
 *
 * Registered as "fb-profile-service" on plugin enable.
 * Auto-removed (via IDisposable) on plugin disable.
 */
export class FacebookProfileService implements IFacebookProfileService {
  constructor(
    private readonly accessToken: string,
    private readonly timeoutMs:   number = 8_000,
  ) {}

  async getProfile(userId: string): Promise<FacebookProfile> {
    const url = `${GRAPH_BASE}/${encodeURIComponent(userId)}`;

    const { data } = await axios.get<{
      id:           string;
      name:         string;
      profile_pic?: string;
    }>(url, {
      params: {
        fields:       "id,name,profile_pic",
        access_token: this.accessToken,
      },
      timeout: this.timeoutMs,
    });

    return {
      id:         data.id,
      name:       data.name,
      profilePic: data.profile_pic,
    };
  }
}

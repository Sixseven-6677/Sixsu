import axios, { AxiosInstance } from "axios";
import { AppState } from "../auth/types/IAuth";
import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("CookieHttpClient");

const FB_ORIGIN   = "https://www.facebook.com";
const GRAPH_URL   = `${FB_ORIGIN}/api/graphql/`;
const USER_AGENT  =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

/**
 * HTTP client that authenticates Facebook web API calls using an AppState
 * (browser session cookies).  No Page Access Token needed.
 *
 * On first use it fetches the Facebook homepage to extract the CSRF tokens
 * fb_dtsg and lsd that are required on every POST.  These are cached until
 * explicitly invalidated.
 */
export class CookieHttpClient {
  private readonly http:        AxiosInstance;
  private readonly userId:      string;
  private readonly cookieStr:   string;
  private readonly rawAppState: AppState;

  private fbDtsg:       string | null = null;
  private lsd:          string | null = null;
  private tokenPromise: Promise<void> | null = null;

  constructor(appState: AppState) {
    const cUser = appState.find((c) => c.key === "c_user");
    if (!cUser?.value) {
      throw new Error(
        "[CookieHttpClient] AppState is missing the 'c_user' cookie. " +
        "Make sure your appState export includes the Facebook session cookies."
      );
    }

    this.userId      = cUser.value;
    this.cookieStr   = appState.map((c) => `${c.key}=${c.value}`).join("; ");
    this.rawAppState = appState;

    this.http = axios.create({
      baseURL: FB_ORIGIN,
      timeout: 30_000,
      headers: {
        "User-Agent":       USER_AGENT,
        "Accept-Language":  "en-US,en;q=0.9",
        "Accept-Encoding":  "gzip, deflate, br",
        "Connection":       "keep-alive",
        "DNT":              "1",
        "Sec-Fetch-Dest":   "document",
        "Sec-Fetch-Mode":   "navigate",
        "Sec-Fetch-Site":   "none",
        "Sec-Fetch-User":   "?1",
      },
    });
  }

  /** The Facebook user ID taken from the c_user cookie. */
  getUserId(): string {
    return this.userId;
  }

  /**
   * Returns the raw AppState cookie array.
   * Used by MessengerPoller to pass to fca-unofficial's login().
   */
  getRawAppState(): AppState {
    return this.rawAppState;
  }

  /**
   * Make an authenticated POST to the Facebook internal GraphQL endpoint.
   * Automatically fetches and injects fb_dtsg + lsd before the first call.
   *
   * @param params  Extra form-data parameters (e.g. doc_id, variables).
   */
  async graphql(params: Record<string, string>): Promise<unknown> {
    await this.ensureTokens();

    const body = new URLSearchParams({
      av:      this.userId,
      __user:  this.userId,
      __a:     "1",
      __req:   "a",
      __be:    "-1",
      fb_dtsg: this.fbDtsg!,
      lsd:     this.lsd ?? "",
      ...params,
    });

    const res = await this.http.post(GRAPH_URL, body.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie":       this.cookieStr,
        "Origin":       FB_ORIGIN,
        "Referer":      `${FB_ORIGIN}/messages/`,
        "X-FB-Friendly-Name": "MessengerSend",
      },
      responseType: "text",
    });

    const raw = res.data as string;

    // Facebook returns one JSON object per line — take the first valid one.
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try { return JSON.parse(t); } catch { /* try next line */ }
      }
    }

    return raw;
  }

  /**
   * Invalidate the cached CSRF tokens.
   * Call this after receiving an auth error so the next request re-fetches.
   */
  invalidateTokens(): void {
    this.fbDtsg = null;
    this.lsd    = null;
    log.info("Session tokens invalidated — will re-fetch on next request.");
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async ensureTokens(): Promise<void> {
    if (this.fbDtsg) return;

    // Deduplicate concurrent token-fetch calls.
    if (!this.tokenPromise) {
      this.tokenPromise = this.fetchTokens().finally(() => {
        this.tokenPromise = null;
      });
    }
    await this.tokenPromise;

    if (!this.fbDtsg) {
      throw new Error(
        "[CookieHttpClient] Failed to extract fb_dtsg from Facebook. " +
        "Your AppState cookies may be expired — please refresh them."
      );
    }
  }

  private async fetchTokens(): Promise<void> {
    log.info("Fetching Facebook session tokens (fb_dtsg, lsd)…");

    const res  = await this.http.get("/", {
      headers: {
        Cookie: this.cookieStr,
        Accept: "text/html,application/xhtml+xml",
      },
      responseType: "text",
    });

    const html = res.data as string;

    // ── fb_dtsg — try three known patterns ──────────────────────────────
    const match =
      html.match(/"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) ??
      html.match(/name="fb_dtsg"\s+value="([^"]+)"/)                                    ??
      html.match(/"fb_dtsg"\s*:\s*\{\s*"value"\s*:\s*"([^"]+)"/)                        ??
      html.match(/"fb_dtsg":{"value":"([^"]+)"/)                                        ;

    this.fbDtsg = match?.[1] ?? null;

    // ── lsd ──────────────────────────────────────────────────────────────
    const lsdMatch =
      html.match(/"LSD"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) ??
      html.match(/"lsd"\s*:\s*"([^"]+)"/);

    this.lsd = lsdMatch?.[1] ?? null;

    log.info("Session tokens fetched.", {
      userId: this.userId,
      fbDtsg: this.fbDtsg ? "✓" : "✗",
      lsd:    this.lsd    ? "✓" : "✗",
    });

    if (!this.fbDtsg) {
      log.warn(
        "Could not extract fb_dtsg — the AppState cookies may be expired or invalid. " +
        "Go to facebook.com in a browser, export your cookies again, then update FB_APPSTATE."
      );
    }
  }
}

import { IResponseBuilder } from "./IUtilityServices";

const SEPARATOR = "─────────────────────";

/**
 * Shared response formatter.
 *
 * Provided as "response-builder" service so all plugins produce
 * consistent message formatting without duplicating template strings.
 *
 * Usage:
 *   const fmt = ctx.requireService<IResponseBuilder>(SERVICES.RESPONSE_BUILDER);
 *   await ctx.reply(fmt.success("Pong!", ["⚡ 42ms"]));
 */
export class ResponseBuilder implements IResponseBuilder {
  success(title: string, lines: string[] = []): string {
    const parts: string[] = [`✅ ${title}`];
    if (lines.length > 0) {
      parts.push(SEPARATOR);
      parts.push(...lines);
    }
    return parts.join("\n");
  }

  warn(message: string): string {
    return `⚠️ ${message}`;
  }

  info(lines: string[]): string {
    return lines.join("\n");
  }

  sep(): string {
    return SEPARATOR;
  }
}

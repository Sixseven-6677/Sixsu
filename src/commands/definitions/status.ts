import os from "os";
import { ICommand }           from "../types/ICommand";
import { getCommandRegistry } from "../../handlers/message.handler";

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function fmtBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export const command: ICommand = {
  name:        "status",
  aliases:     ["stat", "info"],
  description: "يعرض حالة البوت والنظام",
  usage:       "/status",
  category:    "debug",

  execute: async (ctx) => {
    const mem      = process.memoryUsage();
    const uptime   = process.uptime();
    const nodeVer  = process.version;
    const platform = `${os.type()} ${os.arch()}`;
    const reg      = getCommandRegistry();
    const cmdCount = reg ? `${reg.size()} أمر` : "—";
    const freeRam  = `${fmtBytes(os.freemem())} / ${fmtBytes(os.totalmem())}`;

    const lines = [
      "🤖 حالة البوت",
      "─────────────────────",
      `⏱️  Uptime:    ${fmtUptime(uptime)}`,
      `💾  RSS:       ${fmtBytes(mem.rss)}`,
      `🧩  Heap used: ${fmtBytes(mem.heapUsed)} / ${fmtBytes(mem.heapTotal)}`,
      `🖥️  RAM حر:   ${freeRam}`,
      `📦  Node:      ${nodeVer}`,
      `🖥️  Platform:  ${platform}`,
      `📋  أوامر:     ${cmdCount}`,
    ];

    await ctx.reply(lines.join("\n"));
  },
};

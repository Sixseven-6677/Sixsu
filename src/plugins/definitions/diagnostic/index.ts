/**
 * DiagnosticPlugin — Phase 1 diagnostic command.
 *
 * Provides the "تشخيص" / "diag" command that prints the full
 * DiagnosticMonitor report directly in chat. No architecture changes.
 * No behaviour changes. Pure observation output.
 */
import { IPlugin, PluginManifest } from "../../types/IPlugin";
import { IPluginContext }          from "../../types/IPluginContext";
import { ICommand }                from "../../../commands/types/ICommand";
import { Context }                 from "../../../context/Context";
import { diagnosticMonitor }       from "../../../diagnostic/DiagnosticMonitor";

// ─── Command ───────────────────────────────────────────────────────────────

const diagCommand: ICommand = {
  name:        "تشخيص",
  aliases:     ["diag", "diagnostic", "session-report"],
  description: "يعرض تقرير تشخيصي كامل عن حالة الجلسة وطلبات API",
  usage:       "تشخيص",
  category:    "system",
  adminOnly:   true,
  hidden:      false,

  async execute(ctx: Context): Promise<void> {
    await ctx.typingOn();

    // Force a save to /tmp as well
    diagnosticMonitor.saveReport();

    const report = diagnosticMonitor.getReportText();

    // Split into chunks of 2000 chars to stay within Facebook message limits
    const CHUNK = 1_900;
    for (let i = 0; i < report.length; i += CHUNK) {
      const chunk = report.slice(i, i + CHUNK);
      await ctx.reply(chunk);
      // Small delay between chunks to avoid hitting send rate limits
      if (i + CHUNK < report.length) {
        await new Promise<void>(r => setTimeout(r, 800));
      }
    }
  },
};

// ─── Plugin ────────────────────────────────────────────────────────────────

class DiagnosticPlugin implements IPlugin {
  readonly manifest: PluginManifest = {
    name:        "diagnostic",
    version:     "1.0.0",
    description: "نظام التشخيص — يتتبع دورة حياة الجلسة وطلبات API ويكشف سبب انتهاء AppState.",
    author:      "Sixseven-6677",
  };

  private ctx!: IPluginContext;

  async onLoad(ctx: IPluginContext): Promise<void> {
    this.ctx = ctx;
    ctx.logger.info("DiagnosticPlugin loaded.");
  }

  async onEnable(): Promise<void> {
    this.ctx.registerCommand(diagCommand);
    this.ctx.logger.info(
      `Command "${diagCommand.name}" registered (aliases: ${diagCommand.aliases?.join(", ")}).`,
    );
  }

  async onDisable(): Promise<void> {
    this.ctx.logger.info("DiagnosticPlugin disabled.");
  }

  async onUnload(): Promise<void> {
    this.ctx.logger.info("DiagnosticPlugin unloaded.");
  }
}

export default new DiagnosticPlugin();

import { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { BotError } from "../types/BotError";
import { errorReporter } from "../ErrorReporter";
import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("HttpErrorHandler");

const STATUS_MAP: Record<string, number> = {
  ERR_VALIDATION:  400,
  ERR_PERMISSION:  403,
  ERR_NOT_FOUND:   404,
  ERR_FACEBOOK_API: 502,
  ERR_NETWORK:     503,
};

function resolveStatus(error: BotError): number {
  return STATUS_MAP[error.code] ?? 500;
}

export const httpErrorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const report = errorReporter.report(err);

  if (err instanceof BotError) {
    const status = resolveStatus(err);
    res.status(status).json({
      error: {
        code:    err.code,
        message: err.message,
        reportId: report.id,
      },
    });
    return;
  }

  log.error("Unexpected HTTP error.", err instanceof Error ? err : undefined, {
    reportId: report.id,
  });

  res.status(500).json({
    error: {
      code:     "ERR_INTERNAL",
      message:  "Internal server error.",
      reportId: report.id,
    },
  });
};

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code:    "ERR_NOT_FOUND",
      message: `Route not found: ${req.method} ${req.path}`,
    },
  });
}

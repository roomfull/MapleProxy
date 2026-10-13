import type { RequestDiagnostic } from "../protocol/types.js";

export class AppError extends Error {
  diagnostics?: RequestDiagnostic[];
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly param?: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

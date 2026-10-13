export class AppError extends Error {
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

import type { RequestDiagnostic } from "../protocol/types.js";

export const DIAGNOSTIC_LIMIT = 100;
/** Standard parameter paths only; arbitrary client key segments are bounded. */
export function safeParam(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 512 &&
    /^[A-Za-z0-9_-]{1,64}(?:\[\d{1,10}\]|\.[A-Za-z0-9_-]{1,64})*$/.test(value)
    ? value
    : undefined;
}
const reasons = new Set<RequestDiagnostic["reason"]>([
  "client_metadata",
  "null_optional",
  "empty_optional",
  "disabled_default",
  "siwc_ignored_parameter",
  "protocol_conversion",
]);
/** Bound metadata at collection time, including paths supplied by clients. */
export class DiagnosticList extends Array<RequestDiagnostic> {
  override push(...entries: RequestDiagnostic[]): number {
    for (const entry of entries) {
      if (this.length >= DIAGNOSTIC_LIMIT) break;
      const path = safeParam(entry.path);
      if (
        path &&
        ["filtered", "normalized"].includes(entry.action) &&
        reasons.has(entry.reason)
      )
        super.push({ path, action: entry.action, reason: entry.reason });
    }
    return this.length;
  }
}
export function safeDiagnostics(
  entries: RequestDiagnostic[] = [],
): RequestDiagnostic[] {
  const bounded = new DiagnosticList();
  for (const entry of entries) {
    bounded.push(entry);
    if (bounded.length >= DIAGNOSTIC_LIMIT) break;
  }
  return Array.from(bounded);
}

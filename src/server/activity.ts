import type { RequestDiagnostic } from "../protocol/types.js";
import type { ResponseOutcome } from "../protocol/events.js";
import { safeDiagnostics, safeParam } from "../shared/diagnostics.js";
import { safeField } from "./routes.js";

export interface Activity {
  requestId: string;
  profileId?: string;
  model?: string;
  format: "responses" | "chat";
  time: string;
  durationMs: number;
  result: "success" | "incomplete" | "error" | "cancelled";
  code?: string;
  ignored: string[];
  localRequestId?: string;
  upstreamRequestId?: string;
  stage?: "validation" | "upstream" | "response" | "transport";
  httpStatus?: number;
  param?: string;
  /** Entered runtime.requestResponses; auth/account preflight may still fail. */
  upstreamCalled?: boolean;
  diagnostics?: RequestDiagnostic[];
  responseStatus?: ResponseOutcome["status"];
  incompleteReason?: ResponseOutcome["incompleteReason"];
}
export class ActivityLog {
  private entries: Activity[] = [];
  add(activity: Activity): void {
    // Explicit projection prevents accidental content fields from being retained.
    this.entries.unshift({
      requestId: safeField(activity.requestId) ?? "unknown",
      localRequestId: safeField(activity.localRequestId),
      upstreamRequestId: safeField(activity.upstreamRequestId),
      profileId: safeField(activity.profileId),
      model: safeField(activity.model),
      format: activity.format,
      time: activity.time,
      durationMs: activity.durationMs,
      result: activity.result,
      code: safeField(activity.code),
      ignored: activity.ignored
        .slice(0, 100)
        .flatMap((value) => (safeParam(value) ? [value] : [])),
      stage: activity.stage,
      httpStatus: activity.httpStatus,
      param: safeParam(activity.param),
      upstreamCalled: activity.upstreamCalled,
      diagnostics: activity.diagnostics
        ? safeDiagnostics(activity.diagnostics)
        : undefined,
      responseStatus: activity.responseStatus,
      incompleteReason: activity.incompleteReason,
    });
    this.entries.length = Math.min(this.entries.length, 200);
  }
  list(): Activity[] {
    return this.entries.map((entry) => ({
      ...entry,
      ignored: [...entry.ignored],
      diagnostics: entry.diagnostics?.map((diagnostic) => ({ ...diagnostic })),
    }));
  }
}

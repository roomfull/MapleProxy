export interface Activity {
  requestId: string;
  profileId?: string;
  model?: string;
  format: "responses" | "chat";
  time: string;
  durationMs: number;
  result: "success" | "error" | "cancelled";
  code?: string;
  ignored: string[];
}
export class ActivityLog {
  private entries: Activity[] = [];
  add(activity: Activity): void {
    this.entries.unshift(activity);
    this.entries.length = Math.min(this.entries.length, 200);
  }
  list(): Activity[] {
    return this.entries.map((entry) => ({
      ...entry,
      ignored: [...entry.ignored],
    }));
  }
}

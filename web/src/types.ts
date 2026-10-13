export interface Account {
  id: string;
  label: string;
  status: string;
  sharing: boolean;
  enabled: boolean;
  isDefault: boolean;
  identity?: { name?: string; email?: string };
  error?: { code: string; message: string };
}
export interface Model {
  id: string;
  displayName: string;
}
export interface Key {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}
export interface Activity {
  requestId: string;
  profileId?: string;
  model?: string;
  format: string;
  time: string;
  durationMs: number;
  result: string;
  code?: string;
  ignored: string[];
}
export interface Job {
  id: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  code?: string;
}
export interface Resource<T> {
  data: T[];
  loading: boolean;
  error?: string;
}

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
  canCopy: boolean;
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
  localRequestId?: string;
  upstreamRequestId?: string;
  stage?: "validation" | "upstream" | "response" | "transport";
  httpStatus?: number;
  param?: string;
  upstreamCalled?: boolean;
  diagnostics?: Array<{
    path: string;
    action: "filtered" | "normalized";
    reason: string;
  }>;
  responseStatus?: "completed" | "incomplete";
  incompleteReason?: "max_output_tokens" | "content_filter" | "unknown";
}
export interface SignInRequest {
  mode?: "browser" | "manual";
  profileId?: string;
  newProfile?: boolean;
  label?: string;
  reconsent?: boolean;
}
export interface Job {
  id: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  code?: string;
  createdAt: string;
  mode: "browser" | "manual";
  expiresAt: string;
  phase: "preparing" | "awaiting_callback" | "exchanging";
  options: SignInRequest & { mode: "browser" | "manual" };
  authorizationUrl?: string;
}
export interface Resource<T> {
  data: T[];
  loading: boolean;
  error?: string;
}

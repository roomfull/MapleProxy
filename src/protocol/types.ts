/** Request metadata only: never include field values, prompts or tool payloads. */
export interface RequestDiagnostic {
  path: string;
  action: "filtered" | "normalized";
  reason:
    | "client_metadata"
    | "null_optional"
    | "empty_optional"
    | "disabled_default"
    | "siwc_ignored_parameter"
    | "protocol_conversion";
}

/** Kept on one request; no session/global registry or tool argument values. */
export interface ResponseContext {
  toolNames: Array<{ namespace: string; name: string; clientName: string }>;
  legacyFunctionCall: boolean;
}

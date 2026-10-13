import { createChatGPT, ChatGPTError } from "../../vendor/siwc/src/index.js";
import type { CredentialEncryption } from "../../vendor/siwc/src/types.js";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";
import { createDpapiEncryption } from "./dpapi.js";
import { AppError } from "../shared/errors.js";
export type { CredentialEncryption } from "../../vendor/siwc/src/types.js";
export type JsonObject = Record<string, any>;
export interface AccountView {
  id: string;
  label: string;
  status: string;
  sharing: boolean;
  enabled: boolean;
  isDefault: boolean;
  identity?: { name?: string; email?: string };
  error?: { code: string; message: string };
}
export interface ModelView {
  id: string;
  displayName: string;
}
export interface UpstreamResponse {
  profileId: string;
  status: number;
  headers: Headers;
  events: AsyncIterable<JsonObject>;
}
export interface AccountRuntime {
  listAccounts(): Promise<AccountView[]>;
  signIn(options?: {
    profileId?: string;
    newProfile?: boolean;
    label?: string;
    reconsent?: boolean;
  }): Promise<unknown>;
  cancelSignIn(): void;
  selectAccount(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  disconnect(id: string): Promise<void>;
  listModels(): Promise<ModelView[]>;
  requestResponses(options: {
    body: JsonObject;
    signal?: AbortSignal;
  }): Promise<UpstreamResponse>;
}
export interface RuntimeOptions {
  dataDir: string;
  encryption?: CredentialEncryption;
  openBrowser?: (url: string) => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
function mapped(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ChatGPTError) {
    const status =
      error.status ??
      (["connection_busy", "connection_changed", "account_disabled"].includes(
        error.code,
      )
        ? 409
        : error.code === "profile_not_found"
          ? 404
          : error.code === "cancelled"
            ? 499
            : error.code.startsWith("storage_")
              ? 503
              : 400);
    return new AppError(
      status,
      error.code,
      error.message,
      error.param,
      error.requestId,
    );
  }
  return new AppError(
    502,
    "connection_error",
    "The upstream connection could not be completed.",
  );
}
async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (e) {
    throw mapped(e);
  }
}
export function createAccountRuntime(options: RuntimeOptions): AccountRuntime {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
  )
    throw new AppError(
      400,
      "invalid_config",
      "timeoutMs must be a positive integer.",
    );
  const sdk = createChatGPT({
    appName: "MapleProxy",
    appId: "mapleproxy",
    redirectPort: 0,
    sendHostId: true,
    storageDir: options.dataDir,
    credentialEncryption: options.encryption ?? createDpapiEncryption(),
    openBrowser: options.openBrowser,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  return {
    listAccounts: () => guarded(() => sdk.listProfiles()),
    signIn: (o) => guarded(() => sdk.signIn(o)),
    cancelSignIn: () => sdk.cancelSignIn(),
    selectAccount: async (id) => {
      await guarded(() => sdk.selectProfile(id));
    },
    setEnabled: (id, enabled) => guarded(() => sdk.setEnabled(id, enabled)),
    disconnect: (id) => guarded(() => sdk.disconnect(id)),
    listModels: () =>
      guarded(async () =>
        (await sdk.listModels()).map((m) => ({
          id: m.slug,
          displayName: m.displayName,
        })),
      ),
    requestResponses: async ({ body, signal }) => {
      if (typeof body.model !== "string" || !body.model.trim())
        throw new AppError(
          400,
          "invalid_request",
          "Choose a model before starting a request.",
          "model",
        );
      const result = await guarded(() =>
        sdk.requestResponses(body as ResponseCreateParamsStreaming, { signal }),
      );
      const source = result.events[Symbol.asyncIterator]();
      return {
        ...result,
        events: {
          [Symbol.asyncIterator]: () => ({
            next: () => guarded(() => source.next()),
            return: () =>
              guarded(
                async () =>
                  (await source.return?.()) ?? { done: true, value: undefined },
              ),
            throw: (e) =>
              guarded(
                async () => (await source.throw?.(e)) ?? Promise.reject(e),
              ),
          }),
        },
      };
    },
  };
}

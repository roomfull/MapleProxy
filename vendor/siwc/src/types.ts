// Modified by MapleProxy: see ../PROVENANCE.md.
export interface SessionIdentity {
  name?: string;
  email?: string;
}

export interface SessionError {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
  param?: string;
  responseShape?: string;
}

/** Safe to send to a renderer. Credentials never form part of this type. */
export interface SessionState {
  status: "disconnected" | "connecting" | "connected" | "reauth_required";
  sharing: boolean;
  profileId?: string;
  profileLabel?: string;
  identity?: SessionIdentity;
  error?: SessionError;
}

export interface LoginProfile {
  enabled: boolean;
  isDefault: boolean;
  id: string;
  label: string;
  status: SessionState["status"];
  sharing: boolean;
  identity?: SessionIdentity;
  /** A pre-migration localhost registration cannot change its registered callback host. */
  requiresNewRegistration?: boolean;
  /** Registration returned a client ID but identity validation has not completed yet. */
  pending?: boolean;
}

export interface ChatGPTModel {
  slug: string;
  displayName: string;
}

/** Implement in the trusted local process with an OS-backed secret store. Never use plaintext or a hardcoded key. */
export interface CredentialEncryption {
  /** Stable format identifier. Keep this unchanged while existing files use this provider. */
  id: string;
  isAvailable(): boolean | Promise<boolean>;
  encrypt(plaintext: string): Uint8Array | Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): string | Promise<string>;
}

export interface ChatGPTConfig {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** The same human-readable app name on every installation. */
  appName: string;
  /** Stable filesystem identifier, separate from the issued OAuth client ID. */
  appId: string;
  /** Port of the IPv4 loopback callback, or 0 to select an available port. */
  redirectPort: number;
  storageDir?: string;
  /** Required; credentials are never persisted without this provider. */
  credentialEncryption: CredentialEncryption;
  openBrowser?: (url: string) => Promise<void> | void;
  /**
   * Include the persisted host ID in authorization requests. Defaults to false.
   * Enable only when the authorization provider supports ext_agent_host_id.
   */
  sendHostId?: boolean;
}

export interface ResponseInputMessage {
  role: "user" | "assistant" | "developer";
  content: string;
}

export interface StreamResponseOptions {
  model: string;
  input: string | ResponseInputMessage[];
  instructions?: string;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export type SignInMode = "browser" | "manual";
export interface SignInRequest {
  /** Register another account instead of reauthorizing the selected profile. */
  newProfile?: boolean;
  profileId?: string;
  label?: string;
  /** Only set after an explicit user choice to enable or reconnect token sharing. */
  reconsent?: boolean;
  mode?: SignInMode;
}

export type SignInProgress =
  | {
      phase: "awaiting_callback";
      authorizationUrl: string;
      submitCallback: (callbackUrl: string) => void;
    }
  | { phase: "exchanging" };

export interface SignInOptions extends SignInRequest {
  signal?: AbortSignal;
  onProgress?: (progress: SignInProgress) => void;
}

export interface ChatGPTClient {
  signIn(options?: SignInOptions): Promise<SessionState>;
  cancelSignIn(): void;
  getSession(): Promise<SessionState>;
  listProfiles(): Promise<LoginProfile[]>;
  selectProfile(id: string): Promise<SessionState>;
  listModels(options?: {
    signal?: AbortSignal;
    profileId?: string;
  }): Promise<ChatGPTModel[]>;
  subscribe(listener: (session: SessionState) => void): () => void;
  /** Sign out of the selected profile. Its registration and identity remain saved. */
  disconnect(profileId?: string): Promise<void>;
  setEnabled(profileId: string, enabled: boolean): Promise<void>;
  requestResponses(
    body: import("openai/resources/responses/responses").ResponseCreateParamsStreaming,
    options?: { profileId?: string; signal?: AbortSignal },
  ): Promise<{
    profileId: string;
    status: number;
    headers: Headers;
    events: AsyncIterable<Record<string, any>>;
    /** MapleProxy transport metadata: same deadline that governs headers/body. */
    deadlineAt: number;
  }>;
  streamResponse(options: StreamResponseOptions): Promise<{ text: string }>;
}

export interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  earliestRefreshAt?: string | number;
}

/** A received rotation is encrypted at rest and cannot be used before identity verification. */
export interface PendingRefresh {
  credentials: StoredCredentials;
  scopes: string[];
  idToken: string;
  /** Trusted local receipt time; retries validate the ID token as received, not after an outage. */
  receivedAt: number;
}

/** Internal persistence types. Never expose these through IPC or logs. */
export interface StoredConnection {
  version: 1;
  clientId: string;
  status: "connected" | "disconnected" | "reauth_required";
  scopes: string[];
  savedAt: string;
  subject?: string;
  identity?: SessionIdentity;
  profileIdToken?: string;
  credentials?: StoredCredentials;
  pendingRefresh?: PendingRefresh;
}

export interface StoredProfile extends StoredConnection {
  enabled?: boolean;
  id: string;
  label: string;
  requiresNewRegistration?: boolean;
}

export interface PendingRegistration {
  id: string;
  label: string;
  clientId: string;
  savedAt: string;
}

export interface StoredState {
  version: 2;
  activeProfileId?: string;
  profiles: StoredProfile[];
  pendingRegistrations: PendingRegistration[];
}

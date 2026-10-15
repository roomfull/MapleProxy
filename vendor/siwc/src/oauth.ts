// Modified by MapleProxy: see ../PROVENANCE.md.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import {
  apiError,
  ChatGPTError,
  currentFetch,
  fetchRemote,
  isObject,
  jsonResponse,
} from "./errors.js";
import type {
  ChatGPTConfig,
  PendingRefresh,
  StoredConnection,
  StoredCredentials,
  SignInOptions,
} from "./types.js";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const CALLBACK_PATH = "/auth/callback";
const randomValue = () => randomBytes(32).toString("base64url");

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  jwks_uri: string;
}

const discoveries = new WeakMap<typeof globalThis.fetch, Promise<Discovery>>();
const allKeySets = new WeakMap<
  typeof globalThis.fetch,
  Map<string, ReturnType<typeof createRemoteJWKSet>>
>();

async function discovery(): Promise<Discovery> {
  const fetcher = currentFetch();
  let discoveryPromise = discoveries.get(fetcher);
  discoveryPromise ??= (async () => {
    const response = await fetchRemote(
      `${ISSUER}/.well-known/openid-configuration`,
    );
    const data = await jsonResponse(response);
    if (!response.ok || !isObject(data) || data.issuer !== ISSUER) {
      throw new ChatGPTError(
        "discovery_failed",
        "ChatGPT sign-in configuration could not be verified.",
        true,
      );
    }
    for (const key of [
      "authorization_endpoint",
      "token_endpoint",
      "jwks_uri",
      "revocation_endpoint",
    ]) {
      const value = data[key];
      if (key === "revocation_endpoint" && value === undefined) continue;
      if (typeof value !== "string" || new URL(value).origin !== ISSUER) {
        throw new ChatGPTError(
          "discovery_failed",
          "ChatGPT sign-in configuration could not be verified.",
          true,
        );
      }
    }
    return data as unknown as Discovery;
  })().catch((error: unknown) => {
    discoveries.delete(fetcher);
    throw error;
  });
  discoveries.set(fetcher, discoveryPromise);
  return discoveryPromise;
}

export const identityVerificationUnavailable = () =>
  new ChatGPTError(
    "identity_verification_unavailable",
    "ChatGPT identity verification is temporarily unavailable. Your connection has been preserved. Try again shortly.",
    true,
  );

async function verifyIdentity(
  idToken: string,
  clientId: string,
  nonce?: string,
  receivedAt?: number,
) {
  const config = await discovery().catch(() => {
    throw identityVerificationUnavailable();
  });
  const fetcher = currentFetch();
  const keySets =
    allKeySets.get(fetcher) ??
    new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  allKeySets.set(fetcher, keySets);
  let keys = keySets.get(config.jwks_uri);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(config.jwks_uri), {
      timeoutDuration: 15_000,
      // Classify failures at the retrieval boundary, before JOSE verifies the
      // token. An unavailable key service does not establish an invalid identity.
      [customFetch]: async (url, options) => {
        try {
          const response = await fetchRemote(url, options, 15_000);
          if (response.status !== 200) throw identityVerificationUnavailable();
          const body = await jsonResponse(response);
          if (!isObject(body) || !Array.isArray(body.keys))
            throw identityVerificationUnavailable();
          return Response.json(body);
        } catch {
          throw identityVerificationUnavailable();
        }
      },
    });
    keySets.set(config.jwks_uri, keys);
  }
  try {
    const resolver = keys;
    const { payload } = await jwtVerify(
      idToken,
      async (header, token) => {
        try {
          return await resolver(header, token);
        } catch {
          // Missing/temporarily malformed keys are a provider availability issue.
          // Invalidate the resolver so a transient empty set is not held through
          // its normal cooldown. Signature and claims failures happen afterward.
          if (keySets.get(config.jwks_uri) === resolver)
            keySets.delete(config.jwks_uri);
          throw identityVerificationUnavailable();
        }
      },
      {
        issuer: config.issuer,
        audience: clientId,
        algorithms: ["RS256"],
        clockTolerance: 5,
        requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
        // The encrypted checkpoint records when this response was received. An
        // outage may outlast its ID token, without invalidating its refresh token.
        ...(receivedAt === undefined
          ? {}
          : { currentDate: new Date(receivedAt) }),
      },
    );
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      (nonce !== undefined && payload.nonce !== nonce) ||
      (payload.azp !== undefined && payload.azp !== clientId) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== clientId)
    ) {
      throw new Error("invalid identity");
    }
    return {
      subject: payload.sub,
      identity: {
        ...(typeof payload.name === "string" ? { name: payload.name } : {}),
        ...(typeof payload.email === "string" ? { email: payload.email } : {}),
      },
    };
  } catch (error) {
    if (
      error instanceof ChatGPTError &&
      error.code === "identity_verification_unavailable"
    )
      throw error;
    throw new ChatGPTError(
      "invalid_id_token",
      "The ChatGPT identity could not be verified. Please sign in again.",
    );
  }
}

async function tokenRequest(
  body: URLSearchParams,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const config = await discovery();
  signal.throwIfAborted();
  const response = await fetchRemote(config.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
    signal,
  });
  const data = await jsonResponse(response);
  if (!response.ok)
    throw apiError(data, response.status, response.headers.get("x-request-id"));
  if (!isObject(data))
    throw new ChatGPTError(
      "invalid_token_response",
      "ChatGPT returned an invalid token response. Please sign in again.",
    );
  return data;
}

function tokenFields(data: Record<string, unknown>, requireRefresh = false) {
  if (typeof data.scope !== "string") {
    throw new ChatGPTError(
      "invalid_token_response",
      "ChatGPT did not confirm the granted permissions. Please sign in again.",
    );
  }
  const scopes = data.scope.split(/\s+/).filter(Boolean);
  let credentials: StoredCredentials | undefined;
  if (typeof data.access_token === "string" && data.access_token) {
    if (
      typeof data.token_type !== "string" ||
      data.token_type.toLowerCase() !== "bearer" ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(Date.now() + data.expires_in * 1000) ||
      data.expires_in <= 0 ||
      ((requireRefresh || scopes.includes("offline_access")) &&
        (typeof data.refresh_token !== "string" || !data.refresh_token))
    ) {
      throw new ChatGPTError(
        "invalid_token_response",
        "ChatGPT returned incomplete credentials. Please sign in again.",
      );
    }
    credentials = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      ...(typeof data.refresh_token === "string" && data.refresh_token
        ? { refreshToken: data.refresh_token }
        : {}),
      ...(typeof data.earliest_refresh_at === "string" ||
      typeof data.earliest_refresh_at === "number"
        ? { earliestRefreshAt: data.earliest_refresh_at }
        : {}),
    };
  } else if (
    requireRefresh ||
    scopes.includes("offline_access") ||
    scopes.includes("chatgpt.tokens.use.direct")
  ) {
    throw new ChatGPTError(
      "invalid_token_response",
      "ChatGPT did not return the requested credentials. Please sign in again.",
    );
  }
  return { scopes, ...(credentials ? { credentials } : {}) };
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    child.once("error", () =>
      reject(
        new ChatGPTError(
          "browser_unavailable",
          "The browser could not be opened. Check your default browser and try again.",
        ),
      ),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new ChatGPTError(
              "browser_unavailable",
              "The browser could not be opened. Check your default browser and try again.",
            ),
          ),
    );
  });
}

interface CallbackResult {
  code: string;
  clientId: string;
}

const invalidCallback = () =>
  new ChatGPTError(
    "callback_invalid",
    "The callback URL is invalid. Copy the complete callback URL and try again.",
    false,
    400,
  );
const unavailableCallback = () =>
  new ChatGPTError(
    "callback_unavailable",
    "This sign-in callback is no longer available.",
    false,
    409,
  );
const oauthCallbackErrors = new Set([
  "access_denied",
  "invalid_request",
  "unauthorized_client",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "interaction_required",
  "login_required",
  "consent_required",
]);

/** Parses local callback text only. Never navigates to or fetches a pasted URL. */
function validateCallback(
  input: string,
  redirectUri: string,
  state: string,
  savedClientId?: string,
): CallbackResult | ChatGPTError {
  if (typeof input !== "string") throw invalidCallback();
  const text = input.trim();
  if (
    !text ||
    Buffer.byteLength(text, "utf8") > 16 * 1024 ||
    /[\x00-\x1f\x7f]/.test(text)
  )
    throw invalidCallback();
  let url: URL;
  try {
    if (/[\x00-\x1f\x7f]/.test(decodeURIComponent(text)))
      throw invalidCallback();
    url = new URL(text);
  } catch {
    throw invalidCallback();
  }
  const expected = new URL(redirectUri);
  const queryStart = text.indexOf("?");
  if (
    text.slice(0, queryStart < 0 ? undefined : queryStart) !== redirectUri ||
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.username ||
    url.password ||
    text.includes("#")
  )
    throw invalidCallback();
  const params = url.searchParams;
  for (const key of ["state", "code", "client_id", "error"])
    if (params.getAll(key).length > 1) throw invalidCallback();
  const received = Buffer.from(params.get("state") ?? ""),
    wanted = Buffer.from(state);
  if (
    params.getAll("state").length !== 1 ||
    received.length !== wanted.length ||
    !timingSafeEqual(received, wanted)
  )
    throw invalidCallback();
  const returnedClientId = params.get("client_id");
  const clientId = returnedClientId ?? savedClientId;
  if (
    returnedClientId !== null &&
    (!/^[a-zA-Z0-9_-]{1,200}$/.test(returnedClientId) ||
      returnedClientId === "dynamic_agent_client" ||
      (savedClientId !== undefined && savedClientId !== returnedClientId))
  )
    throw invalidCallback();
  const error = params.get("error");
  if (error !== null) {
    if (params.has("code") || !oauthCallbackErrors.has(error))
      throw invalidCallback();
    return apiError({ error });
  }
  const code = params.get("code");
  if (
    !code ||
    !clientId ||
    !/^[a-zA-Z0-9_-]{1,200}$/.test(clientId) ||
    clientId === "dynamic_agent_client"
  )
    throw invalidCallback();
  return { code, clientId };
}

async function listenForCallback(
  port: number,
  state: string,
  savedClientId: string | undefined,
  signal: AbortSignal,
  onAccepted: () => void,
) {
  let complete!: (value: CallbackResult) => void;
  let fail!: (error: Error) => void;
  let settled = false;
  let closed = false;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  // The callback can arrive while the browser-opening promise is still pending.
  void result.catch(() => undefined);
  let selectedPort = port;
  const redirectUri = () => `http://127.0.0.1:${selectedPort}${CALLBACK_PATH}`;
  const finish = (value: CallbackResult | ChatGPTError) => {
    if (settled) return;
    settled = true;
    if (value instanceof ChatGPTError) fail(value);
    else complete(value);
  };
  const submitCallback = (callbackUrl: string) => {
    if (closed || settled || signal.aborted) throw unavailableCallback();
    const value = validateCallback(
      callbackUrl,
      redirectUri(),
      state,
      savedClientId,
    );
    // The gate is synchronous: HTTP and manual submissions cannot both consume it.
    finish(value);
    onAccepted();
  };
  const script = 'history.replaceState(null, "", "/auth/complete");';
  const scriptHash = createHash("sha256").update(script).digest("base64");
  const handler: RequestListener = (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`,
    );
    if (
      request.method !== "GET" ||
      request.headers.host !== `127.0.0.1:${selectedPort}` ||
      settled ||
      closed
    ) {
      response.writeHead(404).end("Not found");
      return;
    }
    try {
      const target = request.url ?? "/";
      submitCallback(
        target.startsWith("/") && !target.startsWith("//")
          ? `http://127.0.0.1:${selectedPort}${target}`
          : target,
      );
    } catch {
      response
        .writeHead(400)
        .end(
          "Invalid sign-in callback. Copy the complete callback URL and try again.",
        );
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Return to your app</title><style>body{font:17px system-ui;max-width:32rem;margin:18vh auto;padding:24px;color:#202123}h1{font-size:26px}</style><h1>Return to your app</h1><p>The app will finish checking your ChatGPT connection. You can close this tab.</p><script>${script}</script></html>`,
    );
  };
  const server = createServer(handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const close = () => {
    closed = true;
    signal.removeEventListener("abort", abort);
    server.close();
    server.closeAllConnections();
  };
  const abort = () => {
    finish(new ChatGPTError("cancelled", "Sign-in was cancelled."));
    close();
  };
  try {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port: selectedPort, host: "127.0.0.1" }, () => {
          server.removeListener("error", reject);
          server.on("error", () =>
            finish(
              new ChatGPTError(
                "callback_failed",
                "The local sign-in listener stopped. Please try again.",
              ),
            ),
          );
          const address = server.address();
          if (address && typeof address !== "string")
            selectedPort = address.port;
          resolve();
        });
      });
    } catch {
      throw new ChatGPTError(
        "callback_port_unavailable",
        "The sign-in port is unavailable. Close another copy of the app or choose a different redirect port.",
      );
    }
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
    return {
      result,
      close,
      submitCallback,
      redirectUri: redirectUri(),
    };
  } catch (error) {
    close();
    throw error;
  }
}

interface AuthorizationOptions extends Pick<
  SignInOptions,
  "reconsent" | "mode" | "onProgress"
> {
  /** Save the issued registration separately before the one-time code exchange. */
  onRegistration?: (clientId: string) => Promise<void>;
}

export async function authorize(
  config: ChatGPTConfig,
  previous: StoredConnection | undefined,
  hostId: string,
  signal: AbortSignal,
  options: AuthorizationOptions = {},
): Promise<StoredConnection> {
  const state = randomValue();
  const nonce = randomValue();
  const verifier = randomValue();
  const provider = await discovery();
  signal.throwIfAborted();
  const listener = await listenForCallback(
    config.redirectPort,
    state,
    previous?.clientId,
    signal,
    () => options.onProgress?.({ phase: "exchanging" }),
  );
  try {
    const authorization = new URL(provider.authorization_endpoint);
    authorization.search = new URLSearchParams({
      client_id: previous?.clientId ?? "dynamic_agent_client",
      response_type: "code",
      redirect_uri: listener.redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    if (config.sendHostId)
      authorization.searchParams.set("ext_agent_host_id", hostId);
    if (!previous?.clientId)
      authorization.searchParams.set("agent_name_hint", config.appName);
    // Keep saved tokens out of browser URLs, which default openers expose in
    // process arguments. The verified subject check below binds saved profiles.
    if (previous?.identity?.email)
      authorization.searchParams.set("login_hint", previous.identity.email);
    if (options.reconsent) authorization.searchParams.set("prompt", "consent");
    options.onProgress?.({
      phase: "awaiting_callback",
      authorizationUrl: authorization.toString(),
      submitCallback: listener.submitCallback,
    });
    if (options.mode !== "manual")
      await (config.openBrowser ?? defaultOpenBrowser)(
        authorization.toString(),
      );
    const callback = await listener.result;
    // A one-time code can fail or expire after registration succeeds. Retain the
    // issued client ID so a fresh authorization does not register another app.
    await options.onRegistration?.(callback.clientId);
    const data = await tokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: callback.clientId,
        code: callback.code,
        code_verifier: verifier,
        redirect_uri: listener.redirectUri,
        resource: RESOURCE,
      }),
      signal,
    );
    if (typeof data.id_token !== "string")
      throw new ChatGPTError(
        "invalid_id_token",
        "ChatGPT did not return a verifiable identity. Please try signing in again.",
      );
    const identity = await verifyIdentity(
      data.id_token,
      callback.clientId,
      nonce,
    );
    if (previous?.subject && identity.subject !== previous.subject) {
      throw new ChatGPTError(
        "account_mismatch",
        "This sign-in returned a different ChatGPT account. Choose the original account or add a separate profile.",
      );
    }
    signal.throwIfAborted();
    return {
      version: 1,
      clientId: callback.clientId,
      status: "connected",
      savedAt: new Date().toISOString(),
      profileIdToken: data.id_token,
      ...identity,
      ...tokenFields(data),
    };
  } finally {
    listener.close();
  }
}

export async function refreshConnection(
  previous: StoredConnection,
  signal: AbortSignal,
  persistRotation: (rotation: PendingRefresh) => Promise<void>,
): Promise<StoredConnection> {
  let rotation = previous.pendingRefresh;
  let fields: ReturnType<typeof tokenFields>;
  if (rotation) {
    // A prior refresh already consumed its grant. Resume identity verification
    // from the encrypted checkpoint, including after an app restart.
    fields = { scopes: rotation.scopes, credentials: rotation.credentials };
  } else {
    if (!previous.credentials?.refreshToken)
      throw new ChatGPTError(
        "invalid_grant",
        "Your ChatGPT connection has expired. Sign in again.",
      );
    const data = await tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: previous.clientId,
        refresh_token: previous.credentials.refreshToken,
        resource: RESOURCE,
      }),
      signal,
    );
    // OAuth may omit scope on refresh when the previously granted scopes are unchanged.
    fields = tokenFields(
      { ...data, scope: data.scope ?? previous.scopes.join(" ") },
      true,
    );
    if (
      data.id_token !== undefined &&
      (typeof data.id_token !== "string" || !data.id_token)
    ) {
      throw new ChatGPTError(
        "invalid_id_token",
        "ChatGPT returned an invalid refreshed identity. Please sign in again.",
      );
    }
    if (typeof data.id_token === "string" && fields.credentials) {
      rotation = {
        credentials: fields.credentials,
        scopes: fields.scopes,
        idToken: data.id_token,
        receivedAt: Date.now(),
      };
      // Persist before key retrieval can fail or the process can be interrupted.
      // This checkpoint is not authorization to use the received credentials.
      await persistRotation(rotation);
    }
  }
  let verifiedIdentity;
  if (rotation) {
    verifiedIdentity = await verifyIdentity(
      rotation.idToken,
      previous.clientId,
      undefined,
      rotation.receivedAt,
    );
    if (verifiedIdentity.subject !== previous.subject)
      throw new ChatGPTError(
        "account_mismatch",
        "The refreshed ChatGPT identity does not match this profile. Sign in to the original account again.",
      );
  }
  const { pendingRefresh: _pendingRefresh, ...verified } = previous;
  return {
    ...verified,
    ...fields,
    ...(verifiedIdentity && rotation
      ? { ...verifiedIdentity, profileIdToken: rotation.idToken }
      : {}),
    status: "connected",
    savedAt: new Date().toISOString(),
  };
}

export async function revokeConnection(
  connection: StoredConnection,
): Promise<void> {
  if (!connection.credentials && !connection.pendingRefresh) return;
  const revocationFailed = () =>
    new ChatGPTError(
      "revocation_failed",
      "Local credentials were removed, but remote disconnection could not be confirmed. Disconnect the app in ChatGPT Settings.",
      true,
    );
  const token =
    connection.pendingRefresh?.credentials.refreshToken ??
    connection.credentials?.refreshToken;
  if (!token) throw revocationFailed();
  const provider = await discovery().catch(() => {
    throw revocationFailed();
  });
  if (!provider.revocation_endpoint) throw revocationFailed();
  // Revoking the refresh token removes the renewable session. Do not also send
  // the access token after successful revocation of the same session.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let retryable = false;
    try {
      const response = await fetchRemote(
        provider.revocation_endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token,
            token_type_hint: "refresh_token",
            client_id: connection.clientId,
          }),
        },
        10_000,
      );
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 200) return;
      retryable = response.status >= 500;
    } catch (error) {
      retryable =
        error instanceof ChatGPTError && error.code === "network_error";
    }
    if (!retryable || attempt === 1) break;
    await delay(300);
  }
  throw revocationFailed();
}

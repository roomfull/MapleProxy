# MapleProxy approved design

Approved in conversation on 2026-10-13; user instructed execution. Local personal Windows Node.js service with Chinese React dashboard. Multiple SIWC accounts, manually selected default, independent account enabled state. Admin password login and separate hashed downstream API keys. Bind IPv4 loopback only. No Redis or quota display; show actual limit errors and link https://chatgpt.com/settings/usage.

Use and extend official OpenAI SIWC DevKit, pinned to commit `0a36fefeb913055c8c7a1a29b63d82b96b2e841a`; retain noncommercial license and change notices. Reuse PKCE/OIDC/JWT verification, stable host identity, issued client registrations, rotation checkpoints, atomic encrypted store. Credentials use Windows DPAPI CurrentUser via fixed hidden PowerShell helper and pipes only. No plaintext fallback.

Gateway offers GET /v1/models, POST /v1/responses and POST /v1/chat/completions. Both inference routes accept streaming and nonstreaming. Upstream is https://api.openai.com/v1/responses, always store:false, stream:true. Responses is full supported-capability interface; Chat Completions maps standard representable capabilities. Support text/images/files, function/custom calls and outputs, reasoning/structured output, eligible web search. Local tool execution remains the downstream's responsibility. Native Responses events and final output objects are preserved.

Compatibility mode drops only known ordinary unsupported fields, names them in X-MapleProxy-Ignored-Params and request history. It does not pretend max_tokens limits are enforced. Reject unsupported semantic features (persistent state, previous_response_id, audio/video, image generation, upload, hosted MCP, file search, code interpreter, computer use, tool_search). Unknown model-specific options are sent to upstream unless known unsupported. Map system messages to developer. Tools must use accepted namespaces or additional_tools items; maintain tool identity on roundtrips.

Freeze profile at request start. Selecting default affects new requests only. Disabling/logout aborts requests of that profile, not others. Adding profile does not replace existing default. Do not mix tokens across profiles. Refresh under lock, preserve successful rotation through caller cancellation, preserve credentials on infrastructure failures. Logout retains registration and attempts revocation. No automatic account pooling or request replay.

Settings and encrypted credentials use versioned local JSON and atomic writes. Data in ignored data/ (override allowed for tests). Admin password scrypt, opaque HttpOnly SameSite=Strict sessions, CSRF+Origin+Host checks, constant-time key hash checks. Never send OAuth tokens to browser/downstream or log prompts, file bodies, model answers, authorization headers, passwords or keys. Recent metadata-only request log bounded to 200 entries in memory. Native HTTP/SSE only, no WebSocket transport.

Dashboard: Accounts (connect, progress, enable, select, reauthorize, logout, models); Access (base URL, create/name/revoke/show-once key, samples); Activity (account/model/duration/result/code/ignored fields). CLI initializes/resets admin password, not an unauthenticated setup HTTP route.

Validation: real pure/protocol and simulated HTTP upstream tests, authentication/key isolation, callback nonce/state/replay/identity, concurrency rotation and lifecycle cancellation, SSE framing UTF-8/terminal events/disconnection/backpressure, DPAPI Windows smoke, browser dashboard smoke. Live OpenAI smoke is explicit user browser OAuth, never use existing unrelated credentials. Document any unperformed live test honestly.

Evidence:
- https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
- https://github.com/openai/sign-in-with-chatgpt-devkit
- https://github.com/router-for-me/CLIProxyAPI/issues/2585
- https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata


Vendored from https://github.com/openai/sign-in-with-chatgpt-devkit
at verified Git commit 0a36fefeb913055c8c7a1a29b63d82b96b2e841a.
Downloaded by git clone over HTTPS and git checkout --detach; rev-parse HEAD matched.
packages/local sources, original tests, LICENSE are retained. Root third-party
notices and dependency inventory are retained alongside this file.
MapleProxy modifications are marked in source headers and documented below.
License is the upstream noncommercial license; see LICENSE and LICENSE-SIWC.
Modified: build config/scripts, types/storage/index/responses/errors/oauth/models.
Changes: explicit profile requests, per-profile cancellation, enabled preferences,
full typed Responses events, injected fetch isolation, safe body lifetime.
Final review repair (2026-10-13): requestResponseStream uses the locked OpenAI
Node SDK 7.32.0 exported _iterSSEMessages decoder with asResponse(), preserving
native explicit SSE error payloads before safe termination. No SDK dependency
source is modified; UTF-8 framing and abortable body reads remain SDK-owned.
The low-level export must be revalidated when upgrading the SDK. Source reference:
https://github.com/openai/openai-node/blob/main/src/core/streaming.ts (checked
2026-10-13); installed locked source/declarations were the compatibility authority.
Transport lifetime metadata (2026-10-14): requestResponseStream returns deadlineAt
from the same timestamp/default180s or configured timeout used for its existing
headers/body deadline. No deadline reset at headers and no timeout policy change.
MapleProxy uses this fixed numeric metadata to bound downstream drain waits; no
auth/account/policy behavior or SDK dependency source is changed.

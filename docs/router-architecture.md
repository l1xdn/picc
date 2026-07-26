# Unified Router Architecture

## Goals

1. Keep the existing Anthropic-compatible Cloud Code proxy fully operational.
2. Add an OpenRouter-style local router backed by Cloud Code and Pi's provider catalog/authentication runtime.
3. Expose both Anthropic Messages and OpenAI Chat Completions APIs.
4. Configure Claude Code and Pi to use the local router.
5. Account for token usage and estimated public API cost independently of provider billing.

## Request flow

```text
Anthropic /v1/messages ─┐
                        ├─> auth + key policy -> model resolver -> normalized context
OpenAI /v1/chat/... ────┘                              │
                                                       ├─> Cloud Code adapter
                                                       └─> Pi provider adapter
                                                                  │
                                                        Anthropic/OpenAI/NVIDIA/...
```

Cloud Code remains a first-class adapter with its existing multi-account quota-aware strategies. Pi's `@earendil-works/pi-ai` package supplies maintained provider catalogs, protocol implementations, model metadata, pricing, OAuth implementations, and API-key authentication semantics for other providers. For providers that expose account-level model availability, the public catalog is the union of supported models and request rotation is restricted to accounts that support the selected model.

## Model identifiers

The router uses collision-safe IDs for non-Cloud-Code models:

```text
provider/model-id
anthropic/claude-opus-4-6
openai/gpt-5.4
nvidia/meta/llama-...
```

Cloud Code keeps its existing unprefixed IDs for backward compatibility and also accepts `cloudcode/<id>`. A central resolver applies configured aliases and canonical family prefixes. For example, `opus-4-6` resolves to a canonical `claude-opus-4-6...` identifier instead of being sent upstream unchanged.

## Credentials

- Cloud Code Google accounts stay in the existing account manager.
- Pi provider credentials are stored in `~/.config/antigravity-proxy/router-auth.json` with mode `0600`.
- API-key and OAuth credentials share Pi's credential shapes and are resolved/refreshed by Pi's provider runtime.
- Pi providers support multiple enabled credentials per provider. GitHub Copilot and OpenAI Codex availability is discovered per account and cached briefly; incompatible accounts are excluded before dispatch. API-key providers without a model-availability endpoint retain Pi's configured provider catalog.

## Inbound router keys

Generated keys are random `picc_...` values. Only SHA-256 hashes are retained. Policies can restrict:

- exact models or wildcard model patterns;
- providers;
- expiration;
- requests per minute;
- tokens per day;
- estimated monthly spend.

The legacy `API_KEY`/`config.apiKey` remains accepted as an unrestricted administrator key.

## Usage and expense accounting

Every completed request records:

- timestamp and duration;
- inbound API key identity;
- provider, provider account identity when known, and model;
- input/output/cache-read/cache-write/reasoning tokens;
- estimated public API cost using the model pricing snapshot at request time;
- status and error details.

The SQLite ledger is stored at `~/.config/antigravity-proxy/router-usage.db`. Provider-reported remaining quota is shown when available. Providers that do not expose quota are explicitly marked `not_reported`; token accounting is still available.

## Pi import

The router writes/merges `~/.pi/agent/models.json` with a `picc-router` OpenAI-compatible provider pointing at `http://localhost:<port>/v1`. It includes the router's current model catalog and a dedicated scoped router API key. Existing unrelated Pi providers and settings are preserved.

## Compatibility phases

Implemented public surfaces are:

- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/chat/completions`

OpenAI Responses (`POST /v1/responses`) is intentionally a later compatibility surface; Chat Completions is the stable common denominator used by the Pi import.

## Security boundaries

- Web UI administration remains protected by `WEBUI_PASSWORD` when configured.
- Generated API keys are shown once and stored only as hashes.
- Provider secrets are never returned by APIs or logs.
- Sensitive files use atomic replacement and `0600` permissions.
- Model/key policy checks occur before provider dispatch.

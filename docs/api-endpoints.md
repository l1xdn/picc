# API Endpoints

| Endpoint          | Method | Description                                                           |
| ----------------- | ------ | --------------------------------------------------------------------- |
| `/health`         | GET    | Health check                                                          |
| `/account-limits` | GET    | Account status and quota limits (add `?format=table` for ASCII table) |
| `/v1/messages` | POST | Anthropic Messages API across Cloud Code and connected router providers |
| `/v1/chat/completions` | POST | OpenAI Chat Completions API across all connected providers |
| `/v1/models` | GET | Unified model catalog filtered by calling-key scope and connected-account model availability |
| `/refresh-token` | POST | Force Cloud Code token refresh |
| `/api/router/providers` | GET | Provider connection status and account metadata |
| `/api/router/quotas` | GET | Cached provider-reported account quotas (`refresh=true` bypasses cache); unsupported providers return `not_reported` |
| `/api/router/providers/:provider/credential` | PUT/DELETE | Add an API-key account or remove provider credentials |
| `/api/router/providers/:provider/oauth` | POST | Start a Pi provider OAuth flow |
| `/api/router/keys` | GET/POST | List or generate scoped inbound router keys |
| `/api/router/keys/:id` | PATCH/DELETE | Update, disable, or revoke an inbound key |
| `/api/router/expenses` | GET | Token and estimated-cost summary (`range=24h|7d|30d|90d|all`) |
| `/api/router/pi/import` | POST | Merge the available catalog and a dedicated key into local Pi settings |

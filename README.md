# Antigravity Claude Proxy & Unified Model Router

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An advanced proxy server and local multi-provider router that exposes **Anthropic-compatible** (`/v1/messages`) and **OpenAI-compatible** (`/v1/chat/completions`) APIs. It is backed by **Google Cloud Code / Antigravity**, **Anthropic**, **OpenAI Codex**, **GitHub Copilot**, and direct API key providers, enabling seamless use with **Claude Code CLI**, **Pi Coding Agent**, **OpenClaw / ClawdBot**, and any standard LLM client.

![Antigravity Claude Proxy Banner](images/banner.png)

> **⚠️ WARNING:** Google has been issuing ToS violation bans on accounts connected to Cloud Code proxying. Use at your own risk.

<details>
<summary><strong>⚠️ Terms of Service Warning — Read Before Installing</strong></summary>

> [!CAUTION]
> Using Google Cloud Code via an unofficial proxy may violate Google's Terms of Service. A small number of users have reported their Google accounts being **banned** or **shadow-banned** (restricted access without explicit notification).
>
> **By using this proxy, you acknowledge:**
> - This is an unofficial tool not endorsed by Google or Anthropic
> - Your Google account may be suspended or permanently banned
> - You assume all risks associated with using this proxy
>
> **Recommendation:** Do not use your main account. Use a burner account instead, and optionally add it to your main account's family plan if needed.

</details>

---

## Overview

**Antigravity Claude Proxy & Unified Model Router** acts as both a protocol translation proxy and an intelligent, multi-account local gateway:

1. **Cloud Code Proxy**: Translates Anthropic Messages API format into Google's Cloud Code Generative AI format, giving you access to Claude (Opus, Sonnet, Haiku) and Gemini models through Google account quotas with full thinking and streaming support.
2. **Unified Model Router**: Acts as a local gateway powered by the Pi provider runtime. Pool accounts across multiple providers (Cloud Code, Anthropic, OpenAI Codex, GitHub Copilot, custom API keys) with intelligent load balancing and automatic failover.
3. **Dual API Compatibility**: Exposes both **Anthropic Messages API** (`POST /v1/messages`) and **OpenAI Chat Completions API** (`POST /v1/chat/completions`) endpoints.
4. **Multi-Account Load Balancing**: Supports **Sticky**, **Round Robin**, and **Hybrid** account rotation strategies with token bucket rate-limiting, health tracking, and quota monitoring.
5. **Inbound API Keys**: Issue hashed API keys with granular permissions—restrict by provider, exact model or wildcard patterns, rate limits, daily token caps, and monthly cost budgets.
6. **Client Integrations**: Native configuration for **Claude Code CLI**, **Pi Coding Agent**, **OpenClaw / ClawdBot**, and standard SDKs.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                                    Client Applications                                   │
│  Claude Code CLI  │  Pi Coding Agent  │  OpenClaw / ClawdBot  │  OpenAI / Anthropic SDKs │
└────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                             │
                                             ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                     Antigravity Proxy & Unified Model Router                             │
│                                                                                          │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌──────────────────────────┐  │
│  │ POST /v1/messages       │  │ POST /v1/chat/...       │  │ Inbound API Keys         │  │
│  │ (Anthropic Protocol)    │  │ (OpenAI Protocol)       │  │ & Spending Limits        │  │
│  └────────────┬────────────┘  └────────────┬────────────┘  └─────────────┬────────────┘  │
│               └──────────────────────┬─────┘                             │               │
│                                      ▼                                   │               │
│                    ┌───────────────────────────────────┐                 │               │
│                    │ Multi-Account Load Balancer       │◄────────────────┘               │
│                    │ (Sticky / Round-Robin / Hybrid)   │                               │
│                    └─────────────────┬─────────────────┘                                 │
└──────────────────────────────────────┼───────────────────────────────────────────────────┘
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            ▼                          ▼                          ▼
┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────────────┐
│  Google Cloud Code    │  │  Anthropic / OpenAI   │  │ Upstream API Keys     │
│  (Multi-Account OAuth)│  │  (Subscription OAuth) │  │ (OpenAI, Groq, etc.)  │
└───────────────────────┘  └───────────────────────┘  └───────────────────────┘
```

---

## Prerequisites

- **Node.js** 22.19 or later (required by the Pi provider runtime)
- **Git** (for cloning the repository)
- **Antigravity App** (optional; automatically detected for single-account Cloud Code mode) OR Google account(s) for multi-account Cloud Code mode

---

## Installation & Setup

### 1. Clone the Repository

```bash
git clone https://github.com/l1xdn/picc.git
cd picc
npm install
```

### 2. Configure OAuth Credentials (For Cloud Code Multi-Account)

Google Cloud Code login requires a Desktop OAuth client. Store your configuration outside the repository directory:

```bash
mkdir -p ~/.config/antigravity-proxy
cp .env.example ~/.config/antigravity-proxy/.env
chmod 600 ~/.config/antigravity-proxy/.env
```

Edit `~/.config/antigravity-proxy/.env` and set your `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` created in the Google Cloud Console as a **Desktop application**.

### 3. Start the Server

```bash
# Start in background (default port 8080)
npm start

# Or run in dev mode with live reload
npm run dev

# Or run with CSS watching + dev server
npm run dev:full
```

The management dashboard will be available at **`http://localhost:8080`**.

---

## Account Management

### Method A: Web Dashboard (Recommended)

1. Open `http://localhost:8080` in your browser.
2. Navigate to **Accounts**.
3. Click **Add Account** to complete Google OAuth or link subscription OAuth accounts (Anthropic, OpenAI Codex, GitHub Copilot).

> **Headless / Remote Servers**: Click "Add Account" in the Web UI and select "Manual Authorization" to complete OAuth on your local machine and paste the authorization code back.

### Method B: CLI Account Commands

```bash
# Add Google account via interactive browser
npm run accounts:add

# Headless / SSH server setup
npm run accounts:add -- --no-browser

# List added accounts and status
npm run accounts:list

# Verify account tokens and quota status
npm run accounts:verify
```

### Method C: Automatic Detection (Antigravity Users)

If you have the **Antigravity** app installed and logged in locally, the proxy automatically detects your active session without requiring manual OAuth setup.

---

## Unified Model Router & Features

The router functions as a centralized gateway for all your AI models:

### 1. Dual API Protocols
- **Anthropic Format**: `POST /v1/messages` — Full support for message turns, content blocks, tool calling, system prompts, prompt caching, and thinking signatures.
- **OpenAI Format**: `POST /v1/chat/completions` — Support for chat completion requests, streaming response chunks, tool parameters, and standard OpenAI parameters.

### 2. Provider Account Pools & Routing Strategies
Pool multiple accounts per provider to maximize throughput and bypass rate limits. Available strategies:
- **Hybrid (Default)**: Dynamic scoring based on account health, remaining token buckets, quota levels, and usage history.
- **Sticky**: Routes requests to the same active account until rate limits or quota thresholds are met, minimizing session context switching.
- **Round-Robin**: Sequentially rotates requests across all available accounts in the pool.

### 3. Inbound API Keys & Access Control
Manage custom client keys from **WebUI → API Keys**:
- Scope keys to specific providers or model patterns (e.g., `anthropic/*`, `google/*`, or exact model IDs).
- Set per-minute rate limits, daily token caps, and monthly cost thresholds.
- Authenticate incoming requests using `Authorization: Bearer <key>` or `x-api-key: <key>`.

### 4. Expense & Token Tracking
Review real-time metrics in **WebUI → Expenses**:
- Breakdown of input, output, cache-read, cache-creation, and reasoning tokens.
- Public API cost estimations across all linked providers.

---

## Client Integrations

### 1. Claude Code CLI

#### Web UI Configuration (Recommended)
1. Open `http://localhost:8080` and navigate to **Settings → Claude CLI**.
2. Switch between **Proxy Mode** (local proxy) and **Paid Mode** (direct Anthropic billing).
3. Select preferred default models for Opus, Sonnet, and Haiku tiers.
4. Click **Apply to Claude CLI**.

#### Manual Configuration
Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-sonnet-4-6",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-6",
    "ENABLE_EXPERIMENTAL_MCP_CLI": "true"
  }
}
```

Then run `claude` in your terminal.

---

### 2. Pi Coding Agent

The proxy seamlessly connects with **Pi**:
1. In the Web UI, go to **Settings → Pi Agent**.
2. Copy the generated configuration snippet or click **Import Catalog**.
3. Use non-Cloud-Code prefixed models (e.g., `anthropic/claude-opus-4-6`, `openai/gpt-5.4`, `nvidia/<model-id>`) alongside Cloud Code model IDs.

---

### 3. OpenClaw / ClawdBot

Set your OpenClaw / ClawdBot environment variables or config:
- `ANTHROPIC_BASE_URL`: `http://localhost:8080`
- `ANTHROPIC_API_KEY`: `test` (or your custom router API key)

See [OpenClaw Integration Guide](docs/openclaw.md) for detailed instructions.

---

### 4. Custom Applications & SDKs

#### Python (Anthropic SDK)
```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:8080",
    api_key="test" # or router API key
)

response = client.messages.create(
    model="claude-opus-4-6-thinking",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello world!"}]
)
print(response.content[0].text)
```

#### Python (OpenAI SDK)
```python
import openai

client = openai.OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="test" # or router API key
)

response = client.chat.completions.create(
    model="gemini-3.1-pro-low",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

#### cURL
```bash
# Anthropic endpoint
curl http://localhost:8080/v1/messages \
  -H "x-api-key: test" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# OpenAI endpoint
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.5-flash-low",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

---

## Documentation

- [Available Models](docs/models.md)
- [Router Architecture](docs/router-architecture.md)
- [Multi-Account Load Balancing](docs/load-balancing.md)
- [Web Management Console](docs/web-console.md)
- [Advanced Configuration](docs/configuration.md)
- [macOS Menu Bar App](docs/menubar-app.md)
- [OpenClaw / ClawdBot Integration](docs/openclaw.md)
- [API Endpoints](docs/api-endpoints.md)
- [Testing](docs/testing.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Safety, Usage, and Risk Notices](docs/safety-notices.md)
- [Legal](docs/legal.md)
- [Development](docs/development.md)

---

## Credits & Acknowledgments

This project is a fork and extension of [antigravity-claude-proxy](https://github.com/badrisnarayanan/antigravity-claude-proxy), expanding its original single-purpose Cloud Code proxy into a multi-account load balancer and unified model router with multi-provider OAuth, dual OpenAI/Anthropic API support, and inbound API key management.

It also draws insights and code from:
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - Antigravity OAuth plugin for OpenCode
- [claude-code-proxy](https://github.com/1rgs/claude-code-proxy) - Anthropic API proxy using LiteLLM

---

## License

MIT

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=badrisnarayanan/antigravity-claude-proxy&type=date&legend=top-left&cache-control=no-cache)](https://www.star-history.com/#badrisnarayanan/antigravity-claude-proxy&type=date&legend=top-left)

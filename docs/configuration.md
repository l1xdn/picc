# Advanced Configuration

While most users can use the default settings, you can tune the proxy behavior via the **Settings → Server** tab in the WebUI or by creating a `config.json` file.

## Environment Variables

The proxy supports the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8080` |
| `HOST` | Bind address | `0.0.0.0` |
| `HTTP_PROXY` | Route outbound requests through a proxy | - |
| `HTTPS_PROXY` | Same as HTTP_PROXY (for HTTPS requests) | - |
| `API_KEY` | Protect `/v1/*` API endpoints | - |
| `WEBUI_PASSWORD` | Password-protect the web dashboard | - |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Desktop OAuth client ID used only for Cloud Code account login | Required for Google OAuth |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Desktop OAuth client secret | Required for Google OAuth |
| `PICC_ENV_FILE` | Explicit path to a local env file | `~/.config/antigravity-proxy/.env` or project `.env` |
| `DEBUG` | Enable debug logging (`true`/`false`) | `false` |
| `DEV_MODE` | Enable developer mode (`true`/`false`) | `false` |
| `FALLBACK` | Enable model fallback (`true`/`false`) | `false` |
| `FALLBACK_ANTIGRAVITY_VERSION` | Override the User-Agent version string (useful when Google APIs reject old versions) | `1.23.2` |
| `ANTIGRAVITY_CLIENT_VERSION` | Override the X-Client-Version header sent to the API (prevents "no longer supported" errors) | Auto-detected from product.json |
| `ANTIGRAVITY_CLIENT_VERSION_FALLBACK` | Override the fallback X-Client-Version (used when product.json is not found) | `1.110.0` |
| `CLAUDE_CONFIG_PATH` | Path to `.claude` directory for CLI settings (for systemd/service deployments) | `~/.claude` |

### Local Secret File (Recommended)

Never place credentials in source files or `config.example.json`. Create a local owner-only env file:

```bash
mkdir -p ~/.config/antigravity-proxy
cp .env.example ~/.config/antigravity-proxy/.env
chmod 600 ~/.config/antigravity-proxy/.env
# Edit the file and add your own credentials.
```

The proxy automatically loads the project `.env` and `~/.config/antigravity-proxy/.env`. Existing process environment variables take precedence. Both local env locations are excluded from Git and npm packages.

For Google account login, create your own **Desktop app** OAuth client in Google Cloud Console and set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. Do not reuse credentials found in forks or commit them to Git. If credentials were previously committed, rotate them after rewriting history.

### Setting Environment Variables

#### Inline (single command)

Set variables for just one command. Works on macOS, Linux, and Windows with Git Bash/WSL:

```bash
PORT=3000 HTTP_PROXY=http://proxy:8080 npm start
```

#### macOS / Linux (persistent)

Add to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export PORT=3000
export HTTP_PROXY=http://proxy:8080
```

Then reload: `source ~/.zshrc`

#### Windows Command Prompt (persistent)

```cmd
setx PORT 3000
setx HTTP_PROXY http://proxy:8080
```

Restart your terminal for changes to take effect.

#### Windows PowerShell (persistent)

```powershell
[Environment]::SetEnvironmentVariable("PORT", "3000", "User")
[Environment]::SetEnvironmentVariable("HTTP_PROXY", "http://proxy:8080", "User")
```

Restart your terminal for changes to take effect.

### HTTP Proxy Support

If you're behind a corporate firewall or VPN, you can route all outbound API requests through a proxy server:

```bash
# Route through a local proxy (e.g., for debugging with mitmproxy)
HTTP_PROXY=http://127.0.0.1:8888 npm start

# Route through a corporate proxy
HTTP_PROXY=http://proxy.company.com:3128 npm start

# With authentication
HTTP_PROXY=http://user:password@proxy.company.com:3128 npm start
```

The proxy supports `http_proxy`, `HTTP_PROXY`, `https_proxy`, and `HTTPS_PROXY` (case-insensitive).

## Configurable Options

- **API Key Authentication**: Protect `/v1/*` API endpoints with `API_KEY` env var or `apiKey` in config.
- **WebUI Password**: Secure your dashboard with `WEBUI_PASSWORD` env var or in config.
- **Custom Port**: Change the default `8080` port.
- **Retry Logic**: Configure `maxRetries`, `retryBaseMs`, and `retryMaxMs`.
- **Rate Limit Handling**: Comprehensive rate limit detection from headers and error messages with intelligent retry-after parsing.
- **Load Balancing**: Adjust `defaultCooldownMs` and `maxWaitBeforeErrorMs`.
- **Persistence**: Enable `persistTokenCache` to save OAuth sessions across restarts.
- **Max Accounts**: Set `maxAccounts` (1-100) to limit the number of Google accounts. Default: 10.
- **Quota Threshold**: Set `globalQuotaThreshold` (0-0.99) to switch accounts before quota drops below a minimum level. Supports per-account and per-model overrides.
- **Endpoint Fallback**: Automatic 403/404 endpoint fallback for API compatibility.

Local credential files (`accounts.json`, `router-auth.json`, `router-api-keys.json`, and `.env`) are stored outside the repository under `~/.config/antigravity-proxy/` with owner-only permissions where supported. API responses containing account data are marked `Cache-Control: no-store`, logs redact common credential forms, and Web UI passwords are sent in headers rather than URLs.

Run `npm run security:scan` before committing. Refer to `config.example.json` for non-secret configuration fields.

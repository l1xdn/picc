const CACHE_TTL_MS = 60_000;
const ERROR_CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 12_000;
const cache = new Map();

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const number = value => {
    const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
    return Number.isFinite(parsed) ? parsed : null;
};
const isoDate = value => {
    if (value === null || value === undefined || value === '') return null;
    const numeric = number(value);
    const timestamp = numeric !== null
        ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
        : Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};
const resetFromSeconds = value => {
    const seconds = number(value);
    return seconds === null ? null : new Date(Date.now() + seconds * 1000).toISOString();
};

function percentWindow(name, usedPercent, resetAt = null) {
    const used = number(usedPercent);
    if (used === null) return null;
    const remainingFraction = clamp(100 - used, 0, 100) / 100;
    return { name, usedPercent: clamp(used, 0, 100), remainingFraction, resetAt };
}

function fractionWindow(name, remaining, entitlement, unlimited = false, resetAt = null) {
    if (unlimited) return { name, remainingFraction: null, remaining: null, entitlement: null, unlimited: true, resetAt };
    const left = number(remaining);
    const total = number(entitlement);
    if (left === null || total === null || total <= 0) return null;
    return {
        name,
        remainingFraction: clamp(left / total, 0, 1),
        remaining: left,
        entitlement: total,
        unlimited: false,
        resetAt
    };
}

function reported(windows, extra = {}) {
    const recognized = windows.filter(Boolean);
    if (!recognized.length) return { status: 'unavailable', reason: 'Provider returned no recognized quota limits' };
    const finite = recognized.filter(window => Number.isFinite(window.remainingFraction));
    const effective = finite.length
        ? finite.reduce((lowest, window) => window.remainingFraction < lowest.remainingFraction ? window : lowest)
        : null;
    return {
        status: 'reported',
        remainingFraction: effective?.remainingFraction ?? null,
        resetAt: effective?.resetAt || null,
        unlimited: !finite.length && recognized.some(window => window.unlimited),
        windows: recognized,
        ...extra
    };
}

export function parseAnthropicQuota(raw) {
    const labels = {
        five_hour: '5-hour session',
        seven_day: '7-day total',
        seven_day_opus: '7-day Opus',
        seven_day_sonnet: '7-day Sonnet',
        seven_day_oauth_apps: '7-day OAuth apps'
    };
    const windows = Object.entries(labels).map(([field, label]) => {
        const value = raw?.[field];
        if (!value || typeof value !== 'object') return null;
        return percentWindow(label, value.utilization, isoDate(value.resets_at || value.reset_at));
    });
    return reported(windows, { identity: raw?.email || null });
}

export function parseOpenAICodexQuota(raw) {
    const rateLimit = raw?.rate_limit || raw?.rateLimit || {};
    const parseWindow = (value, label) => value && typeof value === 'object'
        ? percentWindow(
            label,
            value.used_percent ?? value.usedPercent,
            isoDate(value.reset_at ?? value.resetAt) || resetFromSeconds(value.reset_after_seconds ?? value.resetAfterSeconds)
        )
        : null;
    const windows = [
        parseWindow(rateLimit.primary_window || rateLimit.primaryWindow, 'Primary window'),
        parseWindow(rateLimit.secondary_window || rateLimit.secondaryWindow, 'Secondary window')
    ];
    const credits = raw?.credits;
    if (credits?.unlimited === true) {
        windows.push({ name: 'Credits', remainingFraction: null, unlimited: true, resetAt: null });
    } else if (number(credits?.balance) !== null) {
        windows.push({ name: 'Credits', remainingFraction: null, remaining: number(credits.balance), unit: 'credits', resetAt: null });
    }
    return reported(windows, {
        tier: raw?.plan_type || raw?.planType || null,
        identity: raw?.email || null
    });
}

export function parseGitHubCopilotQuota(raw) {
    const snapshots = raw?.quota_snapshots || raw?.quotaSnapshots || {};
    const labels = {
        premium_interactions: 'Premium requests',
        chat: 'Chat',
        completions: 'Completions'
    };
    const resetAt = isoDate(raw?.quota_reset_date || raw?.quotaResetDate);
    const windows = Object.entries(labels).map(([field, label]) => {
        const value = snapshots[field];
        if (!value || typeof value !== 'object') return null;
        return fractionWindow(label, value.remaining, value.entitlement, value.unlimited === true, resetAt);
    });
    return reported(windows, {
        tier: raw?.copilot_plan || raw?.copilotPlan || null,
        identity: raw?.login || raw?.github_login || raw?.githubLogin || null
    });
}

export function parseOpenRouterQuota(raw) {
    const data = raw?.data || raw;
    if (data?.limit === null && data?.limit_remaining === null) {
        return reported([{ name: 'Account credit', remainingFraction: null, unlimited: true, resetAt: null }], {
            tier: data?.is_free_tier ? 'free' : null
        });
    }
    return reported([
        fractionWindow('Account credit', data?.limit_remaining, data?.limit, false, null)
    ], { tier: data?.is_free_tier ? 'free' : null });
}

async function fetchJson(url, options, fetchImpl) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
        const error = new Error(response.status === 401 || response.status === 403
            ? 'Provider rejected quota authentication'
            : `Provider quota endpoint returned HTTP ${response.status}`);
        error.statusCode = response.status;
        throw error;
    }
    return response.json();
}

async function queryQuota(providerId, credential, fetchImpl) {
    if (providerId === 'anthropic' && credential?.type === 'oauth') {
        const raw = await fetchJson('https://api.anthropic.com/api/oauth/usage', {
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${credential.access}`,
                'anthropic-beta': 'oauth-2025-04-20',
                'User-Agent': 'claude-code/2.0.0'
            }
        }, fetchImpl);
        return parseAnthropicQuota(raw);
    }

    if (providerId === 'openai-codex' && credential?.type === 'oauth') {
        const raw = await fetchJson('https://chatgpt.com/backend-api/wham/usage', {
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${credential.access}`,
                ...(credential.accountId ? { 'ChatGPT-Account-Id': credential.accountId } : {}),
                'User-Agent': 'codex_cli_rs/0.1.0'
            }
        }, fetchImpl);
        return parseOpenAICodexQuota(raw);
    }

    if (providerId === 'github-copilot' && credential?.type === 'oauth') {
        const domain = credential.enterpriseUrl || 'github.com';
        const url = domain === 'github.com'
            ? 'https://api.github.com/copilot_internal/user'
            : `https://api.${domain}/copilot_internal/user`;
        const raw = await fetchJson(url, {
            headers: {
                Accept: 'application/json',
                Authorization: `token ${credential.refresh}`,
                'User-Agent': 'GitHubCopilotChat/0.35.0',
                'Editor-Version': 'vscode/1.107.0',
                'Editor-Plugin-Version': 'copilot-chat/0.35.0',
                'Copilot-Integration-Id': 'vscode-chat'
            }
        }, fetchImpl);
        return parseGitHubCopilotQuota(raw);
    }

    if (providerId === 'openrouter' && credential?.type === 'api_key') {
        const raw = await fetchJson('https://openrouter.ai/api/v1/auth/key', {
            headers: { Accept: 'application/json', Authorization: `Bearer ${credential.key}` }
        }, fetchImpl);
        return parseOpenRouterQuota(raw);
    }

    return { status: 'not_reported', reason: 'Provider has no supported quota API' };
}

async function refreshCredentialIfNeeded(provider, account, credentialStore, models) {
    let credential = await credentialStore.readAccountCredential(provider.id, account.id);
    if (credential?.type !== 'oauth' || !credential.expires || credential.expires > Date.now() + 60_000) return credential;
    const model = models.getProvider(provider.id)?.getModels()?.[0];
    if (!model) return credential;
    await credentialStore.runWithAccount(provider.id, account.id, () => models.getAuth(model));
    credential = await credentialStore.readAccountCredential(provider.id, account.id);
    return credential;
}

export async function getProviderQuotas(providerStatuses, {
    credentialStore,
    models,
    fetchImpl = fetch,
    force = false
}) {
    return Promise.all(providerStatuses.map(async provider => {
        const accounts = await Promise.all((provider.accounts || []).map(async account => {
            const key = `${provider.id}:${account.id}`;
            const cached = cache.get(key);
            if (!force && cached && Date.now() - cached.timestamp < cached.ttl) {
                return { id: account.id, quota: cached.value };
            }
            let value;
            try {
                const credential = await refreshCredentialIfNeeded(provider, account, credentialStore, models);
                value = await queryQuota(provider.id, credential, fetchImpl);
            } catch (error) {
                value = { status: 'unavailable', reason: error.message };
            }
            cache.set(key, {
                value,
                timestamp: Date.now(),
                ttl: value.status === 'reported' || value.status === 'not_reported' ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS
            });
            return { id: account.id, quota: value };
        }));
        return { id: provider.id, accounts };
    }));
}

export function getCachedAccountQuota(providerId, accountId) {
    const cached = cache.get(`${providerId}:${accountId}`);
    if (!cached) return null;
    return { ...cached.value, checkedAt: cached.timestamp };
}

export function clearQuotaCache() {
    cache.clear();
}

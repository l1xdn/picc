const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const CODEX_CLIENT_VERSION = '0.114.0';
const cache = new Map();

function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function githubBaseUrl(token, enterpriseDomain) {
    const match = typeof token === 'string' ? token.match(/proxy-ep=([^;]+)/) : null;
    if (match) return `https://${match[1].replace(/^proxy\./, 'api.')}`;
    if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
    return 'https://api.individual.githubcopilot.com';
}

export function parseGitHubCopilotModelIds(value) {
    const data = asRecord(value)?.data;
    if (!Array.isArray(data)) throw new Error('Invalid GitHub Copilot model response');
    return [...new Set(data.flatMap(raw => {
        const item = asRecord(raw);
        const policy = asRecord(item?.policy);
        const supports = asRecord(asRecord(item?.capabilities)?.supports);
        return typeof item?.id === 'string'
            && item.model_picker_enabled === true
            && policy?.state !== 'disabled'
            && supports?.tool_calls !== false
            ? [item.id]
            : [];
    }))];
}

export function parseOpenAICodexModelIds(value) {
    const models = asRecord(value)?.models;
    if (!Array.isArray(models)) throw new Error('Invalid OpenAI Codex model response');
    return [...new Set(models.flatMap(raw => {
        const item = asRecord(raw);
        const id = item?.slug;
        return typeof id === 'string'
            && item.visibility !== 'hide'
            && item.supported_in_api !== false
            ? [id]
            : [];
    }))];
}

async function fetchJson(url, headers, fetchImpl) {
    const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Model availability endpoint returned HTTP ${response.status}`);
    return response.json();
}

async function discoverModelIds(providerId, credential, fetchImpl) {
    if (providerId === 'github-copilot' && credential?.type === 'oauth' && credential.access) {
        try {
            const raw = await fetchJson(`${githubBaseUrl(credential.access, credential.enterpriseUrl)}/models`, {
                Accept: 'application/json',
                Authorization: `Bearer ${credential.access}`,
                'User-Agent': 'GitHubCopilotChat/0.35.0',
                'Editor-Version': 'vscode/1.107.0',
                'Editor-Plugin-Version': 'copilot-chat/0.35.0',
                'Copilot-Integration-Id': 'vscode-chat',
                'X-GitHub-Api-Version': '2026-06-01'
            }, fetchImpl);
            return new Set(parseGitHubCopilotModelIds(raw));
        } catch {
            if (Array.isArray(credential.availableModelIds)) {
                return new Set(credential.availableModelIds.filter(id => typeof id === 'string'));
            }
            return null;
        }
    }

    if (providerId === 'openai-codex' && credential?.type === 'oauth' && credential.access) {
        try {
            const raw = await fetchJson(
                `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`,
                {
                    Accept: 'application/json',
                    Authorization: `Bearer ${credential.access}`,
                    ...(credential.accountId ? { 'ChatGPT-Account-Id': credential.accountId } : {}),
                    'User-Agent': `codex_cli_rs/${CODEX_CLIENT_VERSION}`
                },
                fetchImpl
            );
            return new Set(parseOpenAICodexModelIds(raw));
        } catch {
            return Array.isArray(credential.availableModelIds)
                ? new Set(credential.availableModelIds.filter(id => typeof id === 'string'))
                : null;
        }
    }

    return Array.isArray(credential?.availableModelIds)
        ? new Set(credential.availableModelIds.filter(id => typeof id === 'string'))
        : null;
}

export async function getProviderAccountModelAvailability(providerId, {
    credentialStore,
    fetchImpl = fetch,
    force = false
}) {
    const accounts = (await credentialStore.listAccounts(providerId)).filter(account => account.enabled !== false);
    const entries = await Promise.all(accounts.map(async account => {
        const key = `${providerId}:${account.id}`;
        const cached = cache.get(key);
        if (!force && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
            return [account.id, cached.modelIds];
        }
        const credential = await credentialStore.readAccountCredential(providerId, account.id);
        const modelIds = await discoverModelIds(providerId, credential, fetchImpl);
        cache.set(key, { timestamp: Date.now(), modelIds });
        return [account.id, modelIds];
    }));
    return new Map(entries);
}

export function unionCatalogModelIds(accountAvailability) {
    if (accountAvailability.size === 0 || [...accountAvailability.values()].some(value => value === null)) {
        return null;
    }
    return new Set([...accountAvailability.values()].flatMap(value => [...value]));
}

export function clearModelAvailabilityCache() {
    cache.clear();
}

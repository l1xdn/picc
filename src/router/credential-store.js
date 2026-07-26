import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';

const DEFAULT_PATH = path.join(os.homedir(), '.config', 'antigravity-proxy', 'router-auth.json');

async function readJson(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        await fs.chmod(filePath, 0o600).catch(() => {});
        const parsed = JSON.parse(content);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

async function atomicWrite(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(filePath), 0o700).catch(() => {});
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600).catch(() => {});
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
}

function decodeJwtPayload(token) {
    if (typeof token !== 'string' || token.split('.').length < 2) return {};
    try {
        return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    } catch {
        return {};
    }
}

function publicCredentialMetadata(credential) {
    if (credential?.type !== 'oauth') return {};
    const claims = decodeJwtPayload(credential.access);
    const openAiAuth = claims['https://api.openai.com/auth'] || {};
    const firstString = (...values) => values.find(value => typeof value === 'string' && value.trim())?.trim();
    return {
        identity: firstString(
            credential.email,
            credential.username,
            credential.login,
            claims.email,
            claims.name,
            credential.accountId,
            openAiAuth.chatgpt_account_id
        ) || null,
        tier: firstString(
            credential.tier,
            credential.plan,
            credential.planType,
            openAiAuth.chatgpt_plan_type
        ) || null,
        expiresAt: Number.isFinite(credential.expires) ? new Date(credential.expires).toISOString() : null
    };
}

function ensureShape(data) {
    data.version = 2;
    data.providers ||= {};
    data.accounts ||= {};
    // Version 1 stored one credential directly under providers. It remains the
    // active fallback and is mirrored into the account pool on the next write.
    for (const [providerId, credential] of Object.entries(data.providers)) {
        data.accounts[providerId] ||= [];
        if (credential && !data.accounts[providerId].length) {
            data.accounts[providerId].push({
                id: crypto.randomUUID(), label: 'Primary account', credential,
                enabled: true, createdAt: new Date().toISOString(), lastUsedAt: null
            });
        }
    }
    return data;
}

/** Persistent, multi-account implementation of pi-ai's CredentialStore contract. */
export class RouterCredentialStore {
    constructor(filePath = process.env.ROUTER_AUTH_PATH || DEFAULT_PATH) {
        this.filePath = filePath;
        this.chains = new Map();
        this.context = new AsyncLocalStorage();
        this.cursors = new Map();
    }

    selectedAccount(data, providerId) {
        const selectedId = this.context.getStore()?.providerId === providerId
            ? this.context.getStore().accountId
            : null;
        const accounts = data.accounts?.[providerId] || [];
        return accounts.find(account => account.id === selectedId && account.enabled !== false)
            || accounts.find(account => account.enabled !== false)
            || null;
    }

    async read(providerId) {
        const data = ensureShape(await readJson(this.filePath));
        return this.selectedAccount(data, providerId)?.credential || data.providers?.[providerId];
    }

    async list() {
        const data = ensureShape(await readJson(this.filePath));
        return data.providers;
    }

    async readAccountCredential(providerId, accountId) {
        const data = ensureShape(await readJson(this.filePath));
        return (data.accounts?.[providerId] || []).find(account => account.id === accountId)?.credential || null;
    }

    async listAccounts(providerId = null) {
        const data = ensureShape(await readJson(this.filePath));
        const sanitize = account => ({
            id: account.id,
            label: account.label,
            type: account.credential?.type,
            enabled: account.enabled !== false,
            createdAt: account.createdAt,
            lastUsedAt: account.lastUsedAt || null,
            ...publicCredentialMetadata(account.credential)
        });
        if (providerId) return (data.accounts[providerId] || []).map(sanitize);
        return Object.fromEntries(Object.entries(data.accounts).map(([id, accounts]) => [id, accounts.map(sanitize)]));
    }

    enqueue(providerId, task) {
        const previous = this.chains.get(providerId) || Promise.resolve();
        const operation = previous.catch(() => {}).then(task);
        this.chains.set(providerId, operation);
        return operation.finally(() => {
            if (this.chains.get(providerId) === operation) this.chains.delete(providerId);
        });
    }

    async modify(providerId, fn) {
        return this.enqueue(providerId, async () => {
            const data = ensureShape(await readJson(this.filePath));
            const selected = this.selectedAccount(data, providerId);
            const current = selected?.credential || data.providers[providerId];
            const next = await fn(current);
            if (next !== undefined) {
                data.providers[providerId] = next;
                if (selected) selected.credential = next;
                else {
                    data.accounts[providerId] ||= [];
                    data.accounts[providerId].push({
                        id: crypto.randomUUID(), label: 'Primary account', credential: next,
                        enabled: true, createdAt: new Date().toISOString(), lastUsedAt: null
                    });
                }
            }
            await atomicWrite(this.filePath, data);
            return next === undefined ? current : next;
        });
    }

    async addCredential(providerId, credential, label = null) {
        if (!credential) throw new Error('Credential is required');
        return this.enqueue(providerId, async () => {
            const data = ensureShape(await readJson(this.filePath));
            const accounts = data.accounts[providerId] ||= [];
            const account = {
                id: crypto.randomUUID(),
                label: String(label || `${credential.type === 'oauth' ? 'OAuth account' : 'API key'} ${accounts.length + 1}`).slice(0, 100),
                credential,
                enabled: true,
                createdAt: new Date().toISOString(),
                lastUsedAt: null
            };
            accounts.push(account);
            data.providers[providerId] = credential;
            await atomicWrite(this.filePath, data);
            return { id: account.id, label: account.label, type: credential.type, enabled: true, createdAt: account.createdAt, lastUsedAt: null };
        });
    }

    async delete(providerId) {
        return this.enqueue(providerId, async () => {
            const data = ensureShape(await readJson(this.filePath));
            delete data.providers[providerId];
            delete data.accounts[providerId];
            await atomicWrite(this.filePath, data);
        });
    }

    async deleteAccount(providerId, accountId) {
        return this.enqueue(providerId, async () => {
            const data = ensureShape(await readJson(this.filePath));
            const accounts = data.accounts[providerId] || [];
            const next = accounts.filter(account => account.id !== accountId);
            if (next.length === accounts.length) throw new Error('Provider account not found');
            data.accounts[providerId] = next;
            const fallback = next.find(account => account.enabled !== false) || next[0];
            if (fallback) data.providers[providerId] = fallback.credential;
            else delete data.providers[providerId];
            await atomicWrite(this.filePath, data);
        });
    }

    async setAccountEnabled(providerId, accountId, enabled) {
        return this.enqueue(providerId, async () => {
            const data = ensureShape(await readJson(this.filePath));
            const accounts = data.accounts[providerId] || [];
            const account = accounts.find(item => item.id === accountId);
            if (!account) throw new Error('Provider account not found');
            account.enabled = enabled !== false;
            const fallback = accounts.find(item => item.enabled !== false);
            if (fallback) data.providers[providerId] = fallback.credential;
            else delete data.providers[providerId];
            await atomicWrite(this.filePath, data);
            return {
                id: account.id,
                label: account.label,
                type: account.credential?.type,
                enabled: account.enabled,
                createdAt: account.createdAt,
                lastUsedAt: account.lastUsedAt || null
            };
        });
    }

    async setApiKey(providerId, key, env = undefined, label = null) {
        if (!key || typeof key !== 'string') throw new Error('API key is required');
        return this.addCredential(providerId, {
            type: 'api_key', key: key.trim(),
            ...(env && Object.keys(env).length ? { env } : {})
        }, label);
    }

    async selectAccount(providerId, modelId = null, accountAvailability = null) {
        const data = ensureShape(await readJson(this.filePath));
        const enabledAccounts = (data.accounts[providerId] || []).filter(account => account.enabled !== false);
        const accounts = !modelId || !(accountAvailability instanceof Map)
            ? enabledAccounts
            : enabledAccounts.filter(account => {
                const supported = accountAvailability.get(account.id);
                return supported === null || supported === undefined || supported.has(modelId);
            });
        if (!accounts.length) {
            if (enabledAccounts.length && modelId && accountAvailability instanceof Map) {
                const error = new Error(`No enabled ${providerId} account supports model ${modelId}`);
                error.statusCode = 400;
                throw error;
            }
            return null;
        }
        const cursorKey = modelId ? `${providerId}:${modelId}` : providerId;
        const cursor = this.cursors.get(cursorKey) || 0;
        const account = accounts[cursor % accounts.length];
        this.cursors.set(cursorKey, (cursor + 1) % accounts.length);
        return { id: account.id, label: account.label, type: account.credential.type };
    }

    runWithAccount(providerId, accountId, fn) {
        return this.context.run({ providerId, accountId }, fn);
    }
}

export const routerCredentialStore = new RouterCredentialStore();
export { DEFAULT_PATH as ROUTER_AUTH_PATH };

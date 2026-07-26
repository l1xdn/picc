import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const DEFAULT_PATH = path.join(os.homedir(), '.config', 'antigravity-proxy', 'router-api-keys.json');
const KEY_PREFIX = 'picc_';

const hashKey = value => crypto.createHash('sha256').update(value).digest('hex');

function safeEqualHex(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function wildcardMatch(pattern, value) {
    if (pattern === '*') return true;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`, 'i').test(value);
}

export class RouterApiKeyStore {
    constructor(filePath = process.env.ROUTER_API_KEYS_PATH || DEFAULT_PATH) {
        this.filePath = filePath;
        this.writeChain = Promise.resolve();
    }

    async readData() {
        try {
            const data = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
            await fs.chmod(this.filePath, 0o600).catch(() => {});
            return data;
        } catch (error) {
            if (error.code === 'ENOENT') return { version: 1, keys: [] };
            throw error;
        }
    }

    async writeData(data) {
        this.writeChain = this.writeChain.catch(() => {}).then(async () => {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
            await fs.chmod(path.dirname(this.filePath), 0o700).catch(() => {});
            const tmp = `${this.filePath}.${process.pid}.tmp`;
            await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
            await fs.rename(tmp, this.filePath);
            await fs.chmod(this.filePath, 0o600).catch(() => {});
        });
        return this.writeChain;
    }

    sanitize(record) {
        const { hash, ...safe } = record;
        return safe;
    }

    async list() {
        const data = await this.readData();
        return (data.keys || []).map(record => this.sanitize(record));
    }

    async create(input = {}) {
        const secret = `${KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
        const now = new Date().toISOString();
        const record = {
            id: crypto.randomUUID(),
            name: String(input.name || 'Router key').trim().slice(0, 100),
            prefix: `${secret.slice(0, 12)}…`,
            hash: hashKey(secret),
            enabled: true,
            allowedModels: Array.isArray(input.allowedModels) && input.allowedModels.length ? input.allowedModels : ['*'],
            allowedProviders: Array.isArray(input.allowedProviders) ? input.allowedProviders : [],
            expiresAt: input.expiresAt || null,
            limits: {
                requestsPerMinute: Number(input.limits?.requestsPerMinute) || 0,
                tokensPerDay: Number(input.limits?.tokensPerDay) || 0,
                monthlyBudgetUsd: Number(input.limits?.monthlyBudgetUsd) || 0
            },
            createdAt: now,
            lastUsedAt: null
        };
        const data = await this.readData();
        data.keys ||= [];
        data.keys.push(record);
        await this.writeData(data);
        return { key: secret, record: this.sanitize(record) };
    }

    async update(id, updates) {
        const data = await this.readData();
        const record = (data.keys || []).find(item => item.id === id);
        if (!record) throw new Error('API key not found');
        if (typeof updates.name === 'string') record.name = updates.name.trim().slice(0, 100);
        if (typeof updates.enabled === 'boolean') record.enabled = updates.enabled;
        if (Array.isArray(updates.allowedModels)) record.allowedModels = updates.allowedModels.length ? updates.allowedModels : ['*'];
        if (Array.isArray(updates.allowedProviders)) record.allowedProviders = updates.allowedProviders;
        if (updates.expiresAt !== undefined) record.expiresAt = updates.expiresAt || null;
        if (updates.limits && typeof updates.limits === 'object') {
            for (const field of ['requestsPerMinute', 'tokensPerDay', 'monthlyBudgetUsd']) {
                if (updates.limits[field] !== undefined) record.limits[field] = Math.max(0, Number(updates.limits[field]) || 0);
            }
        }
        await this.writeData(data);
        return this.sanitize(record);
    }

    async remove(id) {
        const data = await this.readData();
        const previousLength = (data.keys || []).length;
        data.keys = (data.keys || []).filter(item => item.id !== id);
        if (data.keys.length === previousLength) throw new Error('API key not found');
        await this.writeData(data);
    }

    async authenticate(secret) {
        if (!secret || !secret.startsWith(KEY_PREFIX)) return null;
        const digest = hashKey(secret);
        const data = await this.readData();
        const record = (data.keys || []).find(item => safeEqualHex(item.hash, digest));
        if (!record || !record.enabled) return null;
        if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return null;
        // Per-request activity is recorded in SQLite. Avoid rewriting the key file
        // on every request, which would serialize high-throughput traffic on disk.
        return this.sanitize(record);
    }

    allows(record, requestedModel, resolvedModel, provider) {
        if (!record) return false;
        if (record.allowedProviders?.length && !record.allowedProviders.includes(provider)) return false;
        const patterns = record.allowedModels?.length ? record.allowedModels : ['*'];
        return patterns.some(pattern => wildcardMatch(pattern, requestedModel) || wildcardMatch(pattern, resolvedModel));
    }
}

export const routerApiKeyStore = new RouterApiKeyStore();

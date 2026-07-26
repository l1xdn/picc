import { config } from '../config.js';
import { createStrategy, getStrategyLabel, DEFAULT_STRATEGY } from '../account-manager/strategies/index.js';
import {
    markRateLimited,
    markAccountCoolingDown,
    clearAccountCooldown,
    resetConsecutiveFailures,
    CooldownReason
} from '../account-manager/rate-limits.js';
import { logger } from '../utils/logger.js';
import { getProviderAccountModelAvailability } from './model-availability.js';
import { getCachedAccountQuota, getProviderQuotas } from './quota-manager.js';

const DEFAULT_FAILURE_COOLDOWN_MS = 10_000;

function strategySignature() {
    return JSON.stringify(config.accountSelection || {});
}

function quotaShape(providerId, accountId, modelId) {
    const reported = getCachedAccountQuota(providerId, accountId);
    const fraction = reported?.status === 'reported'
        ? (reported.unlimited ? 1 : reported.remainingFraction)
        : null;
    return {
        models: Number.isFinite(fraction) ? {
            [modelId]: {
                remainingFraction: fraction,
                resetTime: reported.resetAt ? Date.parse(reported.resetAt) : null
            }
        } : {},
        lastChecked: reported?.checkedAt || null
    };
}

/** Applies the configured Google account strategy to every Pi provider pool. */
export class ProviderAccountManager {
    constructor({ credentialStore, models }) {
        this.credentialStore = credentialStore;
        this.models = models;
        this.pools = new Map();
        this.signature = strategySignature();
    }

    ensureConfiguration() {
        const next = strategySignature();
        if (next === this.signature) return;
        this.signature = next;
        this.pools.clear();
        logger.info('[ProviderStrategy] Account strategy configuration changed; provider pools reinitialized');
    }

    pool(providerId) {
        this.ensureConfiguration();
        let pool = this.pools.get(providerId);
        if (!pool) {
            const name = process.env.ACCOUNT_STRATEGY || config.accountSelection?.strategy || DEFAULT_STRATEGY;
            pool = {
                name,
                strategy: createStrategy(name, config.accountSelection || {}),
                currentIndex: 0,
                accounts: new Map()
            };
            this.pools.set(providerId, pool);
            logger.info(`[ProviderStrategy] ${providerId} uses ${getStrategyLabel(name)}`);
        }
        return pool;
    }

    async accountsFor(providerId, modelId) {
        const [stored, availability] = await Promise.all([
            this.credentialStore.listAccounts(providerId),
            getProviderAccountModelAvailability(providerId, { credentialStore: this.credentialStore })
        ]);
        const pool = this.pool(providerId);
        // Availability discovery is advisory. If every account's cached model
        // list omits the requested model, let authenticated accounts attempt it
        // instead of incorrectly reporting that no provider account exists.
        const hasCompatibleAccount = stored.some(account => {
            const supported = availability.get(account.id);
            return supported === null || supported === undefined || supported.has(modelId);
        });
        if (!hasCompatibleAccount && stored.length) {
            logger.warn(`[ProviderStrategy] ${providerId} model availability is stale for ${modelId}; falling back to authenticated accounts`);
        }
        const activeIds = new Set(stored.map(account => account.id));
        for (const id of pool.accounts.keys()) {
            if (!activeIds.has(id)) pool.accounts.delete(id);
        }

        const accounts = stored.map(account => {
            let runtime = pool.accounts.get(account.id);
            if (!runtime) {
                runtime = {
                    id: account.id,
                    email: `${providerId}:${account.id}`,
                    label: account.label,
                    type: account.type,
                    enabled: account.enabled !== false,
                    isInvalid: false,
                    modelRateLimits: {},
                    lastUsed: account.lastUsedAt ? Date.parse(account.lastUsedAt) : null,
                    consecutiveFailures: 0
                };
                pool.accounts.set(account.id, runtime);
            }
            runtime.label = account.label;
            runtime.type = account.type;
            runtime.enabled = account.enabled !== false;
            runtime.availableModelIds = hasCompatibleAccount ? availability.get(account.id) : null;
            runtime.quota = quotaShape(providerId, account.id, modelId);
            return runtime;
        });

        // Quota endpoints are cached and refreshed out of band so routing does
        // not block on a provider's accounting service.
        getProviderQuotas([{ id: providerId, accounts: stored }], {
            credentialStore: this.credentialStore,
            models: this.models
        }).catch(error => logger.debug(`[ProviderStrategy] ${providerId} quota refresh failed: ${error.message}`));

        return accounts;
    }

    async selectAccount(providerId, modelId, options = {}) {
        const accounts = await this.accountsFor(providerId, modelId);
        const pool = this.pool(providerId);
        const result = pool.strategy.selectAccount(accounts, modelId, {
            currentIndex: pool.currentIndex,
            sessionId: options.sessionId
        });
        pool.currentIndex = result.index;
        return {
            account: result.account ? {
                id: result.account.id,
                label: result.account.label,
                type: result.account.type
            } : null,
            waitMs: result.waitMs || 0,
            accountCount: accounts.filter(account => account.enabled !== false).length
        };
    }

    notifySuccess(providerId, accountId, modelId) {
        const pool = this.pools.get(providerId);
        const account = pool?.accounts.get(accountId);
        if (!account) return;
        pool.strategy.onSuccess(account, modelId);
        resetConsecutiveFailures([...pool.accounts.values()], account.email);
        clearAccountCooldown(account);
        if (account.modelRateLimits?.[modelId]) delete account.modelRateLimits[modelId];
    }

    notifyRateLimit(providerId, accountId, modelId, resetMs = null) {
        const pool = this.pools.get(providerId);
        const account = pool?.accounts.get(accountId);
        if (!account) return;
        pool.strategy.onRateLimit(account, modelId);
        markRateLimited([...pool.accounts.values()], account.email, resetMs, modelId);
        this.refreshQuotas(providerId).catch(() => {});
    }

    notifyFailure(providerId, accountId, modelId, { auth = false, cooldownMs = DEFAULT_FAILURE_COOLDOWN_MS } = {}) {
        const pool = this.pools.get(providerId);
        const account = pool?.accounts.get(accountId);
        if (!account) return;
        pool.strategy.onFailure(account, modelId);
        account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
        markAccountCoolingDown(
            [...pool.accounts.values()],
            account.email,
            cooldownMs,
            auth ? CooldownReason.AUTH_FAILURE : CooldownReason.SERVER_ERROR
        );
    }

    async refreshQuotas(providerId, force = true) {
        const accounts = await this.credentialStore.listAccounts(providerId);
        return getProviderQuotas([{ id: providerId, accounts }], {
            credentialStore: this.credentialStore,
            models: this.models,
            force
        });
    }

    getHealthData() {
        const providers = [];
        for (const [providerId, pool] of this.pools) {
            const health = typeof pool.strategy.getHealthTracker === 'function'
                ? pool.strategy.getHealthTracker()
                : null;
            const buckets = typeof pool.strategy.getTokenBucketTracker === 'function'
                ? pool.strategy.getTokenBucketTracker()
                : null;
            providers.push({
                provider: providerId,
                strategy: pool.name,
                accounts: [...pool.accounts.values()].map(account => ({
                    id: account.id,
                    label: account.label,
                    enabled: account.enabled,
                    healthScore: health ? health.getScore(account.email) : null,
                    tokens: buckets ? buckets.getTokens(account.email) : null,
                    maxTokens: buckets ? buckets.getMaxTokens() : null,
                    consecutiveFailures: account.consecutiveFailures || 0
                }))
            });
        }
        return providers;
    }
}

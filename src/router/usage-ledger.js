import os from 'os';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

const DEFAULT_PATH = path.join(os.homedir(), '.config', 'antigravity-proxy', 'router-usage.db');

function number(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function calculateEstimatedCost(usage, pricing = {}) {
    const totalInput = number(usage.input) + number(usage.cacheRead) + number(usage.cacheWrite);
    const tier = Array.isArray(pricing.tiers)
        ? pricing.tiers
            .filter(candidate => totalInput > number(candidate.inputTokensAbove))
            .sort((a, b) => number(b.inputTokensAbove) - number(a.inputTokensAbove))[0]
        : null;
    const rates = tier || pricing;
    return (
        number(usage.input) * number(rates.input) +
        number(usage.output) * number(rates.output) +
        number(usage.cacheRead) * number(rates.cacheRead) +
        number(usage.cacheWrite) * number(rates.cacheWrite)
    ) / 1_000_000;
}

export class UsageLedger {
    constructor(filePath = process.env.ROUTER_USAGE_PATH || DEFAULT_PATH) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        this.db = new Database(filePath);
        fs.chmodSync(filePath, 0o600);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        for (const suffix of ['-wal', '-shm']) {
            try { fs.chmodSync(`${filePath}${suffix}`, 0o600); } catch {}
        }
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS usage_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                api_key_id TEXT,
                api_key_name TEXT,
                provider TEXT NOT NULL,
                account_id TEXT,
                model TEXT NOT NULL,
                inbound_api TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                estimated_cost_usd REAL NOT NULL DEFAULT 0,
                pricing_json TEXT,
                status TEXT NOT NULL DEFAULT 'success',
                error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_events(timestamp);
            CREATE INDEX IF NOT EXISTS idx_usage_key_timestamp ON usage_events(api_key_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_usage_provider_model ON usage_events(provider, model);
        `);
        this.insert = this.db.prepare(`
            INSERT INTO usage_events (
                timestamp, duration_ms, api_key_id, api_key_name, provider, account_id,
                model, inbound_api, input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, reasoning_tokens, estimated_cost_usd, pricing_json,
                status, error
            ) VALUES (
                @timestamp, @durationMs, @apiKeyId, @apiKeyName, @provider, @accountId,
                @model, @inboundApi, @input, @output, @cacheRead,
                @cacheWrite, @reasoning, @estimatedCostUsd, @pricingJson,
                @status, @error
            )
        `);
    }

    record(event) {
        const usage = event.usage || {};
        const pricing = event.pricing || {};
        const normalized = {
            timestamp: event.timestamp || new Date().toISOString(),
            durationMs: Math.max(0, Math.round(number(event.durationMs))),
            apiKeyId: event.apiKey?.id || null,
            apiKeyName: event.apiKey?.name || (event.apiKey?.legacy ? 'Legacy administrator key' : null),
            provider: event.provider || 'unknown',
            accountId: event.accountId || null,
            model: event.model || 'unknown',
            inboundApi: event.inboundApi || 'unknown',
            input: Math.max(0, Math.round(number(usage.input ?? usage.input_tokens))),
            output: Math.max(0, Math.round(number(usage.output ?? usage.output_tokens))),
            cacheRead: Math.max(0, Math.round(number(usage.cacheRead ?? usage.cache_read_input_tokens))),
            cacheWrite: Math.max(0, Math.round(number(usage.cacheWrite ?? usage.cache_creation_input_tokens))),
            reasoning: Math.max(0, Math.round(number(usage.reasoning))),
            estimatedCostUsd: number(event.estimatedCostUsd ?? calculateEstimatedCost({
                input: usage.input ?? usage.input_tokens,
                output: usage.output ?? usage.output_tokens,
                cacheRead: usage.cacheRead ?? usage.cache_read_input_tokens,
                cacheWrite: usage.cacheWrite ?? usage.cache_creation_input_tokens
            }, pricing)),
            pricingJson: JSON.stringify(pricing),
            status: event.status || 'success',
            error: event.error ? String(event.error).slice(0, 1000) : null
        };
        this.insert.run(normalized);
        return normalized;
    }

    sinceForRange(range) {
        const durations = { '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, '90d': 90 * 86400e3 };
        return durations[range] ? new Date(Date.now() - durations[range]).toISOString() : '1970-01-01T00:00:00.000Z';
    }

    summary(range = '30d') {
        const since = this.sinceForRange(range);
        const totals = this.db.prepare(`
            SELECT COUNT(*) requests,
                   COALESCE(SUM(input_tokens), 0) inputTokens,
                   COALESCE(SUM(output_tokens), 0) outputTokens,
                   COALESCE(SUM(cache_read_tokens), 0) cacheReadTokens,
                   COALESCE(SUM(cache_write_tokens), 0) cacheWriteTokens,
                   COALESCE(SUM(reasoning_tokens), 0) reasoningTokens,
                   COALESCE(SUM(estimated_cost_usd), 0) estimatedCostUsd
            FROM usage_events WHERE timestamp >= ?
        `).get(since);
        const byModel = this.db.prepare(`
            SELECT provider, model, COUNT(*) requests,
                   SUM(input_tokens) inputTokens, SUM(output_tokens) outputTokens,
                   SUM(cache_read_tokens) cacheReadTokens,
                   SUM(cache_write_tokens) cacheWriteTokens,
                   SUM(reasoning_tokens) reasoningTokens,
                   SUM(estimated_cost_usd) estimatedCostUsd
            FROM usage_events WHERE timestamp >= ?
            GROUP BY provider, model ORDER BY estimatedCostUsd DESC, requests DESC
        `).all(since);
        const byKey = this.db.prepare(`
            SELECT COALESCE(api_key_id, 'unattributed') apiKeyId,
                   COALESCE(api_key_name, 'Unattributed') apiKeyName,
                   COUNT(*) requests,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) totalTokens,
                   SUM(estimated_cost_usd) estimatedCostUsd
            FROM usage_events WHERE timestamp >= ?
            GROUP BY api_key_id, api_key_name ORDER BY estimatedCostUsd DESC, requests DESC
        `).all(since);
        const byAccount = this.db.prepare(`
            SELECT provider, COALESCE(account_id, 'Not reported') accountId,
                   COUNT(*) requests,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) totalTokens,
                   SUM(estimated_cost_usd) estimatedCostUsd
            FROM usage_events WHERE timestamp >= ?
            GROUP BY provider, account_id ORDER BY estimatedCostUsd DESC, requests DESC
        `).all(since);
        const daily = this.db.prepare(`
            SELECT substr(timestamp, 1, 10) day, COUNT(*) requests,
                   SUM(input_tokens) inputTokens, SUM(output_tokens) outputTokens,
                   SUM(estimated_cost_usd) estimatedCostUsd
            FROM usage_events WHERE timestamp >= ?
            GROUP BY day ORDER BY day ASC
        `).all(since);
        return { range, since, totals, byModel, byKey, byAccount, daily };
    }

    usageForPolicy(apiKeyId) {
        const minute = new Date(Date.now() - 60_000).toISOString();
        const day = new Date(Date.now() - 86_400_000).toISOString();
        const month = new Date();
        month.setUTCDate(1);
        month.setUTCHours(0, 0, 0, 0);
        return {
            requestsLastMinute: this.db.prepare('SELECT COUNT(*) count FROM usage_events WHERE api_key_id = ? AND timestamp >= ?').get(apiKeyId, minute).count,
            tokensLastDay: this.db.prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) total FROM usage_events WHERE api_key_id = ? AND timestamp >= ?`).get(apiKeyId, day).total,
            spendThisMonth: this.db.prepare('SELECT COALESCE(SUM(estimated_cost_usd), 0) total FROM usage_events WHERE api_key_id = ? AND timestamp >= ?').get(apiKeyId, month.toISOString()).total
        };
    }

    recent(limit = 100) {
        return this.db.prepare('SELECT * FROM usage_events ORDER BY id DESC LIMIT ?').all(Math.min(1000, Math.max(1, Number(limit) || 100)));
    }
}

export const usageLedger = new UsageLedger();

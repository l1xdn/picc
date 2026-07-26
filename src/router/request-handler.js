import crypto from 'crypto';
import { sendMessage, sendMessageStream } from '../cloudcode/index.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { routerApiKeyStore } from './api-key-store.js';
import { routerCredentialStore } from './credential-store.js';
import { piModels, providerAccountManager } from './model-registry.js';
import { usageLedger, calculateEstimatedCost } from './usage-ledger.js';
import {
    anthropicRequestToContext,
    openAIRequestToContext,
    openAIToAnthropicRequest,
    assistantToAnthropic,
    assistantToOpenAI,
    cloudAnthropicToOpenAI,
    piEventToAnthropic,
    piEventToOpenAI,
    cloudEventToOpenAI
} from './protocol.js';

function reasoningLevel(body) {
    const value = body.reasoning_effort || body.reasoning?.effort;
    if (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) return value;
    if (body.thinking?.type === 'enabled' || body.thinking?.type === 'adaptive') return 'high';
    return undefined;
}

function requestOptions(req, body) {
    const controller = new AbortController();
    const responseState = { current: null };
    req.on('close', () => {
        if (!req.complete) controller.abort();
    });
    return {
        signal: controller.signal,
        maxTokens: body.max_tokens || body.max_completion_tokens,
        temperature: body.temperature,
        reasoning: reasoningLevel(body),
        sessionId: req.headers['x-session-id'] || req.headers['x-session-affinity'],
        maxRetries: 0,
        timeoutMs: config.requestTimeoutMs || 300000,
        onResponse: response => { responseState.current = response; },
        _responseState: responseState
    };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function headerValue(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function providerFailure(error, options) {
    const response = options?._responseState?.current;
    const status = Number(error?.statusCode || error?.status || response?.status) || null;
    const message = String(error?.message || 'Provider request failed');
    const rateLimited = status === 429 || /rate.?limit|quota exhausted|usage[_ ]limit/i.test(message);
    const auth = status === 401 || status === 403 || /invalid.*(?:token|credential)|unauthori[sz]ed|forbidden/i.test(message);
    const retryable = rateLimited || auth || (status !== null && status >= 500) || (status === null && /network|fetch|timeout|socket|ECONN|aborted/i.test(message));
    const retryAfter = headerValue(response?.headers, 'retry-after');
    const seconds = Number(retryAfter);
    const resetMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
    return { status, rateLimited, auth, retryable, resetMs };
}

async function runWithProviderFailover(resolved, options, operation, canRetry = () => true) {
    let attempts = 0;
    let maxAttempts = 1;
    let lastError = null;

    while (attempts < maxAttempts) {
        const selection = await providerAccountManager.selectAccount(resolved.provider, resolved.id, {
            sessionId: options.sessionId
        });
        maxAttempts = Math.max(1, selection.accountCount || 0);
        if (!selection.account) {
            if (selection.waitMs > 0) {
                await sleep(selection.waitMs + 100);
                continue;
            }
            // Preserve ambient/env authentication for providers without stored accounts.
            if (selection.accountCount === 0 && attempts === 0) {
                options._responseState.current = null;
                return { value: await operation(null, fn => fn()), account: null };
            }
            const error = lastError || new Error(`No usable ${resolved.provider} account is currently available`);
            error.statusCode ||= 429;
            throw error;
        }

        attempts++;
        options._responseState.current = null;
        const withAccount = fn => routerCredentialStore.runWithAccount(resolved.provider, selection.account.id, fn);
        try {
            const value = await operation(selection.account, withAccount);
            providerAccountManager.notifySuccess(resolved.provider, selection.account.id, resolved.id);
            return { value, account: selection.account };
        } catch (error) {
            lastError = error;
            const failure = providerFailure(error, options);
            if (failure.rateLimited) {
                providerAccountManager.notifyRateLimit(resolved.provider, selection.account.id, resolved.id, failure.resetMs);
            } else {
                providerAccountManager.notifyFailure(resolved.provider, selection.account.id, resolved.id, { auth: failure.auth });
            }
            if (!failure.retryable || attempts >= maxAttempts || !canRetry()) throw error;
            logger.warn(`[ProviderStrategy] ${resolved.provider} account failed; trying another account (${attempts}/${maxAttempts})`);
        }
    }
    throw lastError || new Error(`No usable ${resolved.provider} account is currently available`);
}

function sse(res, eventName, data) {
    if (eventName) res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
}

function startSse(res) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
}

function keyIdentity(req) {
    return req.routerApiKey || null;
}

function providerAccountUsageId(account) {
    return account ? `${account.label || 'Provider account'} · ${account.id.slice(0, 8)}` : null;
}

function record(req, details) {
    try {
        usageLedger.record({ ...details, apiKey: keyIdentity(req) });
    } catch (error) {
        logger.warn('[UsageLedger] Failed to record request:', error.message);
    }
}

export function assertKeyPolicy(req, resolved) {
    const key = req.routerApiKey;
    if (!key || key.legacy || key.unprotected) return;
    if (!routerApiKeyStore.allows(key, resolved.requested, resolved.routerId, resolved.provider || resolved.kind)) {
        const error = new Error(`API key is not allowed to access model ${resolved.requested}`);
        error.statusCode = 403;
        throw error;
    }
    const usage = usageLedger.usageForPolicy(key.id);
    const limits = key.limits || {};
    if (limits.requestsPerMinute > 0 && usage.requestsLastMinute >= limits.requestsPerMinute) {
        const error = new Error('API key request-per-minute limit exceeded');
        error.statusCode = 429;
        throw error;
    }
    if (limits.tokensPerDay > 0 && usage.tokensLastDay >= limits.tokensPerDay) {
        const error = new Error('API key daily token limit exceeded');
        error.statusCode = 429;
        throw error;
    }
    if (limits.monthlyBudgetUsd > 0 && usage.spendThisMonth >= limits.monthlyBudgetUsd) {
        const error = new Error('API key monthly estimated-spend limit exceeded');
        error.statusCode = 429;
        throw error;
    }
}

async function ensurePiAuth(model) {
    const auth = await piModels.getAuth(model);
    if (!auth) {
        const error = new Error(`Provider ${model.provider} is not authenticated. Add an OAuth account in Accounts or an upstream key in Imported Keys.`);
        error.statusCode = 401;
        throw error;
    }
}

export async function handlePiAnthropic(req, res, resolved) {
    const started = Date.now();
    const body = { ...req.body, model: resolved.id };
    const context = anthropicRequestToContext(body);
    const options = requestOptions(req, body);

    if (!body.stream) {
        try {
            const { value: message, account } = await runWithProviderFailover(resolved, options, async (_account, withAccount) => {
                await withAccount(() => ensurePiAuth(resolved.model));
                return withAccount(() => piModels.completeSimple(resolved.model, context, options));
            });
            record(req, {
                durationMs: Date.now() - started, provider: resolved.provider, accountId: providerAccountUsageId(account),
                model: resolved.routerId, inboundApi: 'anthropic', usage: message.usage, pricing: resolved.model.cost,
                estimatedCostUsd: calculateEstimatedCost(message.usage, resolved.model.cost)
            });
            return res.json(assistantToAnthropic(message, resolved.requested));
        } catch (error) {
            record(req, { durationMs: Date.now() - started, provider: resolved.provider, model: resolved.routerId, inboundApi: 'anthropic', status: 'error', error: error.message, pricing: resolved.model.cost });
            throw error;
        }
    }

    startSse(res);
    let emitted = false;
    let finalState = null;
    try {
        const { account } = await runWithProviderFailover(resolved, options, async (_account, withAccount) => {
            const state = { id: crypto.randomBytes(12).toString('hex'), model: resolved.requested, final: null };
            await withAccount(async () => {
                await ensurePiAuth(resolved.model);
                for await (const event of piModels.streamSimple(resolved.model, context, options)) {
                    for (const outgoing of piEventToAnthropic(event, state)) {
                        emitted = true;
                        sse(res, outgoing.type, outgoing);
                    }
                }
            });
            finalState = state;
        }, () => !emitted);
        if (finalState?.final) record(req, { durationMs: Date.now() - started, provider: resolved.provider, accountId: providerAccountUsageId(account), model: resolved.routerId, inboundApi: 'anthropic', usage: finalState.final.usage, pricing: resolved.model.cost, estimatedCostUsd: calculateEstimatedCost(finalState.final.usage, resolved.model.cost) });
        res.end();
    } catch (error) {
        record(req, { durationMs: Date.now() - started, provider: resolved.provider, model: resolved.routerId, inboundApi: 'anthropic', status: 'error', error: error.message, pricing: resolved.model.cost });
        sse(res, 'error', { type: 'error', error: { type: 'api_error', message: error.message } });
        res.end();
    }
}

export async function handleOpenAI(req, res, resolved, accountManager, fallbackEnabled, cloudPricing = {}) {
    const started = Date.now();
    const body = req.body;

    if (resolved.kind === 'pi') {
        const context = openAIRequestToContext(body);
        const options = requestOptions(req, body);
        if (!body.stream) {
            try {
                const { value: message, account } = await runWithProviderFailover(resolved, options, async (_account, withAccount) => {
                    await withAccount(() => ensurePiAuth(resolved.model));
                    return withAccount(() => piModels.completeSimple(resolved.model, context, options));
                });
                record(req, { durationMs: Date.now() - started, provider: resolved.provider, accountId: providerAccountUsageId(account), model: resolved.routerId, inboundApi: 'openai', usage: message.usage, pricing: resolved.model.cost, estimatedCostUsd: calculateEstimatedCost(message.usage, resolved.model.cost) });
                return res.json(assistantToOpenAI(message, resolved.requested));
            } catch (error) {
                record(req, { durationMs: Date.now() - started, provider: resolved.provider, model: resolved.routerId, inboundApi: 'openai', status: 'error', error: error.message, pricing: resolved.model.cost });
                throw error;
            }
        }

        startSse(res);
        let emitted = false;
        let finalState = null;
        try {
            const { account } = await runWithProviderFailover(resolved, options, async (_account, withAccount) => {
                const state = { id: crypto.randomBytes(12).toString('hex'), created: Math.floor(Date.now() / 1000), model: resolved.requested, final: null };
                await withAccount(async () => {
                    await ensurePiAuth(resolved.model);
                    for await (const event of piModels.streamSimple(resolved.model, context, options)) {
                        for (const outgoing of piEventToOpenAI(event, state)) {
                            emitted = true;
                            sse(res, null, outgoing);
                        }
                    }
                });
                finalState = state;
            }, () => !emitted);
            if (finalState?.final) record(req, { durationMs: Date.now() - started, provider: resolved.provider, accountId: providerAccountUsageId(account), model: resolved.routerId, inboundApi: 'openai', usage: finalState.final.usage, pricing: resolved.model.cost, estimatedCostUsd: calculateEstimatedCost(finalState.final.usage, resolved.model.cost) });
            res.write('data: [DONE]\n\n');
            return res.end();
        } catch (error) {
            record(req, { durationMs: Date.now() - started, provider: resolved.provider, model: resolved.routerId, inboundApi: 'openai', status: 'error', error: error.message, pricing: resolved.model.cost });
            sse(res, null, { error: { message: error.message, type: 'api_error' } });
            res.write('data: [DONE]\n\n');
            return res.end();
        }
    }

    const cloudRequest = openAIToAnthropicRequest(body, resolved.id);
    if (!body.stream) {
        try {
            const message = await sendMessage(cloudRequest, accountManager, fallbackEnabled);
            record(req, { durationMs: Date.now() - started, provider: 'cloudcode', accountId: cloudRequest.__routerAccountId, model: resolved.routerId, inboundApi: 'openai', usage: message.usage, pricing: cloudPricing });
            return res.json(cloudAnthropicToOpenAI(message, resolved.requested));
        } catch (error) {
            record(req, { durationMs: Date.now() - started, provider: 'cloudcode', accountId: cloudRequest.__routerAccountId, model: resolved.routerId, inboundApi: 'openai', status: 'error', error: error.message, pricing: cloudPricing });
            throw error;
        }
    }

    startSse(res);
    const state = { id: `chatcmpl-${crypto.randomBytes(12).toString('hex')}`, created: Math.floor(Date.now() / 1000), model: resolved.requested, tools: new Map(), usage: { input: 0, output: 0, cacheRead: 0 } };
    try {
        for await (const event of sendMessageStream(cloudRequest, accountManager, fallbackEnabled)) {
            for (const outgoing of cloudEventToOpenAI(event, state)) sse(res, null, outgoing);
        }
        record(req, { durationMs: Date.now() - started, provider: 'cloudcode', accountId: cloudRequest.__routerAccountId, model: resolved.routerId, inboundApi: 'openai', usage: state.usage, pricing: cloudPricing });
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        record(req, { durationMs: Date.now() - started, provider: 'cloudcode', accountId: cloudRequest.__routerAccountId, model: resolved.routerId, inboundApi: 'openai', status: 'error', error: error.message, pricing: cloudPricing });
        sse(res, null, { error: { message: error.message, type: 'api_error' } });
        res.write('data: [DONE]\n\n');
        res.end();
    }
}

export function recordCloudAnthropic(req, request, response, resolved, started, pricing = {}, status = 'success', error = null) {
    record(req, {
        durationMs: Date.now() - started,
        provider: 'cloudcode', accountId: request.__routerAccountId, model: resolved.routerId,
        inboundApi: 'anthropic', usage: response?.usage || {}, pricing, status, error
    });
}

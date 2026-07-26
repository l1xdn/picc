#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'picc-router-'));
    process.env.ROUTER_AUTH_PATH = path.join(temp, 'auth.json');
    process.env.ROUTER_API_KEYS_PATH = path.join(temp, 'keys.json');
    process.env.ROUTER_USAGE_PATH = path.join(temp, 'usage.db');
    process.env.PI_CODING_AGENT_DIR = path.join(temp, 'pi');

    try {
        const { RouterApiKeyStore } = await import('../src/router/api-key-store.js');
        const { RouterCredentialStore } = await import('../src/router/credential-store.js');
        const { resolveModel } = await import('../src/router/model-registry.js');
        const { anthropicRequestToContext, openAIRequestToContext, assistantToOpenAI } = await import('../src/router/protocol.js');
        const { calculateEstimatedCost, UsageLedger } = await import('../src/router/usage-ledger.js');
        const {
            parseGitHubCopilotModelIds,
            parseOpenAICodexModelIds,
            unionCatalogModelIds
        } = await import('../src/router/model-availability.js');
        const { parseAnthropicQuota, parseOpenAICodexQuota, parseGitHubCopilotQuota, parseOpenRouterQuota } = await import('../src/router/quota-manager.js');
        const { importRouterToPi } = await import('../src/utils/pi-config.js');

        const keyStore = new RouterApiKeyStore(path.join(temp, 'scoped-keys.json'));
        const created = await keyStore.create({
            name: 'NVIDIA only', allowedModels: ['nvidia/*'], allowedProviders: ['nvidia'],
            limits: { requestsPerMinute: 10 }
        });
        assert(created.key.startsWith('picc_'));
        const storedText = fs.readFileSync(path.join(temp, 'scoped-keys.json'), 'utf8');
        assert(!storedText.includes(created.key), 'plaintext inbound key must not be stored');
        const authenticated = await keyStore.authenticate(created.key);
        assert(authenticated && authenticated.name === 'NVIDIA only');
        assert(keyStore.allows(authenticated, 'nvidia/test', 'nvidia/test', 'nvidia'));
        assert(!keyStore.allows(authenticated, 'openai/test', 'openai/test', 'openai'));

        const credentialStore = new RouterCredentialStore(path.join(temp, 'provider-auth.json'));
        await credentialStore.setApiKey('nvidia', 'nvapi-secret', undefined, 'NVIDIA one');
        await credentialStore.setApiKey('nvidia', 'nvapi-second', undefined, 'NVIDIA two');
        assert.strictEqual((await credentialStore.listAccounts('nvidia')).length, 2);
        const firstAccount = await credentialStore.selectAccount('nvidia');
        const secondAccount = await credentialStore.selectAccount('nvidia');
        assert.notStrictEqual(firstAccount.id, secondAccount.id, 'provider accounts should rotate');
        const scopedCredential = await credentialStore.runWithAccount('nvidia', secondAccount.id, () => credentialStore.read('nvidia'));
        assert.strictEqual(scopedCredential.key, 'nvapi-second');
        assert.strictEqual(fs.statSync(path.join(temp, 'provider-auth.json')).mode & 0o777, 0o600);
        assert.strictEqual((await credentialStore.readAccountCredential('nvidia', secondAccount.id)).key, 'nvapi-second');
        const compatibleAccount = await credentialStore.selectAccount('nvidia', 'model-b', new Map([
            [firstAccount.id, new Set(['model-a'])],
            [secondAccount.id, new Set(['model-b'])]
        ]));
        assert.strictEqual(compatibleAccount.id, secondAccount.id, 'model-aware account selection must skip incompatible credentials');
        await assert.rejects(
            credentialStore.selectAccount('nvidia', 'model-c', new Map([
                [firstAccount.id, new Set(['model-a'])],
                [secondAccount.id, new Set(['model-b'])]
            ])),
            /No enabled nvidia account supports model model-c/
        );

        assert.deepStrictEqual(parseGitHubCopilotModelIds({ data: [
            { id: 'gpt-ok', model_picker_enabled: true, policy: { state: 'enabled' }, capabilities: { supports: { tool_calls: true } } },
            { id: 'gpt-hidden', model_picker_enabled: false, policy: { state: 'enabled' } },
            { id: 'gpt-disabled', model_picker_enabled: true, policy: { state: 'disabled' } }
        ] }), ['gpt-ok']);
        assert.deepStrictEqual(parseOpenAICodexModelIds({ models: [
            { slug: 'gpt-5.4', visibility: 'list', supported_in_api: true },
            { slug: 'codex-auto-review', visibility: 'hide', supported_in_api: true },
            { slug: 'unsupported', visibility: 'list', supported_in_api: false }
        ] }), ['gpt-5.4']);
        assert.deepStrictEqual([...unionCatalogModelIds(new Map([
            ['one', new Set(['a', 'b'])],
            ['two', new Set(['b', 'c'])]
        ]))].sort(), ['a', 'b', 'c']);
        assert.strictEqual(unionCatalogModelIds(new Map([['unknown', null]])), null);

        const anthropicQuota = parseAnthropicQuota({
            five_hour: { utilization: 40, resets_at: '2030-01-01T00:00:00Z' },
            seven_day: { utilization: 20, resets_at: '2030-01-07T00:00:00Z' }
        });
        assert.strictEqual(anthropicQuota.status, 'reported');
        assert.strictEqual(anthropicQuota.remainingFraction, 0.6);
        const codexQuota = parseOpenAICodexQuota({
            email: 'user@example.test', plan_type: 'plus',
            rate_limit: {
                primary_window: { used_percent: 10, reset_at: 1893456000 },
                secondary_window: { used_percent: 50, reset_after_seconds: 3600 }
            }
        });
        assert.strictEqual(codexQuota.remainingFraction, 0.5);
        assert.strictEqual(codexQuota.tier, 'plus');
        assert.strictEqual(codexQuota.identity, 'user@example.test');
        const copilotQuota = parseGitHubCopilotQuota({
            copilot_plan: 'business', quota_reset_date: '2030-01-01T00:00:00Z',
            quota_snapshots: {
                premium_interactions: { entitlement: 100, remaining: 40, unlimited: false },
                chat: { unlimited: true }
            }
        });
        assert.strictEqual(copilotQuota.remainingFraction, 0.4);
        assert.strictEqual(copilotQuota.tier, 'business');
        assert.strictEqual(parseOpenRouterQuota({ data: { limit: 10, limit_remaining: 2 } }).remainingFraction, 0.2);
        assert.strictEqual(parseOpenRouterQuota({ data: { limit: null, limit_remaining: null } }).unlimited, true);

        assert.strictEqual(resolveModel('opus-4-6', ['claude-opus-4-6-thinking']).id, 'claude-opus-4-6-thinking');
        assert.strictEqual(resolveModel('anthropic/claude-opus-4-6', []).provider, 'anthropic');
        assert.strictEqual(resolveModel('anthropic/opus-4-6', []).id, 'claude-opus-4-6');

        const anthropicContext = anthropicRequestToContext({
            system: 'system',
            messages: [
                { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'x' } }] },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] }
            ]
        });
        assert.strictEqual(anthropicContext.systemPrompt, 'system');
        assert.strictEqual(anthropicContext.messages[0].content[0].type, 'toolCall');
        assert.strictEqual(anthropicContext.messages[1].role, 'toolResult');

        const openAIContext = openAIRequestToContext({ messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'hello' }
        ] });
        assert.strictEqual(openAIContext.systemPrompt, 'system');
        assert.strictEqual(openAIContext.messages[0].role, 'user');

        const completion = assistantToOpenAI({
            content: [{ type: 'text', text: 'hello' }], stopReason: 'stop', responseId: 'r',
            usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17, reasoning: 0 }
        }, 'test/model');
        assert.strictEqual(completion.choices[0].message.content, 'hello');
        assert.strictEqual(completion.usage.total_tokens, 17);
        assert.strictEqual(calculateEstimatedCost({ input: 1_000_000, output: 1_000_000 }, { input: 2, output: 8 }), 10);
        const ledger = new UsageLedger(path.join(temp, 'test-usage.db'));
        ledger.record({ provider: 'nvidia', accountId: 'NVIDIA one', model: 'nvidia/test', inboundApi: 'openai', apiKey: authenticated, usage: { input: 1_000_000, output: 1_000_000 }, pricing: { input: 2, output: 8 } });
        const summary = ledger.summary('all');
        assert.strictEqual(summary.totals.requests, 1);
        assert.strictEqual(summary.totals.estimatedCostUsd, 10);
        assert.strictEqual(summary.byKey[0].apiKeyName, 'NVIDIA only');
        assert.strictEqual(summary.byAccount[0].accountId, 'NVIDIA one');

        fs.mkdirSync(path.join(temp, 'pi'), { recursive: true });
        fs.writeFileSync(path.join(temp, 'pi', 'models.json'), JSON.stringify({ providers: { existing: { baseUrl: 'http://example.test', api: 'openai-completions', apiKey: 'existing', models: [{ id: 'keep-me' }] } } }));
        const piResult = await importRouterToPi({
            baseUrl: 'http://localhost:8080', apiKey: created.key, setDefault: true,
            models: [{ id: 'nvidia/test', name: 'Test', provider: 'nvidia', reasoning: false, input: ['text'], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
        });
        assert.strictEqual(piResult.modelCount, 1);
        const piModels = JSON.parse(fs.readFileSync(path.join(temp, 'pi', 'models.json'), 'utf8'));
        assert.strictEqual(piModels.providers['picc-router'].baseUrl, 'http://localhost:8080/v1');
        assert.strictEqual(piModels.providers['picc-router'].models[0].id, 'nvidia/test');
        assert.strictEqual(piModels.providers.existing.models[0].id, 'keep-me', 'Pi import must preserve unrelated providers');

        console.log('✓ Router core tests passed');
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch(error => {
    console.error('✗ Router core tests failed:', error);
    process.exit(1);
});

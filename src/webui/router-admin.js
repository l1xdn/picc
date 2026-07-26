import { getProviderStatuses, piModels } from '../router/model-registry.js';
import { routerCredentialStore } from '../router/credential-store.js';
import { routerApiKeyStore } from '../router/api-key-store.js';
import { startOAuth, getOAuthSession, submitOAuthInput, cancelOAuth } from '../router/oauth-manager.js';
import { usageLedger } from '../router/usage-ledger.js';
import { getUnifiedCatalog } from '../router/catalog.js';
import { getProviderQuotas } from '../router/quota-manager.js';
import { importRouterToPi } from '../utils/pi-config.js';
import { DEFAULT_PORT } from '../constants.js';
import { logger } from '../utils/logger.js';

function errorResponse(res, error, fallback = 500) {
    const status = error.statusCode || (error.message?.includes('not found') ? 404 : fallback);
    return res.status(status).json({ status: 'error', error: error.message });
}

export function mountRouterAdmin(app, accountManager) {
    app.get('/api/router/providers', async (_req, res) => {
        try {
            res.json({ status: 'ok', providers: await getProviderStatuses() });
        } catch (error) { errorResponse(res, error); }
    });

    app.get('/api/router/quotas', async (req, res) => {
        try {
            const providers = await getProviderStatuses();
            const quotas = await getProviderQuotas(providers, {
                credentialStore: routerCredentialStore,
                models: piModels,
                force: req.query.refresh === 'true'
            });
            res.json({ status: 'ok', providers: quotas });
        } catch (error) { errorResponse(res, error); }
    });

    app.put('/api/router/providers/:provider/credential', async (req, res) => {
        try {
            const provider = piModels.getProvider(req.params.provider);
            if (!provider) return res.status(404).json({ status: 'error', error: 'Provider not found' });
            if (!provider.auth.apiKey) return res.status(400).json({ status: 'error', error: 'Provider does not support API-key authentication' });
            const env = req.body.env && typeof req.body.env === 'object' ? req.body.env : undefined;
            const account = await routerCredentialStore.setApiKey(provider.id, req.body.key, env, req.body.label);
            logger.info(`[Router] Added API-key account for ${provider.id}`);
            res.json({ status: 'ok', provider: provider.id, account });
        } catch (error) { errorResponse(res, error, 400); }
    });

    app.delete('/api/router/providers/:provider/credential', async (req, res) => {
        try {
            await routerCredentialStore.delete(req.params.provider);
            logger.info(`[Router] Removed all credentials for ${req.params.provider}`);
            res.json({ status: 'ok' });
        } catch (error) { errorResponse(res, error); }
    });

    app.delete('/api/router/providers/:provider/accounts/:accountId', async (req, res) => {
        try {
            await routerCredentialStore.deleteAccount(req.params.provider, req.params.accountId);
            res.json({ status: 'ok' });
        } catch (error) { errorResponse(res, error); }
    });

    app.patch('/api/router/providers/:provider/accounts/:accountId', async (req, res) => {
        try {
            const account = await routerCredentialStore.setAccountEnabled(
                req.params.provider,
                req.params.accountId,
                req.body.enabled
            );
            res.json({ status: 'ok', account });
        } catch (error) { errorResponse(res, error, 400); }
    });

    app.post('/api/router/providers/:provider/oauth', (req, res) => {
        try { res.json({ status: 'ok', session: startOAuth(req.params.provider) }); }
        catch (error) { errorResponse(res, error, 400); }
    });

    app.get('/api/router/oauth/:id', (req, res) => {
        const session = getOAuthSession(req.params.id);
        if (!session) return res.status(404).json({ status: 'error', error: 'Authentication session not found' });
        res.json({ status: 'ok', session });
    });

    app.post('/api/router/oauth/:id/input', (req, res) => {
        try { res.json({ status: 'ok', session: submitOAuthInput(req.params.id, req.body.value) }); }
        catch (error) { errorResponse(res, error, 400); }
    });

    app.delete('/api/router/oauth/:id', (req, res) => {
        cancelOAuth(req.params.id);
        res.json({ status: 'ok' });
    });

    app.get('/api/router/models', async (req, res) => {
        try {
            const models = await getUnifiedCatalog(accountManager, { includeUnavailable: req.query.all === 'true' });
            res.json({ status: 'ok', models });
        } catch (error) { errorResponse(res, error); }
    });

    app.get('/api/router/keys', async (_req, res) => {
        try { res.json({ status: 'ok', keys: await routerApiKeyStore.list() }); }
        catch (error) { errorResponse(res, error); }
    });

    app.post('/api/router/keys', async (req, res) => {
        try {
            const created = await routerApiKeyStore.create(req.body || {});
            logger.info(`[Router] Created inbound API key: ${created.record.name}`);
            res.status(201).json({ status: 'ok', ...created, note: 'Copy this key now. It cannot be shown again.' });
        } catch (error) { errorResponse(res, error, 400); }
    });

    app.patch('/api/router/keys/:id', async (req, res) => {
        try { res.json({ status: 'ok', key: await routerApiKeyStore.update(req.params.id, req.body || {}) }); }
        catch (error) { errorResponse(res, error, 400); }
    });

    app.delete('/api/router/keys/:id', async (req, res) => {
        try {
            await routerApiKeyStore.remove(req.params.id);
            res.json({ status: 'ok' });
        } catch (error) { errorResponse(res, error); }
    });

    app.get('/api/router/expenses', (req, res) => {
        try { res.json({ status: 'ok', ...usageLedger.summary(req.query.range || '30d') }); }
        catch (error) { errorResponse(res, error); }
    });

    app.get('/api/router/expenses/recent', (req, res) => {
        try { res.json({ status: 'ok', events: usageLedger.recent(req.query.limit) }); }
        catch (error) { errorResponse(res, error); }
    });

    app.post('/api/router/pi/import', async (req, res) => {
        try {
            const models = await getUnifiedCatalog(accountManager, { includeUnavailable: false });
            if (!models.length) return res.status(400).json({ status: 'error', error: 'No authenticated models are currently available' });
            const created = await routerApiKeyStore.create({
                name: req.body.name || 'Pi local agent',
                allowedModels: req.body.allowedModels?.length ? req.body.allowedModels : ['*'],
                allowedProviders: req.body.allowedProviders || [],
                limits: req.body.limits || {}
            });
            const port = process.env.PORT || DEFAULT_PORT;
            const baseUrl = req.body.baseUrl || `http://localhost:${port}`;
            const result = await importRouterToPi({
                baseUrl,
                apiKey: created.key,
                models,
                setDefault: req.body.setDefault !== false
            });
            logger.info(`[Router] Imported ${result.modelCount} models into Pi at ${result.modelsPath}`);
            res.json({ status: 'ok', result, apiKey: created.record });
        } catch (error) { errorResponse(res, error, 400); }
    });
}

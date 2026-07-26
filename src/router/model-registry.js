import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { config } from '../config.js';
import { routerCredentialStore } from './credential-store.js';
import {
    getProviderAccountModelAvailability,
    unionCatalogModelIds
} from './model-availability.js';

export const piModels = builtinModels({ credentials: routerCredentialStore });

const cleanModelId = value => String(value || '').trim().replace(/\s*\[1m\]\s*$/i, '');

export function toRouterModelId(model) {
    return `${model.provider}/${model.id}`;
}

export function getPiCatalog() {
    return piModels.getModels().map(model => ({
        id: toRouterModelId(model),
        upstreamId: model.id,
        name: model.name,
        provider: model.provider,
        api: model.api,
        reasoning: model.reasoning,
        input: model.input,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        cost: model.cost
    }));
}

export async function getAvailablePiCatalog(providerIds, { force = false } = {}) {
    const providers = new Set(providerIds);
    const availability = new Map(await Promise.all([...providers].map(async providerId => {
        const accounts = await getProviderAccountModelAvailability(providerId, {
            credentialStore: routerCredentialStore,
            force
        });
        return [providerId, unionCatalogModelIds(accounts)];
    })));
    return getPiCatalog().filter(model => {
        if (!providers.has(model.provider)) return false;
        const supported = availability.get(model.provider);
        return supported === null || supported === undefined || supported.has(model.upstreamId);
    });
}

export async function selectProviderAccount(providerId, modelId) {
    const availability = await getProviderAccountModelAvailability(providerId, {
        credentialStore: routerCredentialStore
    });
    return routerCredentialStore.selectAccount(providerId, modelId, availability);
}

export async function getProviderStatuses() {
    const [stored, providerAccounts] = await Promise.all([
        routerCredentialStore.list(),
        routerCredentialStore.listAccounts()
    ]);
    return Promise.all(piModels.getProviders().map(async provider => {
        const models = provider.getModels();
        let configured = !!stored[provider.id];
        let source = configured ? (stored[provider.id].type === 'oauth' ? 'OAuth' : 'API key') : null;
        let error = null;
        if (!configured && models[0]) {
            try {
                const auth = await piModels.getAuth(models[0]);
                configured = !!auth;
                source = auth?.source || null;
            } catch (authError) {
                error = authError.message;
            }
        }
        return {
            id: provider.id,
            name: provider.name,
            configured,
            source,
            credentialType: stored[provider.id]?.type || null,
            accountCount: providerAccounts[provider.id]?.length || (configured ? 1 : 0),
            accounts: providerAccounts[provider.id] || [],
            supportsApiKey: !!provider.auth.apiKey,
            supportsOAuth: !!provider.auth.oauth,
            modelCount: models.length,
            quota: { status: 'not_reported', remaining: null },
            error
        };
    }));
}

function mappedModel(requested) {
    const mapping = config.modelMapping?.[requested];
    return mapping?.mapping || requested;
}

function cloudCandidates(value) {
    const candidates = [value];
    const canonical = /^(opus|sonnet|haiku)-/i.test(value) ? `claude-${value}` : value;
    if (canonical !== value) candidates.push(canonical);
    if (/^claude-(opus|sonnet|haiku)-/i.test(canonical) && !canonical.endsWith('-thinking')) {
        candidates.push(`${canonical}-thinking`);
    }
    return [...new Set(candidates)];
}

/** Resolve an inbound identifier to either Cloud Code or a pi provider model. */
export function resolveModel(requestedModel, cloudModelIds = []) {
    const original = cleanModelId(requestedModel);
    const requested = cleanModelId(mappedModel(original));
    const cloudSet = new Set(cloudModelIds);

    if (requested.startsWith('cloudcode/')) {
        const id = requested.slice('cloudcode/'.length);
        for (const candidate of cloudCandidates(id)) {
            if (!cloudSet.size || cloudSet.has(candidate)) return { kind: 'cloudcode', id: candidate, routerId: `cloudcode/${candidate}`, requested: original };
        }
    }

    const slash = requested.indexOf('/');
    if (slash > 0) {
        const provider = requested.slice(0, slash);
        const rawId = requested.slice(slash + 1);
        const ids = provider === 'anthropic' && /^(opus|sonnet|haiku)-/i.test(rawId)
            ? [`claude-${rawId}`, rawId]
            : [rawId];
        const model = ids.map(id => piModels.getModel(provider, id)).find(Boolean);
        if (model) return { kind: 'pi', id: model.id, routerId: toRouterModelId(model), provider, model, requested: original };
    }

    for (const candidate of cloudCandidates(requested)) {
        if (cloudSet.has(candidate)) return { kind: 'cloudcode', id: candidate, routerId: `cloudcode/${candidate}`, provider: 'cloudcode', requested: original };
    }

    // Preserve old Cloud Code behavior when model discovery is temporarily unavailable.
    const inferredCloud = cloudCandidates(requested).find(id => /^(claude|gemini)-/i.test(id));
    if (!cloudSet.size && inferredCloud) {
        return { kind: 'cloudcode', id: inferredCloud, routerId: `cloudcode/${inferredCloud}`, provider: 'cloudcode', requested: original };
    }

    const matches = piModels.getModels().filter(model => model.id === requested);
    if (matches.length === 1) {
        const model = matches[0];
        return { kind: 'pi', id: model.id, routerId: toRouterModelId(model), provider: model.provider, model, requested: original };
    }

    return null;
}

export function publicModel(model, available = true) {
    return {
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: model.provider,
        name: model.name,
        provider: model.provider,
        api: model.api,
        context_window: model.contextWindow,
        max_tokens: model.maxTokens,
        reasoning: model.reasoning,
        input: model.input,
        pricing: model.cost,
        available
    };
}

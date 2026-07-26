import { listModels as listCloudModels } from '../cloudcode/index.js';
import { getAvailablePiCatalog, getProviderStatuses, piModels, publicModel } from './model-registry.js';

export function pricingForCloudModel(modelId) {
    const base = modelId.replace(/-thinking$/i, '');
    const preferredProvider = base.startsWith('claude-') ? 'anthropic' : base.startsWith('gemini-') ? 'google' : null;
    const model = preferredProvider
        ? piModels.getModel(preferredProvider, base) || piModels.getModels(preferredProvider).find(item => base.startsWith(item.id) || item.id.startsWith(base))
        : null;
    return model?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export async function getCloudCatalog(accountManager) {
    try {
        const { account } = accountManager.selectAccount();
        if (!account) return [];
        const token = await accountManager.getTokenForAccount(account);
        const response = await listCloudModels(token);
        return (response.data || []).map(model => ({
            id: model.id,
            name: model.description || model.id,
            provider: 'cloudcode',
            api: 'anthropic-messages',
            reasoning: /thinking|gemini-[3-9]/i.test(model.id),
            input: ['text', 'image'],
            contextWindow: 1000000,
            maxTokens: 16384,
            cost: pricingForCloudModel(model.id),
            available: true
        }));
    } catch {
        return [];
    }
}

export async function getUnifiedCatalog(accountManager, { includeUnavailable = false } = {}) {
    const [cloud, statuses] = await Promise.all([getCloudCatalog(accountManager), getProviderStatuses()]);
    const configured = new Set(statuses.filter(status => status.configured).map(status => status.id));
    const pi = includeUnavailable
        ? piModels.getModels().map(model => ({
            id: `${model.provider}/${model.id}`,
            upstreamId: model.id,
            name: model.name,
            provider: model.provider,
            api: model.api,
            reasoning: model.reasoning,
            input: model.input,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            cost: model.cost,
            available: configured.has(model.provider)
        }))
        : (await getAvailablePiCatalog(configured)).map(model => ({ ...model, available: true }));
    return [...cloud, ...pi];
}

export function asOpenAIModel(model) {
    if (model.provider === 'cloudcode') {
        return {
            id: model.id, object: 'model', created: 0, owned_by: 'cloudcode', name: model.name,
            provider: model.provider, api: model.api, context_window: model.contextWindow,
            max_tokens: model.maxTokens, reasoning: model.reasoning, input: model.input,
            pricing: model.cost, available: model.available
        };
    }
    const source = piModels.getModel(model.provider, model.upstreamId);
    return source ? publicModel({ ...source, id: model.id }, model.available) : model;
}

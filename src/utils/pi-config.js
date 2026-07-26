import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export function getPiAgentDir() {
    return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
}

export function getPiModelsPath() {
    return path.join(getPiAgentDir(), 'models.json');
}

async function readJson(filePath, fallback = {}) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
        throw error;
    }
}

async function atomicWrite(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
}

export async function importRouterToPi({ baseUrl, apiKey, models, setDefault = true }) {
    const modelsPath = getPiModelsPath();
    const config = await readJson(modelsPath, { providers: {} });
    config.providers ||= {};
    config.providers['picc-router'] = {
        baseUrl: `${baseUrl.replace(/\/$/, '')}/v1`,
        api: 'openai-completions',
        apiKey,
        compat: {
            supportsDeveloperRole: true,
            supportsReasoningEffort: true,
            supportsUsageInStreaming: true
        },
        models: models.map(model => ({
            id: model.id,
            name: `${model.name || model.id} · ${model.provider || 'Cloud Code'}`,
            reasoning: !!model.reasoning,
            input: model.input?.includes('image') ? ['text', 'image'] : ['text'],
            contextWindow: model.contextWindow || model.context_window || 128000,
            maxTokens: model.maxTokens || model.max_tokens || 16384,
            cost: model.cost || model.pricing || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }))
    };
    await atomicWrite(modelsPath, config);

    let settingsPath = null;
    if (setDefault && models.length) {
        settingsPath = path.join(getPiAgentDir(), 'settings.json');
        const settings = await readJson(settingsPath, {});
        settings.defaultProvider = 'picc-router';
        settings.defaultModel = models[0].id;
        await atomicWrite(settingsPath, settings);
    }

    return { modelsPath, settingsPath, modelCount: models.length, provider: 'picc-router' };
}

import crypto from 'crypto';
import { piModels } from './model-registry.js';
import { routerCredentialStore } from './credential-store.js';

const sessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000;

function publicSession(session) {
    return {
        id: session.id,
        provider: session.provider,
        status: session.status,
        event: session.event || null,
        prompt: session.prompt ? {
            type: session.prompt.type,
            message: session.prompt.message,
            placeholder: session.prompt.placeholder,
            options: session.prompt.options
        } : null,
        error: session.error || null,
        createdAt: session.createdAt
    };
}

function waitForInput(session, prompt) {
    session.prompt = prompt;
    session.status = 'waiting_input';
    return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('Authentication cancelled'));
        if (prompt.signal?.aborted || session.controller.signal.aborted) return abort();
        prompt.signal?.addEventListener('abort', abort, { once: true });
        session.controller.signal.addEventListener('abort', abort, { once: true });
        session.resolveInput = value => {
            prompt.signal?.removeEventListener('abort', abort);
            session.controller.signal.removeEventListener('abort', abort);
            session.prompt = null;
            session.resolveInput = null;
            session.status = 'running';
            resolve(value);
        };
    });
}

export function startOAuth(providerId) {
    const provider = piModels.getProvider(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    if (!provider.auth.oauth) throw new Error(`${provider.name} does not support OAuth`);

    const session = {
        id: crypto.randomUUID(),
        provider: providerId,
        status: 'running',
        event: null,
        prompt: null,
        error: null,
        createdAt: new Date().toISOString(),
        controller: new AbortController(),
        resolveInput: null
    };
    sessions.set(session.id, session);

    provider.auth.oauth.login({
        signal: session.controller.signal,
        prompt: prompt => waitForInput(session, prompt),
        notify: event => {
            session.event = event;
            if (event.type === 'auth_url' || event.type === 'device_code') session.status = 'waiting_external';
        }
    }).then(async credential => {
        await routerCredentialStore.addCredential(providerId, credential);
        session.prompt = null;
        session.status = 'complete';
    }).catch(error => {
        session.prompt = null;
        session.status = session.controller.signal.aborted ? 'cancelled' : 'error';
        session.error = error.message;
    });

    return publicSession(session);
}

export function getOAuthSession(id) {
    const session = sessions.get(id);
    if (!session) return null;
    if (Date.now() - Date.parse(session.createdAt) > SESSION_TTL_MS) {
        session.controller.abort();
        sessions.delete(id);
        return null;
    }
    return publicSession(session);
}

export function submitOAuthInput(id, value) {
    const session = sessions.get(id);
    if (!session) throw new Error('Authentication session not found');
    if (!session.resolveInput) throw new Error('Authentication is not waiting for input');
    session.resolveInput(String(value || ''));
    return publicSession(session);
}

export function cancelOAuth(id) {
    const session = sessions.get(id);
    if (!session) return;
    session.controller.abort();
    session.status = 'cancelled';
}

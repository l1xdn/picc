window.Components = window.Components || {};

window.Components.routerManager = (mode = 'router') => ({
    mode,
    providers: [],
    models: [],
    keys: [],
    loading: false,
    providerSearch: '',
    modelSearch: '',
    selectedProvider: null,
    apiKeyInput: '',
    apiKeyLabel: '',
    apiEnvInput: '{}',
    newKey: { name: 'Local client', scope: 'all', models: '', providers: '' },
    revealedKey: '',
    oauthSession: null,
    oauthTimer: null,

    get filteredProviders() {
        const query = this.providerSearch.toLowerCase();
        return this.providers.filter(provider => !query || `${provider.name} ${provider.id}`.toLowerCase().includes(query));
    },
    get filteredModels() {
        const query = this.modelSearch.toLowerCase();
        return this.models.filter(model => !query || `${model.id} ${model.name} ${model.provider}`.toLowerCase().includes(query)).slice(0, 250);
    },
    get apiKeyProviders() {
        return this.filteredProviders.filter(provider => provider.supportsApiKey);
    },

    apiKeyAccounts(provider) {
        return (provider.accounts || []).filter(account => account.type === 'api_key');
    },

    init() { this.refresh(); },
    destroy() { if (this.oauthTimer) clearTimeout(this.oauthTimer); },

    async request(url, options = {}) {
        const password = Alpine.store('global').webuiPassword;
        const result = await window.utils.request(url, options, password);
        if (result.newPassword) Alpine.store('global').webuiPassword = result.newPassword;
        const data = await result.response.json();
        if (!result.response.ok || data.status === 'error') throw new Error(data.error || `HTTP ${result.response.status}`);
        return data;
    },

    async refresh() {
        this.loading = true;
        try {
            const [providers, models, keys] = await Promise.all([
                this.request('/api/router/providers'),
                this.request('/api/router/models?all=true'),
                this.request('/api/router/keys')
            ]);
            this.providers = providers.providers;
            this.models = models.models;
            this.keys = keys.keys;
            this.fetchQuotas();
        } catch (error) {
            Alpine.store('global').showToast(error.message, 'error');
        } finally { this.loading = false; }
    },

    async fetchQuotas(force = false) {
        try {
            const data = await this.request(`/api/router/quotas${force ? '?refresh=true' : ''}`);
            for (const providerQuota of data.providers || []) {
                const provider = this.providers.find(item => item.id === providerQuota.id);
                if (!provider) continue;
                for (const accountQuota of providerQuota.accounts || []) {
                    const account = (provider.accounts || []).find(item => item.id === accountQuota.id);
                    if (account) account.quota = accountQuota.quota;
                }
            }
        } catch (error) {
            console.debug('Provider quotas unavailable:', error.message);
        }
    },

    quotaLabel(account) {
        const quota = account.quota;
        if (!quota) return 'checking quota…';
        if (quota.status === 'not_reported') return 'quota not reported';
        if (quota.status === 'unavailable') return 'quota unavailable';
        if (quota.unlimited) return 'quota unlimited';
        if (Number.isFinite(quota.remainingFraction)) return `${Math.round(quota.remainingFraction * 100)}% remaining`;
        const balance = quota.windows?.find(item => item.remaining !== undefined)?.remaining;
        return balance !== undefined ? `${balance} remaining` : 'quota reported';
    },

    configureProvider(provider) {
        this.selectedProvider = provider;
        this.apiKeyInput = '';
        this.apiKeyLabel = '';
        this.apiEnvInput = '{}';
        document.getElementById('provider_credential_modal')?.showModal();
    },

    async saveProviderKey() {
        try {
            let env = {};
            try { env = JSON.parse(this.apiEnvInput || '{}'); } catch { throw new Error('Provider environment must be valid JSON'); }
            await this.request(`/api/router/providers/${encodeURIComponent(this.selectedProvider.id)}/credential`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: this.apiKeyInput, env, label: this.apiKeyLabel || undefined })
            });
            document.getElementById('provider_credential_modal')?.close();
            Alpine.store('global').showToast(`${this.selectedProvider.name} connected`, 'success');
            await this.refresh();
        } catch (error) { Alpine.store('global').showToast(error.message, 'error'); }
    },

    async removeCredential(provider) {
        if (!confirm(`Remove every stored credential for ${provider.name}?`)) return;
        try {
            await this.request(`/api/router/providers/${encodeURIComponent(provider.id)}/credential`, { method: 'DELETE' });
            await this.refresh();
        } catch (error) { Alpine.store('global').showToast(error.message, 'error'); }
    },

    async removeProviderAccount(provider, account) {
        if (!confirm(`Remove imported key “${account.label}” from ${provider.name}?`)) return;
        try {
            await this.request(`/api/router/providers/${encodeURIComponent(provider.id)}/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
            Alpine.store('global').showToast('Imported key removed', 'success');
            await this.refresh();
        } catch (error) { Alpine.store('global').showToast(error.message, 'error'); }
    },

    async startOAuth(provider) {
        try {
            const data = await this.request(`/api/router/providers/${encodeURIComponent(provider.id)}/oauth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            this.oauthSession = data.session;
            document.getElementById('router_oauth_modal')?.showModal();
            this.pollOAuth();
        } catch (error) { Alpine.store('global').showToast(error.message, 'error'); }
    },

    async pollOAuth() {
        if (!this.oauthSession) return;
        try {
            const data = await this.request(`/api/router/oauth/${this.oauthSession.id}`);
            const previousEvent = this.oauthSession.event;
            this.oauthSession = data.session;
            if (data.session.event?.type === 'auth_url' && data.session.event.url !== previousEvent?.url) window.open(data.session.event.url, '_blank', 'noopener');
            if (data.session.status === 'complete') {
                document.getElementById('router_oauth_modal')?.close();
                Alpine.store('global').showToast('OAuth account connected', 'success');
                this.oauthSession = null;
                return this.refresh();
            }
            if (['error', 'cancelled'].includes(data.session.status)) return;
            this.oauthTimer = setTimeout(() => this.pollOAuth(), 1000);
        } catch (error) { this.oauthSession.error = error.message; }
    },

    async submitOAuthPrompt() {
        const input = this.oauthSession?.prompt?.type === 'select'
            ? (document.getElementById('router_oauth_select')?.value || '')
            : (document.getElementById('router_oauth_input')?.value || '');
        try {
            await this.request(`/api/router/oauth/${this.oauthSession.id}/input`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: input })
            });
            this.pollOAuth();
        } catch (error) { Alpine.store('global').showToast(error.message, 'error'); }
    },

    async cancelOAuth() {
        if (this.oauthTimer) clearTimeout(this.oauthTimer);
        if (this.oauthSession) await this.request(`/api/router/oauth/${this.oauthSession.id}`, { method: 'DELETE' }).catch(() => {});
        this.oauthSession = null;
        document.getElementById('router_oauth_modal')?.close();
    },

    openCreateKey() {
        this.revealedKey = '';
        document.getElementById('create_router_key_modal')?.showModal();
    },

    async createKey() {
        try {
            const allowedModels = this.newKey.scope === 'models'
                ? this.newKey.models.split(',').map(value => value.trim()).filter(Boolean)
                : ['*'];
            const allowedProviders = this.newKey.scope === 'providers'
                ? this.newKey.providers.split(',').map(value => value.trim()).filter(Boolean)
                : [];
            const data = await this.request('/api/router/keys', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                    name: this.newKey.name || 'Local client',
                    allowedModels,
                    allowedProviders
                })
            });
            this.revealedKey = data.key;
            this.keys.unshift(data.record);
        } catch (error) { Alpine.store('global').showToast(error.message, 'error'); }
    },

    async copyRevealedKey() {
        await navigator.clipboard.writeText(this.revealedKey);
        Alpine.store('global').showToast('API key copied', 'success');
    },

    async toggleKey(key) {
        try {
            key.enabled = !key.enabled;
            await this.request(`/api/router/keys/${key.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: key.enabled }) });
        } catch (error) { key.enabled = !key.enabled; Alpine.store('global').showToast(error.message, 'error'); }
    },

    async revokeKey(key) {
        if (!confirm(`Permanently revoke “${key.name}”?`)) return;
        try {
            await this.request(`/api/router/keys/${key.id}`, { method: 'DELETE' });
            this.keys = this.keys.filter(item => item.id !== key.id);
        } catch (error) { Alpine.store('global').showToast(error.message, 'error'); }
    },

    async importToPi() {
        try {
            const data = await this.request('/api/router/pi/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setDefault: true }) });
            Alpine.store('global').showToast(`Imported ${data.result.modelCount} models to Pi`, 'success');
            await this.refresh();
        } catch (error) { Alpine.store('global').showToast(error.message, 'error'); }
    }
});

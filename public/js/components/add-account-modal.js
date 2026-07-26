/**
 * Add Account Modal Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.addAccountModal = () => ({
    manualMode: false,
    authUrl: '',
    authState: '',
    callbackInput: '',
    submitting: false,
    selectedMethod: '',
    providerStatuses: [],
    oauthSession: null,
    oauthTimer: null,
    oauthInput: '',
    openProviderHandler: null,

    get accountProviders() {
        const preferred = [
            { id: 'openai-codex', name: 'ChatGPT / OpenAI' },
            { id: 'anthropic', name: 'Anthropic' },
            { id: 'github-copilot', name: 'GitHub Copilot' }
        ];
        // Render the choices immediately; enrich/validate them when the provider
        // catalog response arrives so the modal never flashes as Google-only.
        return preferred.map(fallback => {
            const provider = this.providerStatuses.find(item => item.id === fallback.id);
            return provider ? { ...provider, name: fallback.name } : { ...fallback, supportsOAuth: true };
        }).filter(provider => provider.supportsOAuth);
    },

    init() {
        this.loadProviders();
        this.openProviderHandler = event => {
            const provider = this.accountProviders.find(item => item.id === event.detail?.providerId);
            if (provider) this.startProviderOAuth(provider);
        };
        window.addEventListener('select-account-provider', this.openProviderHandler);
    },

    destroy() {
        if (this.oauthTimer) clearTimeout(this.oauthTimer);
        if (this.openProviderHandler) window.removeEventListener('select-account-provider', this.openProviderHandler);
    },

    async routerRequest(url, options = {}) {
        const store = Alpine.store('global');
        const result = await window.utils.request(url, options, store.webuiPassword);
        if (result.newPassword) store.webuiPassword = result.newPassword;
        const data = await result.response.json();
        if (!result.response.ok || data.status === 'error') throw new Error(data.error || `HTTP ${result.response.status}`);
        return data;
    },

    async loadProviders() {
        try {
            const data = await this.routerRequest('/api/router/providers');
            this.providerStatuses = data.providers || [];
        } catch (error) {
            Alpine.store('global').showToast(`Could not load account providers: ${error.message}`, 'error');
        }
    },

    selectGoogle() {
        this.selectedMethod = 'google';
    },

    async startProviderOAuth(provider) {
        try {
            this.selectedMethod = 'oauth';
            this.oauthInput = '';
            const data = await this.routerRequest(`/api/router/providers/${encodeURIComponent(provider.id)}/oauth`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            });
            this.oauthSession = data.session;
            this.pollProviderOAuth();
        } catch (error) {
            this.selectedMethod = '';
            Alpine.store('global').showToast(error.message, 'error');
        }
    },

    async pollProviderOAuth() {
        if (!this.oauthSession) return;
        try {
            const data = await this.routerRequest(`/api/router/oauth/${this.oauthSession.id}`);
            const previousUrl = this.oauthSession.event?.url;
            this.oauthSession = data.session;
            if (data.session.event?.type === 'auth_url' && data.session.event.url !== previousUrl) {
                window.open(data.session.event.url, '_blank', 'noopener');
            }
            if (data.session.status === 'complete') {
                Alpine.store('global').showToast(`${this.providerName(data.session.provider)} account connected`, 'success');
                window.dispatchEvent(new CustomEvent('provider-accounts-changed'));
                this.oauthSession = null;
                this.selectedMethod = '';
                document.getElementById('add_account_modal')?.close();
                await this.loadProviders();
                return;
            }
            if (['error', 'cancelled'].includes(data.session.status)) return;
            this.oauthTimer = setTimeout(() => this.pollProviderOAuth(), 1000);
        } catch (error) {
            if (this.oauthSession) this.oauthSession.error = error.message;
        }
    },

    async submitProviderOAuthInput() {
        if (!this.oauthSession?.prompt) return;
        if (this.oauthTimer) clearTimeout(this.oauthTimer);
        const value = this.oauthSession.prompt.type === 'select'
            ? (document.getElementById('account_oauth_select')?.value || '')
            : this.oauthInput;
        try {
            await this.routerRequest(`/api/router/oauth/${this.oauthSession.id}/input`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value })
            });
            this.oauthInput = '';
            this.pollProviderOAuth();
        } catch (error) {
            Alpine.store('global').showToast(error.message, 'error');
        }
    },

    async cancelProviderOAuth() {
        if (this.oauthTimer) clearTimeout(this.oauthTimer);
        if (this.oauthSession) {
            await this.routerRequest(`/api/router/oauth/${this.oauthSession.id}`, { method: 'DELETE' }).catch(() => {});
        }
        this.oauthSession = null;
        this.selectedMethod = '';
    },

    providerName(id) {
        const names = {
            'openai-codex': 'ChatGPT / OpenAI',
            anthropic: 'Anthropic',
            'github-copilot': 'GitHub Copilot'
        };
        return names[id] || this.providerStatuses.find(provider => provider.id === id)?.name || id;
    },

    /** Reset all state to initial values. */
    resetState() {
        if (this.oauthSession) this.cancelProviderOAuth();
        this.manualMode = false;
        this.authUrl = '';
        this.authState = '';
        this.callbackInput = '';
        this.submitting = false;
        this.selectedMethod = '';
        this.oauthInput = '';
        const details = document.querySelectorAll('#add_account_modal details[open]');
        details.forEach(d => d.removeAttribute('open'));
    },

    async copyLink() {
        if (!this.authUrl) return;
        await navigator.clipboard.writeText(this.authUrl);
        Alpine.store('global').showToast(Alpine.store('global').t('linkCopied'), 'success');
    },

    async initManualAuth(event) {
        if (event.target.open && !this.authUrl) {
            try {
                const password = Alpine.store('global').webuiPassword;
                const {
                    response,
                    newPassword
                } = await window.utils.request('/api/auth/url', {}, password);
                if (newPassword) Alpine.store('global').webuiPassword = newPassword;
                const data = await response.json();
                if (data.status === 'ok') {
                    this.authUrl = data.url;
                    this.authState = data.state;
                }
            } catch (e) {
                Alpine.store('global').showToast(e.message, 'error');
            }
        }
    },

    async completeManualAuth() {
        if (!this.callbackInput || !this.authState) return;
        this.submitting = true;
        try {
            const store = Alpine.store('global');
            const {
                response,
                newPassword
            } = await window.utils.request('/api/auth/complete', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    callbackInput: this.callbackInput,
                    state: this.authState
                })
            }, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('accountAddedSuccess'), 'success');
                Alpine.store('data').fetchData();
                document.getElementById('add_account_modal').close();
                this.resetState();
            } else {
                store.showToast(data.error || store.t('authFailed'), 'error');
            }
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        } finally {
            this.submitting = false;
        }
    }
});

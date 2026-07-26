window.Components = window.Components || {};

window.Components.expenses = () => ({
    range: '30d',
    loading: false,
    totals: {},
    byModel: [],
    byKey: [],
    byAccount: [],
    daily: [],

    init() { this.fetchExpenses(); },
    money(value) { return `$${Number(value || 0).toFixed(Number(value || 0) < 0.01 ? 6 : 2)}`; },
    compact(value) { return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0)); },

    async fetchExpenses() {
        this.loading = true;
        try {
            const password = Alpine.store('global').webuiPassword;
            const { response, newPassword } = await window.utils.request(`/api/router/expenses?range=${this.range}`, {}, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
            this.totals = data.totals || {};
            this.byModel = data.byModel || [];
            this.byKey = data.byKey || [];
            this.byAccount = data.byAccount || [];
            this.daily = data.daily || [];
        } catch (error) { Alpine.store('global').showToast(error.message, 'error'); }
        finally { this.loading = false; }
    }
});

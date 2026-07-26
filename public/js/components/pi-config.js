window.Components = window.Components || {};

window.Components.piConfig = () => ({
    loading: false,
    result: null,
    async importToPi() {
        this.loading = true;
        try {
            const password = Alpine.store('global').webuiPassword;
            const { response, newPassword } = await window.utils.request('/api/router/pi/import', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setDefault: true })
            }, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
            this.result = data.result;
            Alpine.store('global').showToast(`Imported ${data.result.modelCount} models to Pi`, 'success');
        } catch (error) {
            Alpine.store('global').showToast(error.message, 'error');
        } finally { this.loading = false; }
    }
});

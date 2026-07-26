/**
 * Logs Viewer Component
 *
 * One shared fetch-based SSE stream is used for the entire tab. Fetch allows
 * authentication in a header so the Web UI password never appears in a URL.
 * The previous implementation created duplicate streams whenever Alpine
 * initialized the cached Logs view, retaining components and duplicate buffers.
 */
window.Components = window.Components || {};

window.RouterLogStream = window.RouterLogStream || (() => {
    let controller = null;
    let reconnectTimer = null;
    let stopped = false;
    const subscribers = new Set();

    const clearReconnect = () => {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
    };

    const close = () => {
        clearReconnect();
        controller?.abort();
        controller = null;
    };

    const dispatchBlock = block => {
        const data = block.split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
        if (!data) return;
        try {
            const log = JSON.parse(data);
            for (const subscriber of subscribers) subscriber(log);
        } catch (error) {
            window.UILogger?.debug('Log parse error:', error.message);
        }
    };

    const connect = async () => {
        if (stopped || document.hidden || controller || subscribers.size === 0) return;
        const current = new AbortController();
        controller = current;
        try {
            const store = Alpine.store('global');
            const result = await window.utils.request('/api/logs/stream?history=true', {
                signal: current.signal,
                headers: { Accept: 'text/event-stream' }
            }, store?.webuiPassword || '');
            if (result.newPassword && store) store.webuiPassword = result.newPassword;
            if (!result.response.ok || !result.response.body) throw new Error(`HTTP ${result.response.status}`);

            const reader = result.response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (!current.signal.aborted) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
                let boundary;
                while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                    dispatchBlock(buffer.slice(0, boundary));
                    buffer = buffer.slice(boundary + 2);
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError') window.UILogger?.debug('Log stream disconnected:', error.message);
        } finally {
            if (controller === current) controller = null;
            if (!stopped && !document.hidden && subscribers.size) {
                reconnectTimer = setTimeout(connect, 3000);
            }
        }
    };

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) close();
        else connect();
    });
    window.addEventListener('beforeunload', close, { once: true });

    return {
        subscribe(callback) {
            subscribers.add(callback);
            stopped = false;
            connect();
            return () => {
                subscribers.delete(callback);
                if (!subscribers.size) close();
            };
        },
        stop() {
            stopped = true;
            close();
        }
    };
})();

window.Components.logsViewer = () => ({
    logs: [],
    isAutoScroll: true,
    searchQuery: '',
    unsubscribeLogs: null,
    filters: { INFO: true, WARN: true, ERROR: true, SUCCESS: true, DEBUG: false },

    get filteredLogs() {
        const query = this.searchQuery.trim();
        let matcher = () => true;
        if (query) {
            try {
                const regex = new RegExp(query, 'i');
                matcher = message => regex.test(message);
            } catch {
                const lower = query.toLowerCase();
                matcher = message => message.toLowerCase().includes(lower);
            }
        }
        return this.logs.filter(log => this.filters[log.level] && matcher(log.message));
    },

    init() {
        this.unsubscribeLogs?.();
        this.unsubscribeLogs = window.RouterLogStream.subscribe(log => {
            this.logs.push(log);
            const configured = Number(Alpine.store('settings')?.logLimit) || 1000;
            const limit = Math.min(2000, Math.max(100, configured));
            if (this.logs.length > limit) this.logs.splice(0, this.logs.length - limit);
            if (this.isAutoScroll) this.$nextTick(() => this.scrollToBottom());
        });

        const settings = Alpine.store('settings');
        if (settings) {
            this.filters.DEBUG = !!settings.debugLogging;
            this.$watch('$store.settings.debugLogging', value => { this.filters.DEBUG = !!value; });
        }
        this.$watch('isAutoScroll', value => { if (value) this.scrollToBottom(); });
        this.$watch('searchQuery', () => { if (this.isAutoScroll) this.$nextTick(() => this.scrollToBottom()); });
        this.$watch('filters', () => { if (this.isAutoScroll) this.$nextTick(() => this.scrollToBottom()); });
    },

    destroy() {
        this.unsubscribeLogs?.();
        this.unsubscribeLogs = null;
        this.logs.length = 0;
    },

    scrollToBottom() {
        const container = document.getElementById('logs-container');
        if (container) container.scrollTop = container.scrollHeight;
    },

    clearLogs() {
        this.logs.splice(0, this.logs.length);
    },

    exportLogs() {
        if (!this.logs.length) return;
        const shouldRedact = Alpine.store('settings')?.redactMode && window.Redact;
        const text = this.logs.map(log => {
            const message = shouldRedact ? window.Redact.logMessage(log.message) : log.message;
            return `[${new Date(log.timestamp).toISOString()}] [${log.level}] ${message}`;
        }).join('\n');
        const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `proxy-logs-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }
});

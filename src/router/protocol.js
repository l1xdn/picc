import crypto from 'crypto';

const now = () => Date.now();
const emptyUsage = () => ({
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
});

function textFromSystem(system) {
    if (typeof system === 'string') return system;
    if (!Array.isArray(system)) return undefined;
    return system.filter(block => block?.type === 'text').map(block => block.text).join('\n');
}

function anthContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.flatMap(block => {
        if (block.type === 'text') return [{ type: 'text', text: block.text || '' }];
        if (block.type === 'image' && block.source?.type === 'base64') {
            return [{ type: 'image', data: block.source.data, mimeType: block.source.media_type }];
        }
        return [];
    });
}

function toolResultContent(content) {
    const converted = anthContent(content);
    if (typeof converted === 'string') return [{ type: 'text', text: converted }];
    return converted;
}

function anthropicMessages(messages = []) {
    const output = [];
    for (const message of messages) {
        if (message.role === 'assistant') {
            const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content || []);
            output.push({
                role: 'assistant',
                content: blocks.flatMap(block => {
                    if (block.type === 'text') return [{ type: 'text', text: block.text || '' }];
                    if (block.type === 'thinking') return [{ type: 'thinking', thinking: block.thinking || '', thinkingSignature: block.signature }];
                    if (block.type === 'tool_use') return [{ type: 'toolCall', id: block.id, name: block.name, arguments: block.input || {}, thoughtSignature: block.thoughtSignature }];
                    return [];
                }),
                api: 'anthropic-messages', provider: 'router-history', model: 'history', usage: emptyUsage(), stopReason: 'stop', timestamp: now()
            });
            continue;
        }

        const blocks = Array.isArray(message.content) ? message.content : null;
        if (!blocks) {
            output.push({ role: 'user', content: String(message.content || ''), timestamp: now() });
            continue;
        }
        let pending = [];
        const flushUser = () => {
            if (pending.length) output.push({ role: 'user', content: pending, timestamp: now() });
            pending = [];
        };
        for (const block of blocks) {
            if (block.type === 'tool_result') {
                flushUser();
                output.push({
                    role: 'toolResult', toolCallId: block.tool_use_id, toolName: block.name || 'tool',
                    content: toolResultContent(block.content), isError: !!block.is_error, timestamp: now()
                });
            } else if (block.type === 'text') {
                pending.push({ type: 'text', text: block.text || '' });
            } else if (block.type === 'image' && block.source?.type === 'base64') {
                pending.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type });
            }
        }
        flushUser();
    }
    return output;
}

export function anthropicRequestToContext(body) {
    return {
        systemPrompt: textFromSystem(body.system),
        messages: anthropicMessages(body.messages),
        tools: Array.isArray(body.tools) ? body.tools.map(tool => ({
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || { type: 'object', properties: {} }
        })) : undefined
    };
}

function openAIContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const result = [];
    for (const block of content) {
        if (block.type === 'text' || block.type === 'input_text') result.push({ type: 'text', text: block.text || '' });
        if (block.type === 'image_url' && typeof block.image_url?.url === 'string') {
            const match = block.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) result.push({ type: 'image', mimeType: match[1], data: match[2] });
        }
    }
    return result;
}

export function openAIRequestToContext(body) {
    const messages = [];
    const system = [];
    const toolNames = new Map();
    for (const raw of body.messages || []) {
        if (raw.role === 'system' || raw.role === 'developer') {
            const content = openAIContent(raw.content);
            system.push(typeof content === 'string' ? content : content.filter(x => x.type === 'text').map(x => x.text).join('\n'));
        } else if (raw.role === 'user') {
            messages.push({ role: 'user', content: openAIContent(raw.content), timestamp: now() });
        } else if (raw.role === 'assistant') {
            const content = [];
            if (raw.content) content.push({ type: 'text', text: typeof raw.content === 'string' ? raw.content : '' });
            for (const call of raw.tool_calls || []) {
                let args = {};
                try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
                toolNames.set(call.id, call.function?.name || 'tool');
                content.push({ type: 'toolCall', id: call.id, name: call.function?.name || 'tool', arguments: args });
            }
            messages.push({ role: 'assistant', content, api: 'openai-completions', provider: 'router-history', model: 'history', usage: emptyUsage(), stopReason: raw.tool_calls?.length ? 'toolUse' : 'stop', timestamp: now() });
        } else if (raw.role === 'tool') {
            messages.push({
                role: 'toolResult', toolCallId: raw.tool_call_id, toolName: raw.name || toolNames.get(raw.tool_call_id) || 'tool',
                content: [{ type: 'text', text: typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content) }],
                isError: false, timestamp: now()
            });
        }
    }
    return {
        systemPrompt: system.length ? system.join('\n\n') : undefined,
        messages,
        tools: Array.isArray(body.tools) ? body.tools.map(tool => ({
            name: tool.function?.name,
            description: tool.function?.description || '',
            parameters: tool.function?.parameters || { type: 'object', properties: {} }
        })).filter(tool => tool.name) : undefined
    };
}

export function openAIToAnthropicRequest(body, model) {
    const system = [];
    const messages = [];
    for (const raw of body.messages || []) {
        if (raw.role === 'system' || raw.role === 'developer') {
            system.push(typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content));
        } else if (raw.role === 'user') {
            messages.push({ role: 'user', content: typeof raw.content === 'string' ? raw.content : (raw.content || []).map(block => block.type === 'text' ? { type: 'text', text: block.text } : block) });
        } else if (raw.role === 'assistant') {
            const content = [];
            if (raw.content) content.push({ type: 'text', text: raw.content });
            for (const call of raw.tool_calls || []) {
                let input = {};
                try { input = JSON.parse(call.function?.arguments || '{}'); } catch {}
                content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
            }
            messages.push({ role: 'assistant', content });
        } else if (raw.role === 'tool') {
            messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: raw.tool_call_id, content: raw.content }] });
        }
    }
    return {
        model,
        messages,
        system: system.length ? system.join('\n\n') : undefined,
        max_tokens: body.max_completion_tokens || body.max_tokens || 4096,
        temperature: body.temperature,
        top_p: body.top_p,
        stream: !!body.stream,
        tools: body.tools?.map(tool => ({ name: tool.function?.name, description: tool.function?.description, input_schema: tool.function?.parameters })),
        tool_choice: body.tool_choice === 'auto' || !body.tool_choice ? body.tool_choice : undefined
    };
}

function stopToAnthropic(reason) {
    return reason === 'length' ? 'max_tokens' : reason === 'toolUse' ? 'tool_use' : 'end_turn';
}

function stopToOpenAI(reason) {
    return reason === 'length' || reason === 'max_tokens' ? 'length' : reason === 'toolUse' || reason === 'tool_use' ? 'tool_calls' : 'stop';
}

export function assistantToAnthropic(message, requestedModel) {
    return {
        id: `msg_${crypto.randomBytes(12).toString('hex')}`,
        type: 'message', role: 'assistant', model: requestedModel,
        content: message.content.map(block => {
            if (block.type === 'text') return { type: 'text', text: block.text };
            if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking, ...(block.thinkingSignature ? { signature: block.thinkingSignature } : {}) };
            return { type: 'tool_use', id: block.id, name: block.name, input: block.arguments };
        }),
        stop_reason: stopToAnthropic(message.stopReason), stop_sequence: null,
        usage: {
            input_tokens: message.usage.input,
            output_tokens: message.usage.output,
            cache_read_input_tokens: message.usage.cacheRead,
            cache_creation_input_tokens: message.usage.cacheWrite
        }
    };
}

export function assistantToOpenAI(message, requestedModel) {
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
    const toolCalls = message.content.filter(block => block.type === 'toolCall').map(block => ({
        id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) }
    }));
    return {
        id: message.responseId || `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
        object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: requestedModel,
        choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: stopToOpenAI(message.stopReason) }],
        usage: {
            prompt_tokens: message.usage.input + message.usage.cacheRead,
            completion_tokens: message.usage.output,
            total_tokens: message.usage.totalTokens,
            prompt_tokens_details: { cached_tokens: message.usage.cacheRead },
            completion_tokens_details: { reasoning_tokens: message.usage.reasoning || 0 }
        }
    };
}

export function cloudAnthropicToOpenAI(message, requestedModel) {
    const content = message.content || [];
    const text = content.filter(block => block.type === 'text').map(block => block.text).join('');
    const toolCalls = content.filter(block => block.type === 'tool_use').map(block => ({
        id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
    }));
    const input = message.usage?.input_tokens || 0;
    const output = message.usage?.output_tokens || 0;
    const cached = message.usage?.cache_read_input_tokens || 0;
    return {
        id: message.id?.replace(/^msg_/, 'chatcmpl-') || `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
        object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: requestedModel,
        choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: stopToOpenAI(message.stop_reason) }],
        usage: { prompt_tokens: input + cached, completion_tokens: output, total_tokens: input + cached + output, prompt_tokens_details: { cached_tokens: cached } }
    };
}

export function piEventToAnthropic(event, state) {
    if (event.type === 'start') return [{ type: 'message_start', message: { id: `msg_${state.id}`, type: 'message', role: 'assistant', content: [], model: state.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: event.partial.usage.input, output_tokens: 0, cache_read_input_tokens: event.partial.usage.cacheRead, cache_creation_input_tokens: event.partial.usage.cacheWrite } } }];
    if (event.type === 'text_start') return [{ type: 'content_block_start', index: event.contentIndex, content_block: { type: 'text', text: '' } }];
    if (event.type === 'text_delta') return [{ type: 'content_block_delta', index: event.contentIndex, delta: { type: 'text_delta', text: event.delta } }];
    if (event.type === 'text_end') return [{ type: 'content_block_stop', index: event.contentIndex }];
    if (event.type === 'thinking_start') return [{ type: 'content_block_start', index: event.contentIndex, content_block: { type: 'thinking', thinking: '' } }];
    if (event.type === 'thinking_delta') return [{ type: 'content_block_delta', index: event.contentIndex, delta: { type: 'thinking_delta', thinking: event.delta } }];
    if (event.type === 'thinking_end') {
        const block = event.partial.content[event.contentIndex];
        return [...(block?.thinkingSignature ? [{ type: 'content_block_delta', index: event.contentIndex, delta: { type: 'signature_delta', signature: block.thinkingSignature } }] : []), { type: 'content_block_stop', index: event.contentIndex }];
    }
    if (event.type === 'toolcall_start') {
        const block = event.partial.content[event.contentIndex];
        return [{ type: 'content_block_start', index: event.contentIndex, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }];
    }
    if (event.type === 'toolcall_delta') return [{ type: 'content_block_delta', index: event.contentIndex, delta: { type: 'input_json_delta', partial_json: event.delta } }];
    if (event.type === 'toolcall_end') return [{ type: 'content_block_stop', index: event.contentIndex }];
    if (event.type === 'done') {
        state.final = event.message;
        return [{ type: 'message_delta', delta: { stop_reason: stopToAnthropic(event.reason), stop_sequence: null }, usage: { output_tokens: event.message.usage.output, cache_read_input_tokens: event.message.usage.cacheRead, cache_creation_input_tokens: event.message.usage.cacheWrite } }, { type: 'message_stop' }];
    }
    throw new Error(event.error?.errorMessage || 'Provider stream failed');
}

export function piEventToOpenAI(event, state) {
    const base = { id: `chatcmpl-${state.id}`, object: 'chat.completion.chunk', created: state.created, model: state.model };
    if (event.type === 'start') return [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }];
    if (event.type === 'text_delta') return [{ ...base, choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] }];
    if (event.type === 'thinking_delta') return [{ ...base, choices: [{ index: 0, delta: { reasoning_content: event.delta }, finish_reason: null }] }];
    if (event.type === 'toolcall_start') {
        const block = event.partial.content[event.contentIndex];
        return [{ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: event.contentIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] }, finish_reason: null }] }];
    }
    if (event.type === 'toolcall_delta') return [{ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: event.contentIndex, function: { arguments: event.delta } }] }, finish_reason: null }] }];
    if (event.type === 'done') {
        state.final = event.message;
        return [{ ...base, choices: [{ index: 0, delta: {}, finish_reason: stopToOpenAI(event.reason) }], usage: { prompt_tokens: event.message.usage.input + event.message.usage.cacheRead, completion_tokens: event.message.usage.output, total_tokens: event.message.usage.totalTokens, prompt_tokens_details: { cached_tokens: event.message.usage.cacheRead }, completion_tokens_details: { reasoning_tokens: event.message.usage.reasoning || 0 } } }];
    }
    if (event.type === 'error') throw new Error(event.error?.errorMessage || 'Provider stream failed');
    return [];
}

export function cloudEventToOpenAI(event, state) {
    const base = { id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model };
    if (event.type === 'message_start') {
        state.usage.input = event.message.usage?.input_tokens || 0;
        state.usage.cacheRead = event.message.usage?.cache_read_input_tokens || 0;
        return [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }];
    }
    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        state.tools.set(event.index, event.content_block);
        return [{ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: event.index, id: event.content_block.id, type: 'function', function: { name: event.content_block.name, arguments: '' } }] }, finish_reason: null }] }];
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') return [{ ...base, choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }] }];
    if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') return [{ ...base, choices: [{ index: 0, delta: { reasoning_content: event.delta.thinking }, finish_reason: null }] }];
    if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') return [{ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: event.index, function: { arguments: event.delta.partial_json } }] }, finish_reason: null }] }];
    if (event.type === 'message_delta') {
        state.usage.output = event.usage?.output_tokens || 0;
        return [{ ...base, choices: [{ index: 0, delta: {}, finish_reason: stopToOpenAI(event.delta?.stop_reason) }], usage: { prompt_tokens: state.usage.input + state.usage.cacheRead, completion_tokens: state.usage.output, total_tokens: state.usage.input + state.usage.cacheRead + state.usage.output, prompt_tokens_details: { cached_tokens: state.usage.cacheRead } } }];
    }
    return [];
}

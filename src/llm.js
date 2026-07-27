/**
 * Huckleberry · LLM layer
 * Pure ES module — no chrome.* APIs — so it can be unit tested with plain node.
 *
 * Supported providers:
 *   openai     → any OpenAI-compatible /chat/completions endpoint
 *                (OpenAI, OpenRouter, Groq, Together, LM Studio, 9Router, …)
 *   gemini     → Google Gemini API (current REST surface, header auth)
 *   anthropic  → Anthropic Messages API
 *   ollama     → local Ollama
 */

export const PROVIDER_DEFAULTS = {
	openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
	gemini: {
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
		model: 'gemini-2.5-flash'
	},
	anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
	ollama: { baseUrl: 'http://localhost:11434', model: 'llama3.1' }
};

const DEFAULT_TIMEOUT = 60_000;

class LlmError extends Error {
	constructor(message, { status, retryable = false } = {}) {
		super(message);
		this.name = 'LlmError';
		this.status = status;
		this.retryable = retryable;
	}
}

const base = cfg =>
	(cfg.baseUrl || PROVIDER_DEFAULTS[cfg.provider]?.baseUrl || '').replace(/\/+$/, '');

const model = cfg => cfg.model || PROVIDER_DEFAULTS[cfg.provider]?.model || '';

const isRetryable = status => status === 408 || status === 429 || status >= 500;

async function request(url, init, timeout = DEFAULT_TIMEOUT) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeout);
	try {
		const res = await fetch(url, { ...init, signal: ctrl.signal });
		const text = await res.text();
		let json = null;
		try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
		if (!res.ok) {
			const detail =
				json?.error?.message || json?.message || text.slice(0, 300) || res.statusText;
			throw new LlmError(`HTTP ${res.status} — ${detail}`, {
				status: res.status,
				retryable: isRetryable(res.status)
			});
		}
		return json ?? {};
	} catch (e) {
		if (e.name === 'AbortError') throw new LlmError('Request timed out', { retryable: true });
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

const splitSystem = messages => ({
	system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
	rest: messages.filter(m => m.role !== 'system')
});

/* ─────────────────────────────── providers ─────────────────────────────── */

export const providers = {
	/* OpenAI-compatible ---------------------------------------------------- */
	async openai(cfg, messages) {
		if (!cfg.apiKey) throw new LlmError('Missing API key');
		const j = await request(`${base(cfg)}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${cfg.apiKey}`
			},
			body: JSON.stringify({
				model: model(cfg),
				temperature: cfg.temperature ?? 0.2,
				messages
			})
		});
		const out = j.choices?.[0]?.message?.content;
		if (!out) throw new LlmError('Empty completion from provider');
		return out.trim();
	},

	/* Google Gemini -------------------------------------------------------- */
	// Current REST surface:
	//   POST {base}/models/{model}:generateContent
	//   header: x-goog-api-key: <key>          (the modern auth style)
	async gemini(cfg, messages) {
		if (!cfg.apiKey) throw new LlmError('Missing API key');
		const { system, rest } = splitSystem(messages);
		const body = {
			contents: rest.map(m => ({
				role: m.role === 'assistant' ? 'model' : 'user',
				parts: [{ text: m.content }]
			})),
			generationConfig: {
				temperature: cfg.temperature ?? 0.2,
				maxOutputTokens: cfg.maxOutputTokens ?? 2048
			}
		};
		if (system) body.systemInstruction = { parts: [{ text: system }] };

		const j = await request(
			`${base(cfg)}/models/${encodeURIComponent(model(cfg))}:generateContent`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-goog-api-key': cfg.apiKey
				},
				body: JSON.stringify(body)
			}
		);

		if (j.promptFeedback?.blockReason)
			throw new LlmError(`Blocked by Gemini safety: ${j.promptFeedback.blockReason}`);

		const cand = j.candidates?.[0];
		const text = (cand?.content?.parts || [])
			.filter(p => typeof p.text === 'string' && p.thought !== true)
			.map(p => p.text)
			.join('')
			.trim();

		if (!text) {
			const why = cand?.finishReason || j.promptFeedback?.blockReason || 'no candidates';
			throw new LlmError(`Gemini returned no text (finishReason: ${why})`);
		}
		return text;
	},

	/* Anthropic ------------------------------------------------------------ */
	async anthropic(cfg, messages) {
		if (!cfg.apiKey) throw new LlmError('Missing API key');
		const { system, rest } = splitSystem(messages);
		const j = await request(`${base(cfg)}/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': cfg.apiKey,
				'anthropic-version': '2023-06-01',
				'anthropic-dangerous-direct-browser-access': 'true'
			},
			body: JSON.stringify({
				model: model(cfg),
				max_tokens: cfg.maxOutputTokens ?? 2048,
				temperature: cfg.temperature ?? 0.2,
				system: system || undefined,
				messages: rest
			})
		});
		const out = (j.content || []).map(c => c.text || '').join('').trim();
		if (!out) throw new LlmError('Empty completion from Anthropic');
		return out;
	},

	/* Ollama (local) ------------------------------------------------------- */
	async ollama(cfg, messages) {
		const j = await request(`${base(cfg)}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: model(cfg),
				messages,
				stream: false,
				options: { temperature: cfg.temperature ?? 0.2 }
			})
		});
		const out = j.message?.content;
		if (!out) throw new LlmError('Empty completion from Ollama');
		return out.trim();
	}
};

/* ───────────────────────────── model listing ───────────────────────────── */

export async function listModels(cfg) {
	const b = base(cfg);
	if (cfg.provider === 'gemini') {
		const j = await request(`${b}/models?pageSize=200`, {
			headers: { 'x-goog-api-key': cfg.apiKey }
		});
		return (j.models || [])
			.filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
			.map(m => String(m.name).replace(/^models\//, ''))
			.sort();
	}
	if (cfg.provider === 'ollama') {
		const j = await request(`${b}/api/tags`, {});
		return (j.models || []).map(m => m.name).sort();
	}
	if (cfg.provider === 'openai') {
		const j = await request(`${b}/models`, {
			headers: { Authorization: `Bearer ${cfg.apiKey}` }
		});
		return (j.data || []).map(m => m.id).sort();
	}
	return [];
}

/* ──────────────────────────── prompt building ──────────────────────────── */

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function buildQuestionPrompt(q) {
	if (q.choices?.length) {
		const list = q.choices.map((c, i) => `${LETTERS[i]}) ${c}`).join('\n');
		return (
			`Question:\n${q.text}\n\nChoices:\n${list}\n\n` +
			`Reply with the letter followed by the choice text, verbatim. Nothing else.`
		);
	}
	return `Question:\n${q.text}\n\nReply with only the answer, no preamble.`;
}

/* ─────────────────────────────── public API ────────────────────────────── */

/**
 * Ask the configured model. Retries transient failures with backoff.
 * @param {object} cfg  { provider, apiKey, baseUrl, model, temperature, systemPrompt, retries }
 * @param {object} q    { text, choices?: string[] }
 */
export async function ask(cfg, q) {
	const fn = providers[cfg.provider] || providers.openai;
	const messages = [
		{ role: 'system', content: cfg.systemPrompt || 'You are a precise answering engine.' },
		{ role: 'user', content: buildQuestionPrompt(q) }
	];
	const attempts = Math.max(1, cfg.retries ?? 2);
	let last;
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn(cfg, messages);
		} catch (e) {
			last = e;
			if (!e.retryable || i === attempts - 1) break;
			await new Promise(r => setTimeout(r, 600 * 2 ** i));
		}
	}
	throw last;
}

export { LlmError };

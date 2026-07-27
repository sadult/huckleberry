/**
 * Huckleberry · background service worker
 * Orchestration + state + Telegram bridge.
 */
import { ask, listModels, PROVIDER_DEFAULTS } from './llm.js';

const DEFAULTS = {
	provider: 'gemini',
	apiKey: '',
	baseUrl: '',
	model: 'gemini-2.5-flash',
	temperature: 0.2,
	retries: 2,
	systemPrompt:
		'You are Huckleberry, a precise answering engine. Answer exactly and briefly. ' +
		'If choices are given, reply with the letter and the choice text, verbatim, nothing else.',
	autoSubmit: false,
	delayMs: 700,
	credentials: [], // [{host, user, pass, userSel, passSel, submitSel}]
	telegram: { enabled: false, token: '', chatId: '', offset: 0 },
	stats: { answered: 0, runs: 0 },
	log: []
};

const store = {
	async get() {
		const { state } = await chrome.storage.local.get('state');
		return { ...DEFAULTS, ...(state || {}) };
	},
	async set(patch) {
		const state = { ...(await store.get()), ...patch };
		await chrome.storage.local.set({ state });
		return state;
	}
};

const emit = msg => chrome.runtime.sendMessage(msg).catch(() => {});

async function log(level, msg) {
	const s = await store.get();
	const entry = { t: Date.now(), level, msg: String(msg).slice(0, 400) };
	await store.set({ log: [entry, ...s.log].slice(0, 200) });
	emit({ type: 'log', entry });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ───────────────────────────── tab plumbing ───────────────────────────── */

async function activeTab() {
	const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
	if (!tab) throw new Error('No active tab');
	if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || ''))
		throw new Error('Browser-internal pages cannot be automated');
	return tab;
}

async function toContent(tabId, msg) {
	try {
		return await chrome.tabs.sendMessage(tabId, msg);
	} catch {
		await chrome.scripting.executeScript({
			target: { tabId, allFrames: true },
			files: ['src/content.js']
		});
		return chrome.tabs.sendMessage(tabId, msg);
	}
}

/* ─────────────────────────── the autopilot run ────────────────────────── */

let running = false;

async function runAutopilot({ tabId } = {}) {
	if (running) return { ok: false, error: 'A run is already in progress' };
	running = true;
	let answered = 0;
	let total = 0;
	try {
		const cfg = await store.get();
		const tab = tabId ? await chrome.tabs.get(tabId) : await activeTab();
		const host = new URL(tab.url).hostname;
		await log('info', `▶ Run started on ${host}`);

		// 1 · sign in when we have credentials for this host
		const cred = cfg.credentials.find(c => c.host && host.includes(c.host));
		if (cred) {
			const r = await toContent(tab.id, { type: 'login', cred });
			if (r?.filled) {
				await log('ok', '🔑 Credentials submitted');
				await sleep(2500);
			}
		}

		// 2 · detect questions
		const { questions = [] } = (await toContent(tab.id, { type: 'scan' })) || {};
		total = questions.length;
		await log('info', `🔎 ${total} question(s) detected`);
		if (!total) return { ok: true, answered: 0, total: 0 };

		// 3 · answer them one at a time
		for (const q of questions) {
			if (!running) { await log('warn', '⏹ Stopped by user'); break; }
			emit({ type: 'progress', q: q.text, done: answered, total });
			let answer;
			try {
				answer = await ask(cfg, q);
			} catch (e) {
				await log('err', `❌ model: ${e.message}`);
				continue;
			}
			const res = await toContent(tab.id, { type: 'fill', id: q.id, answer });
			if (res?.ok) {
				answered++;
				await log('ok', `✅ ${q.text.slice(0, 55)} → ${String(res.choice || answer).slice(0, 55)}`);
			} else {
				await log('warn', `⚠️ could not place answer for: ${q.text.slice(0, 55)}`);
			}
			await sleep(cfg.delayMs);
		}

		if (cfg.autoSubmit && running) await toContent(tab.id, { type: 'submit' });

		const s = await store.get();
		await store.set({
			stats: { answered: s.stats.answered + answered, runs: s.stats.runs + 1 }
		});
		await log('ok', `🏁 Finished — ${answered}/${total}`);
		await notifyTelegram(`🫐 Huckleberry: ${answered}/${total} answered on ${host}`);
		return { ok: true, answered, total };
	} catch (e) {
		await log('err', e.message);
		return { ok: false, error: e.message, answered, total };
	} finally {
		running = false;
		emit({ type: 'done' });
	}
}

/* ────────────────────────── Telegram bridge ─────────────────────────── */

function tgApi(token, method, body) {
	const url = 'https://api.telegram.org/bot' + token + '/' + method;
	return fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	}).then(r => r.json());
}

async function notifyTelegram(text) {
	const { telegram } = await store.get();
	if (!telegram.enabled || !telegram.token || !telegram.chatId) return;
	await tgApi(telegram.token, 'sendMessage', { chat_id: telegram.chatId, text });
}

const HELP =
	'🫐 Huckleberry\n' +
	'/run — autopilot on the active tab\n' +
	'/stop — abort the current run\n' +
	'/status — state, stats, model\n' +
	'/ask <question> — one-off question\n' +
	'/open <url> — open a tab\n' +
	'/help — this list';

async function pollTelegram() {
	let cfg = await store.get();
	if (!cfg.telegram.enabled || !cfg.telegram.token) return;
	const token = cfg.telegram.token;

	let data;
	try {
		data = await tgApi(token, 'getUpdates', { offset: cfg.telegram.offset, timeout: 45 });
	} catch { return; }
	if (!data?.ok || !Array.isArray(data.result)) return;

	for (const u of data.result) {
		cfg = await store.get();
		const chat = String(u.message?.chat?.id || '');
		await store.set({
			telegram: {
				...cfg.telegram,
				offset: u.update_id + 1,
				chatId: cfg.telegram.chatId || chat // bind the first sender
			}
		});
		if (cfg.telegram.chatId && chat && chat !== cfg.telegram.chatId) continue;

		const text = (u.message?.text || '').trim();
		const reply = t => tgApi(token, 'sendMessage', { chat_id: chat, text: t });

		if (/^\/run/.test(text)) {
			await reply('🫐 Running…');
			const r = await runAutopilot();
			await reply(r.ok ? `✅ ${r.answered}/${r.total} answered` : `❌ ${r.error}`);
		} else if (/^\/stop/.test(text)) {
			running = false;
			await reply('⏹ Stopping…');
		} else if (/^\/status/.test(text)) {
			const s = await store.get();
			await reply(
				`🫐 Huckleberry\nRunning: ${running}\nRuns: ${s.stats.runs}\n` +
				`Answered: ${s.stats.answered}\nModel: ${s.provider}/${s.model}`
			);
		} else if (/^\/ask\s+/.test(text)) {
			try { await reply(await ask(await store.get(), { text: text.replace(/^\/ask\s+/, '') })); }
			catch (e) { await reply('❌ ' + e.message); }
		} else if (/^\/open\s+/.test(text)) {
			try {
				await chrome.tabs.create({ url: text.replace(/^\/open\s+/, '') });
				await reply('🌐 Opened');
			} catch (e) { await reply('❌ ' + e.message); }
		} else if (/^\/(help|start)/.test(text)) {
			await reply(HELP);
		}
	}
}

chrome.alarms.create('tg-poll', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'tg-poll') pollTelegram(); });

/* ──────────────────────────────── wiring ────────────────────────────── */

chrome.runtime.onInstalled.addListener(async () => {
	await store.set({});
	chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	(async () => {
		try {
			switch (msg.type) {
				case 'getState':
					return sendResponse({ ...(await store.get()), providerDefaults: PROVIDER_DEFAULTS, running });
				case 'setState':
					return sendResponse(await store.set(msg.patch));
				case 'run':
					return sendResponse(await runAutopilot(msg));
				case 'stop':
					running = false;
					return sendResponse({ ok: true });
				case 'scanOnly': {
					const tab = await activeTab();
					return sendResponse(await toContent(tab.id, { type: 'scan' }));
				}
				case 'testLLM': {
					const cfg = await store.get();
					const text = await ask(
						{ ...cfg, systemPrompt: 'Reply with exactly one word.' },
						{ text: 'Say: pong' }
					);
					return sendResponse({ ok: true, text });
				}
				case 'listModels':
					return sendResponse({ ok: true, models: await listModels(await store.get()) });
				case 'testTelegram': {
					const { telegram } = await store.get();
					if (!telegram.token) throw new Error('No bot token');
					const me = await tgApi(telegram.token, 'getMe', {});
					if (!me.ok) throw new Error(me.description || 'getMe failed');
					if (telegram.chatId) await notifyTelegram('🫐 Huckleberry connected.');
					return sendResponse({
						ok: true,
						bot: me.result.username,
						note: telegram.chatId ? '' : 'Send /start to the bot to bind this chat.'
					});
				}
				case 'clearLog':
					return sendResponse(await store.set({ log: [] }));
				default:
					return sendResponse({ ok: false, error: 'unknown message' });
			}
		} catch (e) {
			return sendResponse({ ok: false, error: e.message });
		}
	})();
	return true; // keep the channel open for the async reply
});

/**
 * Huckleberry · provider tests
 * Spins up a local HTTP server that mimics the Gemini REST API (and an
 * OpenAI-compatible endpoint), then drives src/llm.js against it.
 *
 *   node test/gemini.test.mjs
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { ask, listModels, providers, buildQuestionPrompt } from '../src/llm.js';

const seen = [];
let failNextTimes = 0;

const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', c => (body += c));
	req.on('end', () => {
		const json = body ? JSON.parse(body) : null;
		seen.push({ url: req.url, method: req.method, headers: req.headers, body: json });
		const reply = (code, obj) => {
			res.writeHead(code, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(obj));
		};

		// ---- auth check, exactly like the real API ----
		const geminiCall = req.url.includes(':generateContent') || req.url.startsWith('/v1beta/models');
		if (geminiCall && req.headers['x-goog-api-key'] !== 'TEST-KEY')
			return reply(401, { error: { code: 401, message: 'API key not valid' } });

		if (failNextTimes > 0) {
			failNextTimes--;
			return reply(429, { error: { code: 429, message: 'Resource exhausted' } });
		}

		// ---- Gemini: models.list ----
		if (req.method === 'GET' && req.url.startsWith('/v1beta/models?'))
			return reply(200, {
				models: [
					{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
					{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
					{ name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
				]
			});

		// ---- Gemini: generateContent ----
		if (req.url.includes(':generateContent')) {
			if (json?.contents?.[0]?.parts?.[0]?.text?.includes('BLOCK_ME'))
				return reply(200, { promptFeedback: { blockReason: 'SAFETY' } });
			return reply(200, {
				candidates: [
					{
						content: {
							role: 'model',
							parts: [
								{ text: 'internal reasoning that must be ignored', thought: true },
								{ text: 'B) Paris' }
							]
						},
						finishReason: 'STOP'
					}
				]
			});
		}

		// ---- OpenAI-compatible ----
		if (req.url.endsWith('/chat/completions')) {
			if (req.headers.authorization !== 'Bearer OA-KEY')
				return reply(401, { error: { message: 'bad key' } });
			return reply(200, { choices: [{ message: { content: 'B) Paris' } }] });
		}

		reply(404, { error: { message: 'not found' } });
	});
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const gemini = {
	provider: 'gemini',
	apiKey: 'TEST-KEY',
	baseUrl: `${origin}/v1beta`,
	model: 'gemini-2.5-flash',
	temperature: 0.2,
	systemPrompt: 'Answer verbatim.',
	retries: 3
};

const Q = { text: 'Capital of France?', choices: ['London', 'Paris', 'Rome'] };
let passed = 0;
const test = async (name, fn) => {
	await fn();
	passed++;
	console.log(`  ✓ ${name}`);
};

console.log('\nGemini provider');

await test('returns the answer text', async () => {
	assert.equal(await ask(gemini, Q), 'B) Paris');
});

await test('uses POST models/{model}:generateContent', async () => {
	const call = seen.at(-1);
	assert.equal(call.method, 'POST');
	assert.equal(call.url, '/v1beta/models/gemini-2.5-flash:generateContent');
});

await test('authenticates with the x-goog-api-key header', async () => {
	const call = seen.at(-1);
	assert.equal(call.headers['x-goog-api-key'], 'TEST-KEY');
	assert.ok(!call.url.includes('key='), 'key must not leak into the query string');
});

await test('sends systemInstruction + contents + generationConfig', async () => {
	const b = seen.at(-1).body;
	assert.equal(b.systemInstruction.parts[0].text, 'Answer verbatim.');
	assert.equal(b.contents[0].role, 'user');
	assert.match(b.contents[0].parts[0].text, /Capital of France\?/);
	assert.match(b.contents[0].parts[0].text, /B\) Paris/); // choices are lettered
	assert.equal(b.generationConfig.temperature, 0.2);
	assert.ok(b.generationConfig.maxOutputTokens > 0);
});

await test('drops thought parts from the answer', async () => {
	assert.equal(await ask(gemini, Q), 'B) Paris');
});

await test('surfaces a safety block clearly', async () => {
	await assert.rejects(() => ask(gemini, { text: 'BLOCK_ME' }), /SAFETY/);
});

await test('reports a bad API key as HTTP 401', async () => {
	await assert.rejects(() => ask({ ...gemini, apiKey: 'WRONG' }, Q), /401/);
});

await test('retries 429 with backoff, then succeeds', async () => {
	failNextTimes = 2;
	assert.equal(await ask(gemini, Q), 'B) Paris');
	assert.equal(failNextTimes, 0);
});

await test('lists only generateContent models', async () => {
	const models = await listModels(gemini);
	assert.deepEqual(models, ['gemini-2.5-flash', 'gemini-2.5-pro']);
});

await test('rejects a missing API key before any request', async () => {
	await assert.rejects(() => providers.gemini({ ...gemini, apiKey: '' }, []), /Missing API key/);
});

console.log('\nOpenAI-compatible provider');
await test('returns the answer text', async () => {
	const cfg = { provider: 'openai', apiKey: 'OA-KEY', baseUrl: origin, model: 'gpt-4o-mini' };
	assert.equal(await ask(cfg, Q), 'B) Paris');
});

console.log('\nPrompt builder');
await test('letters the choices and demands verbatim output', async () => {
	const p = buildQuestionPrompt(Q);
	assert.match(p, /A\) London/);
	assert.match(p, /C\) Rome/);
	assert.match(p, /verbatim/);
});

server.close();
console.log(`\n${passed} tests passed\n`);

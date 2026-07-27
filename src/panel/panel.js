/* Huckleberry · side panel UI */

const $ = s => document.querySelector(s);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
let S = {};

/* ── tabs ────────────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(t => {
	t.addEventListener('click', () => {
		document.querySelectorAll('.tab').forEach(e => e.classList.remove('is-active'));
		document.querySelectorAll('.pane').forEach(e => e.classList.remove('is-active'));
		t.classList.add('is-active');
		$('#' + t.dataset.tab).classList.add('is-active');
	});
});

/* ── two-way state binding ─────────────────────────────────── */
const read = key => key.split('.').reduce((o, k) => (o == null ? o : o[k]), S);

function bind(sel, key, { prop = 'value', event = 'change' } = {}) {
	const el = $(sel);
	if (!el) return;
	const current = read(key);
	if (current !== undefined && current !== null) el[prop] = current;
	el.addEventListener(event, async () => {
		const raw = prop === 'checked' ? el.checked : el.value;
		const value = el.type === 'range' ? Number(raw) : raw;
		const [a, b] = key.split('.');
		const patch = b ? { [a]: { ...S[a], [b]: value } } : { [a]: value };
		S = await send('setState', { patch });
	});
}

/* ── boot ────────────────────────────────────────────── */
async function boot() {
	S = (await send('getState')) || {};

	bind('#provider', 'provider');
	bind('#apiKey', 'apiKey', { event: 'input' });
	bind('#baseUrl', 'baseUrl', { event: 'input' });
	bind('#model', 'model', { event: 'input' });
	bind('#systemPrompt', 'systemPrompt', { event: 'input' });
	bind('#temperature', 'temperature', { event: 'input' });
	bind('#delayMs', 'delayMs', { event: 'input' });
	bind('#autoSubmit', 'autoSubmit', { prop: 'checked' });
	bind('#tgEnabled', 'telegram.enabled', { prop: 'checked' });
	bind('#tgToken', 'telegram.token', { event: 'input' });
	bind('#tgChatId', 'telegram.chatId', { event: 'input' });

	$('#temperature').addEventListener('input', e => ($('#tempVal').textContent = e.target.value));
	$('#delayMs').addEventListener('input', e => ($('#delayVal').textContent = e.target.value));
	$('#provider').addEventListener('change', () => {
		const d = S.providerDefaults?.[$('#provider').value];
		if (d) $('#baseUrl').placeholder = d.baseUrl, ($('#model').placeholder = d.model);
		$('#modelList').innerHTML = '';
	});

	$('#tempVal').textContent = S.temperature ?? 0.2;
	$('#delayVal').textContent = S.delayMs ?? 700;
	$('#stRuns').textContent = S.stats?.runs ?? 0;
	$('#stAns').textContent = S.stats?.answered ?? 0;
	const d = S.providerDefaults?.[S.provider];
	if (d) $('#baseUrl').placeholder = d.baseUrl, ($('#model').placeholder = d.model);

	renderLog(S.log || []);
	renderCreds();
	setStatus(S.running ? 'busy' : 'idle');
}

/* ── actions ──────────────────────────────────────────── */
function setStatus(kind) {
	$('#dot').className = 'dot ' + kind;
	$('#dot').title = kind;
}

$('#btnRun').addEventListener('click', async () => {
	setStatus('busy');
	$('#bar').style.width = '0';
	$('#nowQ').textContent = 'Working…';
	const r = await send('run');
	setStatus(r?.ok ? 'ok' : 'err');
	if (r?.ok) {
		$('#stAns').textContent = Number($('#stAns').textContent) + (r.answered || 0);
		$('#stRuns').textContent = Number($('#stRuns').textContent) + 1;
		$('#nowQ').textContent = `Done — ${r.answered}/${r.total} answered.`;
	} else {
		$('#nowQ').textContent = r?.error || 'Run failed.';
	}
});

$('#btnStop').addEventListener('click', () => {
	send('stop');
	$('#nowQ').textContent = 'Stopping after the current question…';
});

$('#btnScan').addEventListener('click', async () => {
	const r = await send('scanOnly');
	const n = r?.questions?.length ?? 0;
	$('#stFound').textContent = n;
	$('#nowQ').textContent = n
		? `${n} question(s) detected and highlighted on the page.`
		: 'Nothing detected. Scroll the page once and scan again.';
});

$('#btnClear').addEventListener('click', async () => {
	await send('clearLog');
	$('#log').innerHTML = '';
});

$('#btnTestAI').addEventListener('click', async () => {
	$('#aiResult').textContent = 'Testing…';
	const r = await send('testLLM');
	$('#aiResult').textContent = r?.ok ? `Connected. Model replied: ${r.text}` : `Failed: ${r?.error}`;
});

$('#btnModels').addEventListener('click', async () => {
	$('#aiResult').textContent = 'Loading models…';
	const r = await send('listModels');
	if (!r?.ok) return void ($('#aiResult').textContent = `Failed: ${r?.error}`);
	$('#modelList').innerHTML = r.models.map(m => `<option value="${m}"></option>`).join('');
	$('#aiResult').textContent = `${r.models.length} models available — open the Model field to pick one.`;
});

$('#btnTestTg').addEventListener('click', async () => {
	$('#tgResult').textContent = 'Testing…';
	const r = await send('testTelegram');
	$('#tgResult').textContent = r?.ok
		? `Connected to @${r.bot}. ${r.note || 'Test message sent.'}`
		: `Failed: ${r?.error}`;
});

/* ── credentials editor ───────────────────────────────────── */
const FIELDS = [
	{ k: 'user', ph: 'username', type: 'text' },
	{ k: 'pass', ph: 'password', type: 'password' },
	{ k: 'userSel', ph: 'username selector (optional)', type: 'text' },
	{ k: 'passSel', ph: 'password selector (optional)', type: 'text' }
];

async function saveCreds() {
	S = await send('setState', { patch: { credentials: S.credentials } });
}

function renderCreds() {
	const wrap = $('#credList');
	wrap.innerHTML = '';
	S.credentials = S.credentials || [];

	S.credentials.forEach((c, i) => {
		const box = document.createElement('div');
		box.className = 'cred';

		const head = document.createElement('div');
		head.className = 'cred-h';
		const host = document.createElement('input');
		host.placeholder = 'example.com';
		host.value = c.host || '';
		host.addEventListener('input', () => { c.host = host.value; saveCreds(); });
		const del = document.createElement('button');
		del.className = 'del';
		del.textContent = '×';
		del.title = 'Remove site';
		del.addEventListener('click', async () => {
			S.credentials.splice(i, 1);
			await saveCreds();
			renderCreds();
		});
		head.append(host, del);

		const grid = document.createElement('div');
		grid.className = 'grid';
		for (const f of FIELDS) {
			const input = document.createElement('input');
			input.type = f.type;
			input.placeholder = f.ph;
			input.autocomplete = 'off';
			input.value = c[f.k] || '';
			input.addEventListener('input', () => { c[f.k] = input.value; saveCreds(); });
			grid.appendChild(input);
		}

		const submit = document.createElement('input');
		submit.placeholder = 'submit button selector (optional)';
		submit.value = c.submitSel || '';
		submit.addEventListener('input', () => { c.submitSel = submit.value; saveCreds(); });

		box.append(head, grid, submit);
		wrap.appendChild(box);
	});

	if (!S.credentials.length) {
		const empty = document.createElement('p');
		empty.className = 'muted';
		empty.textContent = 'No sites yet. Add one so Huckleberry can sign in for you.';
		wrap.appendChild(empty);
	}
}

$('#btnAddCred').addEventListener('click', async () => {
	S.credentials = S.credentials || [];
	S.credentials.push({ host: '', user: '', pass: '' });
	await saveCreds();
	renderCreds();
});

/* ── log ──────────────────────────────────────────────── */
function logNode(e) {
	const li = document.createElement('li');
	li.className = e.level;
	const time = document.createElement('time');
	time.textContent = new Date(e.t).toLocaleTimeString();
	li.append(time, document.createTextNode(e.msg));
	return li;
}

function renderLog(list) {
	const ul = $('#log');
	ul.innerHTML = '';
	if (!list.length) {
		const li = document.createElement('li');
		li.textContent = 'Nothing yet.';
		ul.appendChild(li);
		return;
	}
	list.forEach(e => ul.appendChild(logNode(e)));
}

chrome.runtime.onMessage.addListener(m => {
	if (m.type === 'log') {
		const ul = $('#log');
		if (ul.firstChild?.textContent === 'Nothing yet.') ul.innerHTML = '';
		ul.prepend(logNode(m.entry));
	}
	if (m.type === 'progress') {
		$('#nowQ').textContent = m.q.slice(0, 110);
		$('#stFound').textContent = m.total;
		$('#bar').style.width = `${Math.round((m.done / Math.max(1, m.total)) * 100)}%`;
	}
	if (m.type === 'done') {
		$('#bar').style.width = '100%';
	}
});

boot();

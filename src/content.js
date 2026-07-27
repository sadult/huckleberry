/**
 * Huckleberry · content script
 * Detects questions, signs in, writes answers back into the page.
 */
(() => {
	if (window.__huckleberry__) return;
	window.__huckleberry__ = true;

	const norm = s => (s || '').replace(/\s+/g, ' ').trim();

	const visible = el => {
		const r = el.getBoundingClientRect();
		const st = getComputedStyle(el);
		return r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.display !== 'none';
	};

	/** id -> { kind, inputs[], choices[] } */
	let INDEX = new Map();

	/* ── input helpers (React / Vue / Angular safe) ─────────────────────── */
	function type(el, value) {
		if (el.isContentEditable) {
			el.focus();
			document.execCommand('selectAll', false, null);
			document.execCommand('insertText', false, value);
			el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
			return;
		}
		const proto =
			el instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype;
		const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
		el.focus();
		setter.call(el, value);
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
		el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
	}

	function click(el) {
		try { el.scrollIntoView({ block: 'center' }); } catch {}
		el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
		el.click();
	}

	const labelOf = input => {
		if (input.id) {
			const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
			if (l) return norm(l.innerText);
		}
		const wrap = input.closest('label');
		if (wrap) return norm(wrap.innerText);
		const aria = input.getAttribute('aria-label');
		if (aria) return norm(aria);
		return norm(input.parentElement ? input.parentElement.innerText : input.value);
	};

	/* ── 1 · detection ───────────────────────────────────────────── */
	function commonAncestor(nodes) {
		let a = nodes[0];
		for (const b of nodes.slice(1)) while (a && !a.contains(b)) a = a.parentElement;
		return a || document.body;
	}

	function questionTextFrom(container, choices) {
		if (!container) return '';
		let t = norm(container.innerText);
		for (const c of choices) if (c) t = t.split(c).join(' ');
		t = norm(t);
		return t.length > 1500 ? t.slice(0, 1500) : t;
	}

	function scan() {
		INDEX = new Map();
		const out = [];
		let anon = 0;

		// A) radio / checkbox groups → multiple choice
		const groups = new Map();
		document.querySelectorAll('input[type=radio], input[type=checkbox]').forEach(i => {
			if (!visible(i)) return;
			const key =
				i.name ||
				i.closest('fieldset,[role=radiogroup]')?.id ||
				'anon-' + anon++;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(i);
		});

		for (const inputs of groups.values()) {
			if (inputs.length < 2) continue;
			const choices = inputs.map(labelOf);
			const text = questionTextFrom(commonAncestor(inputs), choices);
			if (!text) continue;
			const id = 'q' + out.length;
			INDEX.set(id, { kind: 'choice', inputs, choices });
			out.push({ id, text, choices });
		}

		// B) native <select> menus
		document.querySelectorAll('select').forEach(sel => {
			if (!visible(sel) || sel.options.length < 2) return;
			const choices = [...sel.options].map(o => norm(o.text)).filter(Boolean);
			const text = questionTextFrom(sel.closest('div,li,tr,fieldset,form') || sel.parentElement, choices);
			if (!text) return;
			const id = 'q' + out.length;
			INDEX.set(id, { kind: 'select', inputs: [sel], choices });
			out.push({ id, text, choices });
		});

		// C) free text: textarea / text input / contenteditable
		const SKIP = /user|login|email|mail|pass|search|query|token|coupon|captcha/i;
		document
			.querySelectorAll('textarea, input[type=text], [contenteditable="true"]')
			.forEach(el => {
				if (!visible(el)) return;
				if (el.value || (el.isContentEditable && norm(el.innerText))) return;
				const hint = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`;
				if (SKIP.test(hint)) return;
				if (el.closest('nav, header, [role=search], form[role=search]')) return;
				const text = questionTextFrom(
					el.closest('div,li,tr,fieldset,form') || el.parentElement,
					[]
				);
				if (!text || text.length < 8) return;
				const id = 'q' + out.length;
				INDEX.set(id, { kind: 'text', inputs: [el], choices: [] });
				out.push({ id, text, choices: [] });
			});

		highlight();
		return { questions: out };
	}

	function highlight() {
		document.querySelectorAll('.hb-hl,.hb-ok').forEach(e => e.classList.remove('hb-hl', 'hb-ok'));
		if (!document.getElementById('hb-style')) {
			const s = document.createElement('style');
			s.id = 'hb-style';
			s.textContent =
				'.hb-hl{outline:2px dashed #7C6BFF!important;outline-offset:3px;border-radius:6px}' +
				'.hb-ok{outline:2px solid #159C68!important;outline-offset:3px;border-radius:6px}';
			document.documentElement.appendChild(s);
		}
		for (const { inputs } of INDEX.values())
			inputs[0]?.closest('div,li,tr,fieldset')?.classList.add('hb-hl');
	}

	/* ── 2 · answer placement ─────────────────────────────────────── */
	const score = (a, b) => {
		a = norm(a).toLowerCase();
		b = norm(b).toLowerCase();
		if (!a || !b) return 0;
		if (a === b) return 1;
		if (a.includes(b) || b.includes(a)) return 0.85;
		const A = new Set(a.split(' ')), B = new Set(b.split(' '));
		const inter = [...A].filter(w => B.has(w)).length;
		return inter / Math.max(A.size, B.size);
	};

	function resolveIndex(q, answer) {
		const m = /^\s*([A-Za-z])\s*[).\-:]/.exec(answer);
		const clean = answer.replace(/^\s*[A-Za-z]\s*[).\-:]\s*/, '').trim();
		if (m) {
			const i = m[1].toUpperCase().charCodeAt(0) - 65;
			if (i >= 0 && i < q.choices.length) return i;
		}
		let best = 0, idx = -1;
		q.choices.forEach((c, i) => {
			const s = Math.max(score(c, clean), score(c, answer));
			if (s > best) { best = s; idx = i; }
		});
		return best >= 0.34 ? idx : -1;
	}

	function fill(id, answer) {
		const q = INDEX.get(id);
		if (!q) return { ok: false, error: 'unknown question id' };

		if (q.kind === 'text') {
			type(q.inputs[0], answer);
			q.inputs[0].closest('div,li,tr')?.classList.add('hb-ok');
			return { ok: true, choice: answer };
		}

		const idx = resolveIndex(q, answer);
		if (idx < 0) return { ok: false, error: 'no matching choice' };

		if (q.kind === 'select') {
			const sel = q.inputs[0];
			sel.selectedIndex = idx;
			sel.dispatchEvent(new Event('input', { bubbles: true }));
			sel.dispatchEvent(new Event('change', { bubbles: true }));
			sel.closest('div,li,tr')?.classList.add('hb-ok');
			return { ok: true, choice: q.choices[idx] };
		}

		click(q.inputs[idx]);
		q.inputs[idx].closest('div,li,tr,label')?.classList.add('hb-ok');
		return { ok: true, choice: q.choices[idx] };
	}

	/* ── 3 · sign in ────────────────────────────────────────────── */
	const pick = (sel, fallback) => {
		if (sel) { try { const el = document.querySelector(sel); if (el) return el; } catch {} }
		return document.querySelector(fallback);
	};

	function login(cred) {
		const pass = pick(cred.passSel, 'input[type=password]');
		if (!pass) return { filled: false, error: 'no password field' };
		const user = pick(
			cred.userSel,
			'input[type=email], input[name*=user i], input[id*=user i], input[name*=mail i], input[type=text]'
		);
		if (!user) return { filled: false, error: 'no username field' };
		type(user, cred.user || '');
		type(pass, cred.pass || '');
		const btn = pick(cred.submitSel, 'button[type=submit], input[type=submit], form button');
		if (btn) setTimeout(() => click(btn), 300);
		else setTimeout(() => pass.form?.submit?.(), 300);
		return { filled: true };
	}

	function submitForm() {
		const btn = document.querySelector(
			'button[type=submit], input[type=submit], [class*=submit i], [id*=submit i]'
		);
		if (btn) click(btn);
		return { ok: !!btn };
	}

	/* ── router ───────────────────────────────────────────────── */
	chrome.runtime.onMessage.addListener((msg, _sender, res) => {
		try {
			if (msg.type === 'scan') res(scan());
			else if (msg.type === 'fill') res(fill(msg.id, msg.answer));
			else if (msg.type === 'login') res(login(msg.cred));
			else if (msg.type === 'submit') res(submitForm());
			else res({});
		} catch (e) {
			res({ ok: false, error: e.message });
		}
		return true;
	});
})();

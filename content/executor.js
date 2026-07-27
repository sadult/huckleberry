/* Huckleberry — Executor (replay mode)
 * Performs steps on the page: click, type, extract the question, pick the
 * correct option. Elements are located through the fingerprint engine
 * (selector.js), never by screen coordinates.
 */
(() => {
  "use strict";
  if (window.__fmExecutor) return;
  window.__fmExecutor = true;
  const B = globalThis.browser ?? globalThis.chrome;
  const S = () => window.__fmSelector;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function flash(el, color) {
    try {
      const prevOutline = el.style.outline;
      const prevOffset = el.style.outlineOffset;
      el.style.outline = `3px solid ${color || "#6366F1"}`;
      el.style.outlineOffset = "2px";
      setTimeout(() => { el.style.outline = prevOutline; el.style.outlineOffset = prevOffset; }, 700);
    } catch (e) {}
  }

  function realClick(el) {
    el.scrollIntoView({ block: "center" });
    flash(el);
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2),
    };
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    if (typeof el.click === "function") el.click();
    else el.dispatchEvent(new MouseEvent("click", opts));
  }

  function setValue(el, value) {
    el.focus();
    if (el.isContentEditable) {
      el.textContent = "";
      document.execCommand("insertText", false, value);
      return;
    }
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    let done = false;
    try {
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) { setter.call(el, value); done = true; }
    } catch (e) {}
    if (!done) el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressEnter(el) {
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    const form = el.closest && el.closest("form");
    if (form && typeof form.requestSubmit === "function") {
      try { form.requestSubmit(); } catch (e) {}
    }
  }

  /* Answers such as "3", "option 3", "c)" are treated as an option index.
   * The RTL option markers are written as escapes so the source stays ASCII
   * while still working on right-to-left questionnaires. */
  const RTL_LETTERS = { "\u0627\u0644\u0641": 1, "\u0628": 2, "\u062c": 3, "\u062f": 4, "\u0647": 5 };
  const LETTERS = { ...RTL_LETTERS, a: 1, b: 2, c: 3, d: 4, e: 5 };
  const ANSWER_PREFIX = /^(?:option|answer|choice|\u06af\u0632\u06cc\u0646\u0647|\u062c\u0648\u0627\u0628|\u067e\u0627\u0633\u062e)?[:\s]*/;

  function parseIndexAnswer(ans) {
    const n = S().norm(ans).replace(/[\u00ab\u00bb"'.,:;!]/g, "").trim();
    let m = n.match(new RegExp("^" + ANSWER_PREFIX.source.slice(1) + "(\\d{1,2})\\s*[).\\-]?$"));
    if (m) return parseInt(m[1], 10);
    const keys = Object.keys(LETTERS).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    m = n.match(new RegExp("^(" + keys + ")\\s*[).\\-]?$"));
    if (m) return LETTERS[m[1]] || null;
    return null;
  }

  function optionCandidates(container) {
    const sel = 'input[type="radio"],input[type="checkbox"],[role="radio"],[role="option"],label,button,li';
    const out = [];
    const seenText = new Set();
    for (const el of container.querySelectorAll(sel)) {
      if (!S().visible(el) && el.tagName !== "INPUT") continue;
      let clickTarget = el;
      let textEl = el;
      if (el.tagName === "INPUT") {
        textEl = (el.labels && el.labels[0]) || el.closest("label") || el.parentElement || el;
        clickTarget = el;
      }
      const txt = S().norm(S().textOf(textEl)).slice(0, 300);
      if (!txt && el.tagName !== "INPUT") continue;
      const key = el.tagName + "|" + txt;
      if (seenText.has(key)) continue;
      seenText.add(key);
      out.push({ el: clickTarget, txt, isInput: el.tagName === "INPUT" });
    }
    return out;
  }

  function chooseAnswer(container, answer) {
    const cands = optionCandidates(container);
    if (!cands.length) throw new Error("No options were found inside the selected area.");

    // Case 1: the answer is only an option number or letter.
    const idx = parseIndexAnswer(answer);
    if (idx) {
      const inputs = cands.filter((c) => c.isInput);
      const list = inputs.length ? inputs : cands;
      if (list[idx - 1]) {
        realClick(list[idx - 1].el);
        return "option #" + idx;
      }
    }

    // Case 2: fuzzy text matching.
    const normAns = S().norm(answer).replace(ANSWER_PREFIX, "");
    let best = null, bestScore = 0;
    for (const c of cands) {
      if (!c.txt) continue;
      let s = 0;
      if (c.txt === normAns) s = 1;
      else if (normAns.includes(c.txt) || c.txt.includes(normAns)) {
        s = 0.6 + 0.35 * (Math.min(c.txt.length, normAns.length) / Math.max(c.txt.length, normAns.length));
      } else {
        s = S().tokenOverlap(c.txt, normAns) * 0.9;
      }
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (!best || bestScore < 0.35) {
      throw new Error('No option matched the AI answer: "' + answer.slice(0, 60) + '"');
    }
    realClick(best.el);
    flash(best.el, "#34D399");
    return best.txt.slice(0, 80);
  }

  async function execStep(step, answer) {
    const target = step.target ? S().resolve(step.target) : null;
    switch (step.type) {
      case "click": {
        if (!target) return { ok: false, error: "Element not found: " + (step.label || step.target?.text || "") };
        realClick(target);
        return { ok: true };
      }
      case "type": {
        if (!target) return { ok: false, error: "Field not found: " + (step.label || "") };
        target.scrollIntoView({ block: "center" });
        flash(target);
        setValue(target, step.value || "");
        await sleep(150);
        if (step.pressEnter) pressEnter(target);
        return { ok: true };
      }
      case "extract": {
        if (!target) return { ok: false, error: "Question area not found." };
        target.scrollIntoView({ block: "center" });
        flash(target, "#FBBF24");
        const text = (target.innerText || target.textContent || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 8000);
        if (!text) return { ok: false, error: "The question area contains no text." };
        return { ok: true, text };
      }
      case "choose_answer": {
        if (!target) return { ok: false, error: "Options area not found." };
        const chosen = chooseAnswer(target, answer || "");
        return { ok: true, chosen };
      }
      default:
        return { ok: false, error: "This step type is not supported in the page: " + step.type };
    }
  }

  B.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.cmd === "exec:step") {
      execStep(msg.step, msg.answer)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.cmd === "exec:probe") {
      try {
        const el = S().resolve(msg.target);
        sendResponse({ ok: true, found: !!el });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return true;
    }
  });
})();

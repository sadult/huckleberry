/* Huckleberry — Selector Engine
 * Instead of click coordinates, every recorded element gets a multi-layer
 * fingerprint (id, data-attrs, aria, text, CSS path, XPath). At replay time the
 * best candidate is picked by scoring, so steps keep working even when the
 * layout shifts or a button moves.
 */
(() => {
  "use strict";
  if (window.__fmSelector) return;

  /* --- Text normalization (Unicode variants, RTL marks, non-latin digits) --- */
  const FA_DIGITS = "\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9";
  const AR_DIGITS = "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669";
  function normDigits(s) {
    return s.replace(/[\u06f0-\u06f9\u0660-\u0669]/g, (d) => {
      let i = FA_DIGITS.indexOf(d);
      if (i < 0) i = AR_DIGITS.indexOf(d);
      return String(i);
    });
  }
  function norm(s) {
    if (!s) return "";
    return normDigits(
      String(s)
        .replace(/[\u064A]/g, "\u06cc")      // unify Arabic yeh with Persian yeh
        .replace(/[\u0643]/g, "\u06a9")      // unify Arabic kaf with Persian kaf
        .replace(/[\u064B-\u065F\u0670]/g, "") // strip diacritics
        .replace(/[\u200c\u200f\u200e]/g, " ") // zero-width joiners and direction marks
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
    );
  }

  function textOf(el) {
    if (!el) return "";
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      return el.value || el.placeholder || "";
    }
    return el.innerText || el.textContent || "";
  }

  function tokenOverlap(a, b) {
    const ta = new Set(norm(a).split(" ").filter((w) => w.length > 1));
    const tb = new Set(norm(b).split(" ").filter((w) => w.length > 1));
    if (!ta.size || !tb.size) return 0;
    let hit = 0;
    for (const w of ta) if (tb.has(w)) hit++;
    return hit / Math.max(ta.size, tb.size);
  }

  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/([^\w-])/g, "\\$1"));

  /* --- Build a stable CSS path --- */
  function cssPath(el) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 10) {
      if (node.id) { parts.unshift("#" + esc(node.id)); break; }
      let part = node.tagName.toLowerCase();
      const stable = [...node.classList].filter((c) => c.length < 32 && !/\d{3,}|active|hover|focus|selected|fm-/.test(c)).slice(0, 2);
      if (stable.length) part += "." + stable.map(esc).join(".");
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  function xPath(el) {
    if (el.id) return `//*[@id="${el.id}"]`;
    const segs = [];
    let node = el;
    while (node && node.nodeType === 1 && segs.length < 12) {
      let i = 1;
      let sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) i++; sib = sib.previousElementSibling; }
      segs.unshift(`${node.tagName.toLowerCase()}[${i}]`);
      node = node.parentElement;
    }
    return "/" + segs.join("/");
  }

  /* --- Capture the full element fingerprint (recording mode) --- */
  function capture(el) {
    const dataAttrs = {};
    for (const a of el.attributes || []) {
      if (/^data-(testid|test|id|qa|cy|name|key)$/i.test(a.name)) dataAttrs[a.name] = a.value;
    }
    let labelText = "";
    if (el.labels && el.labels.length) labelText = textOf(el.labels[0]);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      dataAttrs,
      name: el.getAttribute("name") || null,
      inputType: el.getAttribute("type") || null,
      placeholder: el.getAttribute("placeholder") || null,
      aria: el.getAttribute("aria-label") || null,
      role: el.getAttribute("role") || null,
      title: el.getAttribute("title") || null,
      value: el.tagName === "INPUT" ? null : undefined,
      text: norm(textOf(el)).slice(0, 140),
      labelText: norm(labelText).slice(0, 100),
      css: cssPath(el),
      xpath: xPath(el),
    };
  }

  /* --- Score candidates (replay mode) --- */
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
  }

  function score(el, t) {
    let s = 0;
    if (t.id && el.id === t.id) s += 60;
    for (const [k, v] of Object.entries(t.dataAttrs || {})) {
      if (el.getAttribute(k) === v) s += 55;
    }
    if (t.name && el.getAttribute("name") === t.name) s += 40;
    if (t.aria && norm(el.getAttribute("aria-label")) === norm(t.aria)) s += 40;
    if (t.placeholder && norm(el.getAttribute("placeholder")) === norm(t.placeholder)) s += 35;
    if (t.inputType && el.getAttribute("type") === t.inputType) s += 8;
    if (t.role && el.getAttribute("role") === t.role) s += 8;
    if (t.tag && el.tagName.toLowerCase() === t.tag) s += 5;
    if (t.text) {
      const txt = norm(textOf(el)).slice(0, 200);
      if (txt && txt === t.text) s += 45;
      else if (txt && (txt.includes(t.text) || t.text.includes(txt))) s += 25;
      else if (txt) s += 20 * tokenOverlap(txt, t.text);
    }
    if (t.labelText && el.labels && el.labels.length && norm(textOf(el.labels[0])) === t.labelText) s += 30;
    if (!visible(el)) s -= 100;
    return s;
  }

  /* --- Locate the element at replay time --- */
  function resolve(t) {
    if (!t) return null;
    // 1) direct id
    if (t.id) {
      const el = document.getElementById(t.id);
      if (el && score(el, t) >= 40) return el;
    }
    // 2) data-attributes
    for (const [k, v] of Object.entries(t.dataAttrs || {})) {
      try {
        const el = document.querySelector(`[${k}="${esc(v)}"]`);
        if (el && visible(el)) return el;
      } catch (e) {}
    }
    // 3) exact CSS path (only when unique and the text still matches)
    try {
      const list = document.querySelectorAll(t.css);
      if (list.length === 1) {
        const el = list[0];
        if (!t.text || score(el, t) >= 30) return el;
      }
    } catch (e) {}
    // 4) scored candidate scan — also finds buttons that moved
    const tagSel = t.tag ? `${t.tag}, [role="${t.role || "button"}"], a, button, input, [onclick]` : "*";
    let best = null, bestScore = 0;
    const seen = new Set();
    let candidates;
    try { candidates = document.querySelectorAll(tagSel); } catch (e) { candidates = document.querySelectorAll("*"); }
    for (const el of candidates) {
      if (seen.has(el)) continue;
      seen.add(el);
      const s = score(el, t);
      if (s > bestScore) { bestScore = s; best = el; }
    }
    if (best && bestScore >= 30) return best;
    // 5) XPath as the last resort
    try {
      const r = document.evaluate(t.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      if (r.singleNodeValue && visible(r.singleNodeValue)) return r.singleNodeValue;
    } catch (e) {}
    return best && bestScore >= 18 ? best : null;
  }

  window.__fmSelector = { capture, resolve, norm, textOf, tokenOverlap, visible, normDigits };
})();

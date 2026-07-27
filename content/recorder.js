/* Huckleberry — Recorder panel
 * Injected on demand. Renders a draggable shadow-DOM panel that lets you
 * build a macro step by step by picking real elements on the page.
 */
(() => {
  "use strict";
  if (window.__fmRecorder) return;

  const B = globalThis.browser ?? globalThis.chrome;
  const S = () => window.__fmSelector;

  const DRAFT_KEY = "hbDraft";

  /* ---------------- i18n ---------------- */
  const R = {
    en: {
      recTitle: "Huckleberry — Recording",
      emptySteps: "No steps yet.<br>Build your macro with the buttons below.",
      sepGeneral: "General steps", sepSmart: "Smart questionnaire steps",
      bOpenUrl: "🌐 Current URL", bClick: "👆 Click", bType: "⌨️ Type text", bWait: "⏳ Wait",
      bRestart: "📍 Question start point", bLoopStart: "🔁 Loop start", bExtract: "📋 Extract question",
      bAskAi: "🧠 Ask AI", bChoose: "✅ Choose answer", bLoopEnd: "🏁 Loop end", bConfirm: "🔔 Confirm & repeat",
      pickNote: "🎯 Click the target element on the page (Esc = cancel)",
      bBatch: "🔂 N similar questions",
      batchTitle: "🔂 Similar questions",
      batchCount: "How many questions like this one?",
      batchFormat: "Question format (optional — sent to the AI with every question)",
      batchFormatPh: "e.g. every question has 4 options, exactly one is correct…",
      batchNote: "Your recorded question steps will repeat automatically — one question at a time.",
      formApply: "Apply",
      save: "💾 Save macro", cancel: "Cancel",
      formAdd: "Add step", formCancel: "Cancel",
      optional: "Optional — skip silently if not found",
      clickTitle: "👆 Click step", labelLabel: "Label (shown in the list)",
      exitLabel: "If missing, exit the loop (like the \u201cNext\u201d button on the last question)",
      typeTitle: "⌨️ Type step", typeValue: "Text to type", typeLabelPh: "e.g. national ID",
      isPass: "This is a password (keep it hidden)", pressEnter: "Press Enter after typing",
      extractTitle: "📋 Extract question", extractNote: "The question text and options are read from this area.",
      waitTitle: "⏳ Wait", waitMs: "Duration (ms)",
      loopTitle: "🔁 Loop start", loopMax: "Max iterations (empty = from settings)", loopPh: "e.g. 30",
      confirmTitle: "🔔 Confirm & repeat", confirmMsgLabel: "Message shown to you",
      confirmDefault: "Continue to the next questionnaire?", confirmFallback: "Continue?",
      defClick: "Click", defType: "Type text", defMacroName: "New macro",
      optBadge: "optional", remove: "Remove", alertNoSteps: "Add at least one step!",
      loopTimes: (n) => ` — up to ${n}×`,
      st: {
        open_url: "Open URL", click: "Click", type: "Type text", extract: "Extract question",
        ask_ai: "Ask AI", choose_answer: "Choose answer", wait: "Wait", loop_start: "Loop start",
        loop_end: "Loop end", restart_point: "Question start point", confirm_restart: "Confirm & repeat",
      },
    },
  };
  const T = (k) => R.en[k];

  const STEP_ICONS = {
    open_url: "🌐", click: "👆", type: "⌨️", extract: "📋", ask_ai: "🧠", choose_answer: "✅",
    wait: "⏳", loop_start: "🔁", loop_end: "🏁", restart_point: "📍", confirm_restart: "🔔",
  };

  const panelCss = () => `
  :host { all: initial; }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif; }
  .panel {
    position: fixed; top: 18px; right: 18px; z-index: 2147483646;
    width: 322px; max-height: calc(100vh - 40px);
    display: flex; flex-direction: column;
    background: #0E0D1A; color: #EDEBFF;
    border: 1px solid rgba(129,140,248,.4); border-radius: 16px;
    box-shadow: 0 18px 50px rgba(0,0,0,.65), 0 0 30px rgba(99,102,241,.25);
    font-size: 13px; overflow: hidden;
  }
  .hd {
    display: flex; align-items: center; gap: 9px;
    padding: 11px 14px; cursor: move; user-select: none;
    background: linear-gradient(135deg, rgba(99,102,241,.28), rgba(79,70,229,.18));
    border-bottom: 1px solid rgba(129,140,248,.25);
  }
  .hd .dot { width: 9px; height: 9px; border-radius: 50%; background: #F87171; box-shadow: 0 0 9px rgba(248,113,113,.9); animation: hb-pulse 1.4s infinite; }
  @keyframes hb-pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  .hd b { flex: 1; font-size: 13.5px; font-weight: 800;
    background: linear-gradient(90deg, #EDEBFF, #A5B4FC); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
  .hd small { color: #9C99BD; font-size: 10px; }
  .body { padding: 11px 13px; overflow-y: auto; }
  .steps { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; max-height: 210px; overflow-y: auto; }
  .step {
    display: flex; align-items: center; gap: 8px;
    background: rgba(255,255,255,.045); border: 1px solid rgba(129,140,248,.16);
    border-radius: 10px; padding: 6px 9px; font-size: 11.5px;
  }
  .step .n { color: #6366F1; font-weight: 800; font-size: 10px; min-width: 15px; }
  .step .t { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #D5D2F0; }
  .step .t small { color: #9C99BD; }
  .step .opt { font-size: 9px; color: #22D3EE; border: 1px solid rgba(34,211,238,.35); border-radius: 99px; padding: 1px 6px; }
  .step button { background: none; border: none; color: #F87171; cursor: pointer; font-size: 12px; padding: 2px 4px; }
  .empty { text-align: center; color: #55527A; font-size: 11.5px; padding: 10px 0 12px; line-height: 1.9; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .grid button {
    display: flex; align-items: center; gap: 7px;
    padding: 8px 9px; font-size: 11.5px; font-weight: 700; text-align: start;
    background: rgba(255,255,255,.05); color: #EDEBFF;
    border: 1px solid rgba(129,140,248,.2); border-radius: 10px; cursor: pointer;
    transition: all .15s ease;
  }
  .grid button:hover { border-color: rgba(129,140,248,.55); background: rgba(99,102,241,.18); box-shadow: 0 0 12px rgba(99,102,241,.3); }
  .sep { margin: 10px 0 7px; font-size: 10px; color: #9C99BD; font-weight: 800; letter-spacing: .5px; text-transform: uppercase; }
  .form {
    margin-top: 10px; padding: 11px;
    background: rgba(99,102,241,.1); border: 1px solid rgba(129,140,248,.35); border-radius: 12px;
  }
  .form h4 { font-size: 12px; margin-bottom: 8px; color: #A5B4FC; }
  .form label { display: block; font-size: 10.5px; color: #9C99BD; margin: 7px 0 4px; }
  .form input[type=text], .form input[type=number], .form textarea {
    width: 100%; padding: 7px 10px; font-size: 12px; font-family: inherit;
    background: #090B14; color: #EDEBFF;
    border: 1px solid rgba(129,140,248,.25); border-radius: 9px;
  }
  .form input:focus, .form textarea:focus { outline: none; border-color: #6366F1; box-shadow: 0 0 0 2px rgba(99,102,241,.25); }
  .check { display: flex; align-items: center; gap: 7px; margin-top: 8px; font-size: 11px; color: #D5D2F0; cursor: pointer; }
  .check input { accent-color: #6366F1; width: 14px; height: 14px; flex: none; }
  .form .row { display: flex; gap: 7px; margin-top: 10px; }
  .form .row button { flex: 1; padding: 8px; font-size: 12px; font-weight: 700; border-radius: 9px; cursor: pointer; border: none; }
  .ok { background: linear-gradient(135deg, #6366F1, #4F46E5); color: #fff; box-shadow: 0 2px 10px rgba(99,102,241,.4); }
  .no { background: rgba(255,255,255,.07); color: #9C99BD; border: 1px solid rgba(129,140,248,.2) !important; }
  .ft { display: flex; gap: 8px; padding: 11px 13px; border-top: 1px solid rgba(129,140,248,.2); background: rgba(9,11,20,.6); }
  .ft button { flex: 1; padding: 9px; font-size: 12.5px; font-weight: 800; border-radius: 10px; cursor: pointer; border: none; transition: all .15s ease; }
  .save { background: linear-gradient(135deg, #10B981, #059669); color: #fff; box-shadow: 0 2px 12px rgba(16,185,129,.4); }
  .save:hover { filter: brightness(1.12); }
  .cancel { background: rgba(248,113,113,.12); color: #F87171; border: 1px solid rgba(248,113,113,.35) !important; }
  .cancel:hover { background: rgba(248,113,113,.85); color: #fff; }
  .grid button.batch { grid-column: 1 / -1; border-color: rgba(34,211,238,.4); color: #22D3EE; background: rgba(34,211,238,.07); }
  .grid button.batch:hover { border-color: rgba(34,211,238,.8); background: rgba(34,211,238,.16); box-shadow: 0 0 12px rgba(34,211,238,.3); }
  .form .mini-note { font-size: 10px; color: #9C99BD; margin-top: 8px; line-height: 1.7; }
  .picking-note {
    margin-top: 9px; padding: 9px 11px; font-size: 11.5px; font-weight: 700;
    background: rgba(34,211,238,.1); color: #22D3EE;
    border: 1px dashed rgba(34,211,238,.5); border-radius: 10px; text-align: center;
    animation: hb-pulse 1.6s infinite;
  }
  .body::-webkit-scrollbar, .steps::-webkit-scrollbar { width: 7px; }
  .body::-webkit-scrollbar-thumb, .steps::-webkit-scrollbar-thumb { background: #2E2B4A; border-radius: 99px; }
  `;

  const panelHtml = () => `
  <div class="panel" dir="ltr">
    <div class="hd" id="ebHd">
      <span class="dot"></span>
      <b>${T("recTitle")}</b>
      <small id="ebName"></small>
    </div>
    <div class="body">
      <div class="steps" id="ebSteps"></div>
      <div class="empty" id="ebEmpty">${T("emptySteps")}</div>
      <div class="sep">${T("sepGeneral")}</div>
      <div class="grid">
        <button data-add="open_url">${T("bOpenUrl")}</button>
        <button data-add="click">${T("bClick")}</button>
        <button data-add="type">${T("bType")}</button>
        <button data-add="wait">${T("bWait")}</button>
      </div>
      <div class="sep">${T("sepSmart")}</div>
      <div class="grid">
        <button data-add="restart_point">${T("bRestart")}</button>
        <button data-add="loop_start">${T("bLoopStart")}</button>
        <button data-add="extract">${T("bExtract")}</button>
        <button data-add="ask_ai">${T("bAskAi")}</button>
        <button data-add="choose_answer">${T("bChoose")}</button>
        <button data-add="loop_end">${T("bLoopEnd")}</button>
        <button data-add="confirm_restart">${T("bConfirm")}</button>
        <button data-add="batch" class="batch">${T("bBatch")}</button>
      </div>
      <div id="ebPickNote" class="picking-note" style="display:none">${T("pickNote")}</div>
      <div id="ebForm"></div>
    </div>
    <div class="ft">
      <button class="save" id="ebSave">${T("save")}</button>
      <button class="cancel" id="ebCancel">${T("cancel")}</button>
    </div>
  </div>`;

  /* ---------------- state ---------------- */
  let host = null, root = null;
  let draft = { recording: false, name: "", steps: [], questionFormat: "" };
  let picking = null; // { onPick(el) }
  let hoverBox = null;

  /* Storage wrappers that work on BOTH extension APIs.
   * Firefox's browser.storage.* returns a Promise and never calls a callback,
   * while Chrome's older callback style returns undefined. Calling the callback
   * form on Firefox produces a promise that never settles, which would freeze
   * anything that awaits it. So: try the promise first, fall back to callbacks,
   * and never hang for longer than 3 seconds. */
  const withTimeout = (promise, ms, fallback) =>
    Promise.race([promise, new Promise((res) => setTimeout(() => res(fallback), ms))]);

  const storageGet = (k) =>
    withTimeout(
      new Promise((res) => {
        try {
          const out = B.storage.local.get(k, (v) => res(v || {}));
          if (out && typeof out.then === "function") out.then((v) => res(v || {}), () => res({}));
        } catch (e) {
          res({});
        }
      }),
      3000,
      {},
    );

  const storageSet = (obj) =>
    withTimeout(
      new Promise((res) => {
        try {
          const out = B.storage.local.set(obj, () => res(true));
          if (out && typeof out.then === "function") out.then(() => res(true), () => res(false));
        } catch (e) {
          res(false);
        }
      }),
      3000,
      false,
    );

  /* Same dual-API treatment for messaging the background. */
  const sendBg = (msg) =>
    withTimeout(
      new Promise((res) => {
        try {
          const out = B.runtime.sendMessage(msg, (r) => res(r));
          if (out && typeof out.then === "function") out.then(res, (e) => res({ ok: false, error: String(e) }));
        } catch (e) {
          res({ ok: false, error: e && e.message ? e.message : String(e) });
        }
      }),
      15000,
      null,
    );

  const saveDraft = () => storageSet({ [DRAFT_KEY]: draft });

  /* ---------------- element picking ---------------- */
  function startPicking(onPick) {
    stopPicking();
    picking = { onPick };
    root.getElementById("ebPickNote").style.display = "block";
    hoverBox = document.createElement("div");
    Object.assign(hoverBox.style, {
      position: "fixed", zIndex: 2147483645, pointerEvents: "none",
      border: "2px solid #6366F1", borderRadius: "6px",
      background: "rgba(99,102,241,.14)", boxShadow: "0 0 14px rgba(99,102,241,.5)",
      transition: "all .06s ease", display: "none",
    });
    document.documentElement.appendChild(hoverBox);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }
  function stopPicking() {
    picking = null;
    if (root) root.getElementById("ebPickNote").style.display = "none";
    if (hoverBox) { hoverBox.remove(); hoverBox = null; }
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
  }
  const insidePanel = (el) => host && (el === host || host.contains(el));
  function onMove(e) {
    if (!picking || insidePanel(e.target)) { if (hoverBox) hoverBox.style.display = "none"; return; }
    const r = e.target.getBoundingClientRect();
    Object.assign(hoverBox.style, {
      display: "block", top: r.top - 2 + "px", left: r.left - 2 + "px",
      width: r.width + "px", height: r.height + "px",
    });
  }
  function onClick(e) {
    if (!picking || insidePanel(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const cb = picking.onPick;
    const target = S() ? S().capture(e.target) : null;
    stopPicking();
    cb(target, e.target);
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); stopPicking(); hideForm(); }
  }

  /* ---------------- forms ---------------- */
  function hideForm() {
    if (root) root.getElementById("ebForm").innerHTML = "";
  }
  function showForm(title, fieldsHtml, onOk, okLabel) {
    const wrap = root.getElementById("ebForm");
    wrap.innerHTML = `
      <div class="form">
        <h4>${title}</h4>
        ${fieldsHtml}
        <div class="row">
          <button class="ok" id="ebFormOk">${okLabel || T("formAdd")}</button>
          <button class="no" id="ebFormNo">${T("formCancel")}</button>
        </div>
      </div>`;
    wrap.querySelector("#ebFormOk").addEventListener("click", () => onOk(wrap));
    wrap.querySelector("#ebFormNo").addEventListener("click", hideForm);
  }
  const optionalHtml = () => `
    <label class="check"><input type="checkbox" id="fOptional"> ${T("optional")}</label>`;

  /* ---------------- add steps ---------------- */
  function addStep(step) {
    draft.steps.push(step);
    saveDraft();
    renderSteps();
    hideForm();
  }

  function handleAdd(type) {
    hideForm();
    if (type === "open_url") {
      addStep({ type: "open_url", url: location.href });
    } else if (type === "click") {
      startPicking((target, el) => {
        if (!target) return;
        const guess = (el.innerText || el.value || "").trim().slice(0, 30);
        showForm(T("clickTitle"), `
          <label>${T("labelLabel")}</label>
          <input type="text" id="fLabel" value="">
          ${optionalHtml()}
          <label class="check"><input type="checkbox" id="fExit"> ${T("exitLabel")}</label>`,
          (wrap) => addStep({
            type: "click", target,
            label: wrap.querySelector("#fLabel").value.trim() || guess || T("defClick"),
            optional: wrap.querySelector("#fOptional").checked,
            exitLoopOnMissing: wrap.querySelector("#fExit").checked,
          }));
        root.getElementById("ebForm").querySelector("#fLabel").value = guess;
      });
    } else if (type === "type") {
      startPicking((target) => {
        if (!target) return;
        showForm(T("typeTitle"), `
          <label>${T("typeValue")}</label>
          <textarea id="fValue" rows="2"></textarea>
          <label>${T("labelLabel")}</label>
          <input type="text" id="fLabel" placeholder="${T("typeLabelPh")}">
          <label class="check"><input type="checkbox" id="fPass"> ${T("isPass")}</label>
          <label class="check"><input type="checkbox" id="fEnter"> ${T("pressEnter")}</label>
          ${optionalHtml()}`,
          (wrap) => addStep({
            type: "type", target,
            value: wrap.querySelector("#fValue").value,
            label: wrap.querySelector("#fLabel").value.trim() || T("defType"),
            isPassword: wrap.querySelector("#fPass").checked,
            pressEnter: wrap.querySelector("#fEnter").checked,
            optional: wrap.querySelector("#fOptional").checked,
          }));
      });
    } else if (type === "extract") {
      startPicking((target) => {
        if (!target) return;
        showForm(T("extractTitle"), `
          <label style="margin-top:0">${T("extractNote")}</label>
          ${optionalHtml()}`,
          (wrap) => addStep({
            type: "extract", target,
            optional: wrap.querySelector("#fOptional").checked,
          }));
      });
    } else if (type === "ask_ai") {
      addStep({ type: "ask_ai" });
    } else if (type === "choose_answer") {
      startPicking((target) => {
        if (!target) return;
        addStep({ type: "choose_answer", target });
      });
    } else if (type === "wait") {
      showForm(T("waitTitle"), `
        <label>${T("waitMs")}</label>
        <input type="number" id="fMs" value="1500" min="100" step="100">`,
        (wrap) => addStep({ type: "wait", ms: Math.max(100, parseInt(wrap.querySelector("#fMs").value, 10) || 1500) }));
    } else if (type === "loop_start") {
      showForm(T("loopTitle"), `
        <label>${T("loopMax")}</label>
        <input type="number" id="fMax" min="1" placeholder="${T("loopPh")}">`,
        (wrap) => {
          const v = parseInt(wrap.querySelector("#fMax").value, 10);
          addStep({ type: "loop_start", maxIterations: v > 0 ? v : undefined });
        });
    } else if (type === "batch") {
      showForm(T("batchTitle"), `
        <label style="margin-top:0">${T("batchCount")}</label>
        <input type="number" id="fCount" value="10" min="1">
        <label>${T("batchFormat")}</label>
        <textarea id="fFmt" rows="3" placeholder="${T("batchFormatPh")}"></textarea>
        <p class="mini-note">${T("batchNote")}</p>`,
        (wrap) => {
          const n = Math.max(1, parseInt(wrap.querySelector("#fCount").value, 10) || 10);
          draft.questionFormat = wrap.querySelector("#fFmt").value.trim();
          applyBatch(n);
          saveDraft();
          renderSteps();
          hideForm();
        }, T("formApply"));
      root.getElementById("ebForm").querySelector("#fFmt").value = draft.questionFormat || "";
    } else if (type === "loop_end") {
      addStep({ type: "loop_end" });
    } else if (type === "restart_point") {
      addStep({ type: "restart_point" });
    } else if (type === "confirm_restart") {
      showForm(T("confirmTitle"), `
        <label>${T("confirmMsgLabel")}</label>
        <input type="text" id="fMsg" value="${T("confirmDefault")}">`,
        (wrap) => addStep({ type: "confirm_restart", message: wrap.querySelector("#fMsg").value.trim() || T("confirmFallback") }));
    }
  }

  function applyBatch(n) {
    const ls = draft.steps.find((s) => s.type === "loop_start");
    if (ls) {
      ls.maxIterations = n;
      if (!draft.steps.some((s) => s.type === "loop_end")) draft.steps.push({ type: "loop_end" });
      return;
    }
    let start = draft.steps.findIndex((s) => ["extract", "ask_ai", "choose_answer"].includes(s.type));
    if (start === -1) {
      const rp = draft.steps.map((s) => s.type).lastIndexOf("restart_point");
      if (rp >= 0) start = rp + 1;
      else start = draft.steps.length && draft.steps[0].type === "open_url" ? 1 : 0;
    }
    draft.steps.splice(start, 0, { type: "loop_start", maxIterations: n });
    draft.steps.push({ type: "loop_end" });
  }

  /* ---------------- render ---------------- */
  function stepText(s) {
    const icon = STEP_ICONS[s.type] || "•";
    const label = T("st")[s.type] || s.type;
    let extra = "";
    if (s.type === "click" || s.type === "type") extra = s.label ? ` — ${s.label}` : "";
    else if (s.type === "open_url") { try { extra = " — " + new URL(s.url).hostname; } catch {} }
    else if (s.type === "wait") extra = ` — ${s.ms}ms`;
    else if (s.type === "loop_start" && s.maxIterations) extra = T("loopTimes")(s.maxIterations);
    return `${icon} ${label}${extra}`;
  }
  function renderSteps() {
    const box = root.getElementById("ebSteps");
    const empty = root.getElementById("ebEmpty");
    box.innerHTML = "";
    empty.style.display = draft.steps.length ? "none" : "block";
    draft.steps.forEach((s, i) => {
      const div = document.createElement("div");
      div.className = "step";
      const optBadge = s.optional ? `<span class="opt">${T("optBadge")}</span>` : "";
      div.innerHTML = `<span class="n">${i + 1}</span><span class="t"></span>${optBadge}<button title="${T("remove")}">✕</button>`;
      div.querySelector(".t").textContent = stepText(s);
      div.querySelector("button").addEventListener("click", () => {
        draft.steps.splice(i, 1);
        saveDraft();
        renderSteps();
      });
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  }

  /* ---------------- panel ---------------- */
  function buildPanel() {
    if (host) return;
    host = document.createElement("div");
    host.id = "__hb_recorder_host";
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = panelCss();
    root.appendChild(style);
    const tpl = document.createElement("div");
    tpl.innerHTML = panelHtml();
    root.appendChild(tpl.firstElementChild);
    document.documentElement.appendChild(host);

    root.getElementById("ebName").textContent = draft.name;
    root.querySelectorAll("[data-add]").forEach((b) =>
      b.addEventListener("click", () => handleAdd(b.dataset.add))
    );
    root.getElementById("ebSave").addEventListener("click", async (ev) => {
      if (!draft.steps.length) { alert(T("alertNoSteps")); return; }
      const btn = ev.currentTarget;
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Saving\u2026";

      // Persist the draft, but never block the save on it.
      saveDraft();

      const res = await sendBg({
        cmd: "recorder:save",
        name: draft.name,
        steps: draft.steps,
        questionFormat: draft.questionFormat || "",
        macro: { name: draft.name, steps: draft.steps, questionFormat: draft.questionFormat || "" },
      });

      if (!res || !res.ok) {
        btn.disabled = false;
        btn.textContent = label;
        alert(
          "The macro could not be saved:\n\n" +
            ((res && res.error) || "The extension background did not respond.") +
            "\n\nYour steps are still here \u2014 press Save again, or reload the extension and retry.",
        );
        return;
      }

      teardown();
    });
    root.getElementById("ebCancel").addEventListener("click", async () => {
      sendBg({ cmd: "recorder:cancel" });
      teardown();
    });

    /* drag */
    const hd = root.getElementById("ebHd");
    const panel = root.querySelector(".panel");
    let drag = null;
    hd.addEventListener("mousedown", (e) => {
      const r = panel.getBoundingClientRect();
      panel.style.left = r.left + "px";
      panel.style.top = r.top + "px";
      panel.style.right = "auto";
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!drag) return;
      panel.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.dx)) + "px";
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy)) + "px";
    });
    document.addEventListener("mouseup", () => (drag = null));

    renderSteps();
  }

  function teardown() {
    stopPicking();
    draft = { recording: false, name: "", steps: [] };
    storageSet({ [DRAFT_KEY]: null });
    if (host) { host.remove(); host = null; root = null; }
  }

  async function openRecorder(name) {
    draft = { recording: true, name: name || T("defMacroName"), steps: [], questionFormat: "" };
    saveDraft(); // fire and forget: the panel must open even if storage is slow
    buildPanel();
  }

  /* ---------------- messaging & boot ---------------- */
  B.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!msg || !msg.cmd) return;
    if (msg.cmd === "recorder:start") {
      openRecorder(msg.name);
      sendResponse({ ok: true });
    } else if (msg.cmd === "recorder:stop") {
      teardown();
      sendResponse({ ok: true });
    }
  });

  /* re-open panel after page navigation while recording */
  (async () => {
    try {
      const v = await storageGet(DRAFT_KEY);
      const d = v[DRAFT_KEY];
      if (d && d.recording) {
        draft = d;
        buildPanel();
      }
    } catch {}
  })();

  window.__fmRecorder = { openRecorder, teardown };
})();

/* Huckleberry — sidebar controller (v0.3.1) */
"use strict";

const B = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const send = (msg) =>
  new Promise((resolve) => {
    try {
      const p = B.runtime.sendMessage(msg);
      if (p && typeof p.then === "function") p.then(resolve, () => resolve(null));
    } catch (e) {
      resolve(null);
    }
  });
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clock = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
};

let macros = [];
let settings = null;
let startedAt = 0;
let elapsedTimer = null;

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(text, kind = "") {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast " + kind), 3200);
}

/* ---------------- tabs ---------------- */
function showTab(name) {
  for (const t of document.querySelectorAll(".tab")) {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    if (on) t.classList.remove("attention");
  }
  for (const p of document.querySelectorAll(".panel")) p.classList.toggle("active", p.id === "panel-" + name);
  if (name === "history") loadHistory();
}
$("tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) showTab(tab.dataset.tab);
});
function flagRunTab() {
  const tab = document.querySelector('.tab[data-tab="run"]');
  if (tab && !tab.classList.contains("active")) tab.classList.add("attention");
}

/* ---------------- settings chip ---------------- */
async function loadSettings() {
  const res = await send({ cmd: "settings:get" });
  if (!res || !res.settings) return;
  settings = res.settings;
  if (res.version) $("verChip").textContent = "v" + res.version;
  let label;
  if (settings.aiMode === "tab") {
    label = settings.tabProvider === "chatgpt" ? "ChatGPT tab" : "Gemini tab";
  } else {
    const p = (settings.providers || []).find((x) => x.id === settings.activeProviderId);
    label = p ? p.label : "no provider";
    if (p && !p.apiKey && !p.keyOptional) label += " · no key";
  }
  $("aiChip").textContent = label;
}

/* ---------------- macros ---------------- */
const MACRO_ICON = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h9"></path><path d="M4 12h16"></path><path d="M4 18.5h7"></path><circle cx="17.5" cy="5.5" r="2.5"></circle></svg>`;

function renderMacros() {
  const host = $("macroList");
  if (!macros.length) {
    host.innerHTML =
      '<div class="empty"><div class="empty-orb"></div>No macros yet.<br>Record your first one above.</div>';
    return;
  }
  // One compact row per macro: name + step count, a small Run button, and
  // icon-only actions. Everything stays on a single line in a narrow sidebar.
  host.innerHTML = macros
    .map(
      (m) => `
    <div class="macro" data-id="${esc(m.id)}">
      <span class="macro-ico" aria-hidden="true">${MACRO_ICON}</span>
      <div class="macro-main">
        <div class="macro-name" title="${esc(m.name)}">${esc(m.name)}</div>
        <div class="macro-meta">${(m.steps || []).length} steps${m.createdAt ? " · " + new Date(m.createdAt).toLocaleDateString() : ""}</div>
      </div>
      <div class="macro-actions">
        <button class="btn btn-primary btn-run" data-act="run" title="Run this macro">
          <svg class="icon-xs" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8z"></path></svg>Run
        </button>
        <button class="act" data-act="questions" title="Questions only — skip the intro steps" aria-label="Questions only">
          <svg class="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 9a2.5 2.5 0 1 1 3.6 2.3c-.7.4-1.1 1-1.1 1.7v.5"></path><path d="M12 17h.01"></path></svg>
        </button>
        <button class="act" data-act="rename" title="Rename" aria-label="Rename">
          <svg class="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"></path></svg>
        </button>
        <button class="act" data-act="duplicate" title="Duplicate" aria-label="Duplicate">
          <svg class="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h8"></path></svg>
        </button>
        <button class="act danger" data-act="delete" title="Delete" aria-label="Delete">
          <svg class="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"></path><path d="M9 7V5h6v2"></path><path d="M7 7l1 12h8l1-12"></path></svg>
        </button>
      </div>
    </div>`,
    )
    .join("");
}

async function loadMacros() {
  const res = await send({ cmd: "macros:list" });
  if (!res || !res.ok) return;
  macros = res.macros || [];
  renderMacros();
  if (res.run) paintRun(res.run);
}

$("macroList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.closest(".macro").dataset.id;
  const macro = macros.find((m) => m.id === id);
  const act = btn.dataset.act;

  if (act === "run" || act === "questions") {
    btn.disabled = true;
    const res = await send({ cmd: "run:start", id, startFrom: act === "questions" ? "questions" : null });
    btn.disabled = false;
    if (!res || !res.ok) return toast((res && res.error) || "Could not start the run.", "err");
    showTab("run");
    addLog(`Starting "${macro ? macro.name : "macro"}"…`, "info");
    loadRun();
    return;
  }
  if (act === "rename") {
    const name = prompt("New name:", macro ? macro.name : "");
    if (name === null) return;
    await send({ cmd: "macros:rename", id, name });
    await loadMacros();
    toast("Renamed", "ok");
    return;
  }
  if (act === "duplicate") {
    await send({ cmd: "macros:duplicate", id });
    await loadMacros();
    toast("Duplicated", "ok");
    return;
  }
  if (act === "delete") {
    if (!confirm(`Delete "${macro ? macro.name : "this macro"}"?`)) return;
    await send({ cmd: "macros:delete", id });
    await loadMacros();
    toast("Deleted", "ok");
  }
});

/* ---------------- recording ---------------- */
$("btnRecord").addEventListener("click", async () => {
  const name = prompt("Name for this macro:", "Macro " + (macros.length + 1));
  if (name === null) return;
  const res = await send({ cmd: "record:start", name, url: $("recUrl").value });
  if (!res || !res.ok) return toast((res && res.error) || "Could not start recording.", "err");
  toast("Recorder opened on the page", "ok");
});

/* ---------------- export / import ---------------- */
$("btnExport").addEventListener("click", async () => {
  const res = await send({ cmd: "macros:export" });
  if (!res || !res.ok) return toast("Nothing to export.", "err");
  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `huckleberry-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("Backup downloaded", "ok");
});

$("btnImport").addEventListener("click", () => $("fileImport").click());
$("fileImport").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    // Send the raw text too: the background accepts every export shape.
    const res = await send({ cmd: "macros:import", data: JSON.parse(text), json: text });
    if (!res || !res.ok) throw new Error((res && res.error) || "Invalid file.");
    macros = res.macros || macros;
    renderMacros();
    await loadMacros();
    toast(`Imported ${res.count} macro${res.count === 1 ? "" : "s"} — saved`, "ok");
  } catch (err) {
    toast("Import failed: " + err.message, "err");
  }
});

/* ---------------- run panel ---------------- */
const STATUS_TEXT = {
  idle: "Idle",
  running: "Running…",
  assist: "Waiting for your answer",
  done: "Finished",
  stopped: "Stopped",
  error: "Failed",
};
const BADGE_CLASS = {
  idle: "idle",
  running: "",
  assist: "assist",
  done: "done",
  stopped: "idle",
  error: "error",
};

function paintRun(snap) {
  const status = snap.status || "idle";

  // Body classes drive the orb, the aurora and the scanline animations.
  document.body.classList.toggle("running", status === "running");
  document.body.classList.toggle("assist-state", status === "assist");
  document.body.classList.toggle("done-state", status === "done");
  document.body.classList.toggle("error-state", status === "error");

  const dotClass =
    status === "running" ? "dot dot-live" :
    status === "assist" ? "dot dot-wait" :
    status === "error" ? "dot dot-err" :
    status === "done" ? "dot dot-live" : "dot";
  $("statusDot").className = dotClass;
  $("statusTxt").textContent = STATUS_TEXT[status] || status;

  $("runBadge").textContent = status;
  $("runBadge").className = "badge " + (BADGE_CLASS[status] ?? "");
  $("runMacro").textContent = snap.macroName || "No run in progress";
  $("runCurrent").textContent =
    snap.current || (status === "idle" ? "Start a macro from the Macros tab." : STATUS_TEXT[status] || "");
  $("statAnswered").textContent = snap.answered || 0;
  $("statAssists").textContent = snap.assists || 0;
  $("btnStop").disabled = !(status === "running" || status === "assist");

  startedAt = snap.startedAt || 0;
  if (status === "running" || status === "assist") {
    if (!elapsedTimer) elapsedTimer = setInterval(tickElapsed, 1000);
  } else if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  tickElapsed();

  $("confirmBox").hidden = !snap.awaitingConfirm;
  if (snap.awaitingConfirm) $("confirmMsg").textContent = snap.confirmMessage || "";

  $("assistBox").hidden = !snap.awaitingAssist;
  if (snap.awaitingAssist) {
    $("assistReason").textContent = snap.assistReason ? "Reason: " + snap.assistReason : "";
    $("assistQuestion").textContent = snap.assistQuestion || "";
    flagRunTab();
  }

  if (Array.isArray(snap.logs)) {
    $("log").innerHTML = snap.logs.length
      ? snap.logs.map((l) => logLine(l.text, l.kind, l.t)).join("")
      : '<div class="log-empty">No activity yet.</div>';
    $("log").scrollTop = $("log").scrollHeight;
  }
}

function tickElapsed() {
  $("statElapsed").textContent = startedAt ? clock(Date.now() - startedAt) : "0:00";
}

function logLine(text, kind, t) {
  const time = new Date(t || Date.now()).toLocaleTimeString([], { hour12: false });
  return `<div class="log-line ${esc(kind || "info")}"><time>${esc(time)}</time><span>${esc(text)}</span></div>`;
}

function addLog(text, kind) {
  const host = $("log");
  const empty = host.querySelector(".log-empty");
  if (empty) empty.remove();
  host.insertAdjacentHTML("beforeend", logLine(text, kind));
  while (host.children.length > 400) host.removeChild(host.firstChild);
  host.scrollTop = host.scrollHeight;
}

async function loadRun() {
  const res = await send({ cmd: "run:state" });
  if (res && res.run) paintRun(res.run);
}

$("btnStop").addEventListener("click", async () => {
  await send({ cmd: "run:stop" });
  toast("Stop requested");
});
$("btnConfirmYes").addEventListener("click", () => send({ cmd: "run:confirm", yes: true }));
$("btnConfirmNo").addEventListener("click", () => send({ cmd: "run:confirm", yes: false }));
$("btnClearLog").addEventListener("click", () => {
  $("log").innerHTML = '<div class="log-empty">No activity yet.</div>';
});

async function sendManualAnswer() {
  const text = $("assistAnswer").value.trim();
  if (!text) return toast("Type the answer first.", "err");
  const res = await send({ cmd: "run:manualAnswer", text });
  if (!res || !res.ok) return toast((res && res.error) || "Could not submit the answer.", "err");
  $("assistAnswer").value = "";
  toast("Answer sent — resuming", "ok");
}
$("btnSendAnswer").addEventListener("click", sendManualAnswer);
$("assistAnswer").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendManualAnswer();
});
$("btnRetryAi").addEventListener("click", async () => {
  const res = await send({ cmd: "run:retryAi" });
  if (!res || !res.ok) return toast((res && res.error) || "Could not retry.", "err");
  toast("Asking the AI again…");
});

/* ---------------- history ---------------- */
async function loadHistory() {
  const res = await send({ cmd: "history:list" });
  const list = (res && res.history) || [];
  const host = $("historyList");
  if (!list.length) {
    host.innerHTML = '<div class="empty"><div class="empty-orb"></div>No runs recorded yet.</div>';
    return;
  }
  host.innerHTML = list
    .map((h) => {
      const chip = h.status === "done" ? "chip-green" : h.status === "error" ? "chip-red" : "chip-amber";
      const dot = h.status === "done" ? "dot-live" : h.status === "error" ? "dot-err" : "dot-wait";
      const mins = h.endedAt && h.startedAt ? clock(h.endedAt - h.startedAt) : "—";
      return `
      <div class="hist">
        <span class="dot ${dot}"></span>
        <div class="hist-main">
          <b>${esc(h.name || "Macro")}</b>
          <small>${new Date(h.startedAt).toLocaleString()} · ${h.answered || 0} answered · ${h.assists || 0} manual · ${mins}</small>
        </div>
        <span class="chip ${chip}">${esc(h.status)}</span>
      </div>`;
    })
    .join("");
}

$("btnClearHistory").addEventListener("click", async () => {
  if (!confirm("Clear the run history?")) return;
  await send({ cmd: "history:clear" });
  loadHistory();
});

/* ---------------- settings / about ---------------- */
function openOptions(hash) {
  try {
    const url = B.runtime.getURL("options/options.html") + (hash || "");
    B.tabs.create({ url });
  } catch (e) {
    try {
      B.runtime.openOptionsPage();
    } catch (e2) {}
  }
}
$("btnSettings").addEventListener("click", () => openOptions(""));
$("btnAbout").addEventListener("click", () => openOptions("#about"));

/* ---------------- live events ---------------- */
B.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.channel !== "hb-events") return;
  switch (msg.type) {
    case "log":
      addLog(msg.text, msg.kind);
      break;
    case "progress":
      $("runCurrent").textContent = msg.current || "";
      $("statAnswered").textContent = msg.answered || 0;
      break;
    case "stats":
      $("statAnswered").textContent = msg.answered || 0;
      if (msg.assists !== undefined) $("statAssists").textContent = msg.assists;
      break;
    case "confirm":
      $("confirmBox").hidden = false;
      $("confirmMsg").textContent = msg.message || "";
      flagRunTab();
      break;
    case "confirm-done":
      $("confirmBox").hidden = true;
      break;
    case "assist":
      $("assistBox").hidden = false;
      $("assistReason").textContent = msg.reason ? "Reason: " + msg.reason : "";
      $("assistQuestion").textContent = msg.question || "";
      document.body.classList.add("assist-state");
      showTab("run");
      $("assistAnswer").focus();
      break;
    case "assist-done":
      $("assistBox").hidden = true;
      document.body.classList.remove("assist-state");
      break;
    case "run":
      loadRun();
      break;
    case "macros-changed":
      loadMacros();
      break;
    case "history-changed":
      loadHistory();
      break;
    case "settings-changed":
      loadSettings();
      break;
  }
});

/* ---------------- boot ---------------- */
Promise.all([loadSettings(), loadMacros(), loadRun(), loadHistory()]);
setInterval(() => {
  if (document.visibilityState === "visible") loadRun();
}, 5000);

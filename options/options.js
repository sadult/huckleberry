/* Huckleberry — settings page controller (v0.3.1) */
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

let settings = null;
let presets = [];

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(text, kind = "") {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast " + kind), 3000);
}

function out(el, text, kind) {
  el.textContent = text;
  el.className = "test-out " + (kind || "");
}

/* ---------------- navigation ---------------- */
function showPage(name) {
  const known = document.getElementById("page-" + name);
  const target = known ? name : "providers";
  for (const b of document.querySelectorAll(".nav-item")) b.classList.toggle("active", b.dataset.tab === target);
  for (const p of document.querySelectorAll(".page")) p.classList.toggle("active", p.id === "page-" + target);
  if (location.hash !== "#" + target) history.replaceState(null, "", "#" + target);
}
$("navList").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-item");
  if (btn) showPage(btn.dataset.tab);
});
window.addEventListener("hashchange", () => showPage(location.hash.replace("#", "") || "providers"));

/* ---------------- saving ---------------- */
let saveTimer = null;
let pending = {};
function queueSave(patch) {
  Object.assign(pending, patch);
  Object.assign(settings, patch);
  clearTimeout(saveTimer);
  $("savedChip").textContent = "Saving…";
  saveTimer = setTimeout(async () => {
    const payload = pending;
    pending = {};
    const res = await send({ cmd: "settings:set", settings: payload });
    if (res && res.ok) {
      settings = res.settings;
      $("savedChip").textContent = "All changes saved";
    } else {
      $("savedChip").textContent = "Could not save";
      toast((res && res.error) || "Could not save the settings.", "err");
    }
  }, 420);
}

function bindInput(id, key, transform) {
  const el = $(id);
  if (!el) return;
  const event = el.type === "checkbox" ? "change" : "input";
  el.addEventListener(event, () => {
    const raw = el.type === "checkbox" ? el.checked : el.value;
    queueSave({ [key]: transform ? transform(raw) : raw });
  });
}
const num = (min, max, fallback) => (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/* ---------------- engine mode ---------------- */
function paintMode() {
  const mode = settings.aiMode === "tab" ? "tab" : "api";
  for (const b of document.querySelectorAll("#modeSeg .seg-btn")) b.classList.toggle("active", b.dataset.mode === mode);
  $("tabModeBox").hidden = mode !== "tab";
}
$("modeSeg").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  queueSave({ aiMode: btn.dataset.mode });
  paintMode();
});

/* ---------------- providers ---------------- */
// Maps a provider onto one of the brand gradients defined in options.css.
const BRANDS = [
  "gemini", "openai", "openrouter", "groq", "anthropic",
  "mistral", "deepseek", "cerebras", "together", "ollama",
];
function brandOf(p) {
  const hay = ((p.id || "") + " " + (p.label || "") + " " + (p.base || "")).toLowerCase();
  return BRANDS.find((b) => hay.includes(b)) || "custom";
}

function renderProviders() {
  const host = $("providerList");
  const list = settings.providers || [];
  if (!list.length) {
    host.innerHTML =
      '<div class="prov-empty"><b>No providers yet</b><span>Add one to answer questions through a real API such as Gemini.</span></div>';
    return;
  }
  host.innerHTML = list
    .map((p) => {
      const active = p.id === settings.activeProviderId;
      const hasKey = !!p.apiKey || p.keyOptional;
      const brand = brandOf(p);
      return `
      <div class="prov ${active ? "active" : ""}" data-id="${esc(p.id)}">
        <span class="prov-ico" data-brand="${esc(brand)}" aria-hidden="true">${esc(p.label.trim().charAt(0) || "?")}</span>
        <div class="prov-main">
          <div class="prov-name">
            ${esc(p.label)}
            ${active ? '<span class="chip chip-brand">active</span>' : ""}
            ${hasKey ? '<span class="chip chip-green">key set</span>' : '<span class="chip chip-amber">no key</span>'}
          </div>
          <div class="prov-meta">${esc(p.kind)} · ${esc(p.model || "default model")} · ${esc(p.base)}</div>
          <div class="test-out" data-out="${esc(p.id)}"></div>
        </div>
        <div class="prov-actions">
          ${active ? "" : '<button class="btn btn-sm" data-act="activate">Activate</button>'}
          <button class="btn btn-ghost btn-sm" data-act="test">Test</button>
          <button class="btn btn-ghost btn-sm" data-act="edit">Edit</button>
          <button class="btn btn-danger btn-sm" data-act="delete">${p.builtin ? "Clear key" : "Delete"}</button>
        </div>
      </div>`;
    })
    .join("");
}

$("providerList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const card = btn.closest(".prov");
  const id = card.dataset.id;
  const provider = (settings.providers || []).find((p) => p.id === id);
  const act = btn.dataset.act;

  if (act === "activate") {
    const res = await send({ cmd: "providers:activate", id });
    if (!res || !res.ok) return toast((res && res.error) || "Could not activate.", "err");
    settings.activeProviderId = res.activeProviderId;
    settings.aiMode = "api";
    renderProviders();
    paintMode();
    toast("Provider activated", "ok");
    return;
  }
  if (act === "test") {
    const target = card.querySelector("[data-out]");
    out(target, "Testing…", "busy");
    const res = await send({ cmd: "providers:test", id });
    if (res && res.ok) out(target, `✓ ${res.text || "connection ok"} (${res.ms} ms)`, "ok");
    else out(target, "✕ " + ((res && res.error) || "Test failed."), "err");
    return;
  }
  if (act === "edit") {
    openForm(provider);
    return;
  }
  if (act === "delete") {
    const msg = provider.builtin
      ? `Clear the stored key for "${provider.label}"?`
      : `Delete the provider "${provider.label}"?`;
    if (!confirm(msg)) return;
    const res = await send({ cmd: "providers:delete", id });
    if (!res || !res.ok) return toast((res && res.error) || "Could not delete.", "err");
    settings.providers = res.providers;
    settings.activeProviderId = res.activeProviderId;
    renderProviders();
    toast(res.reset ? "Key cleared" : "Provider deleted", "ok");
  }
});

/* ---------------- provider form ---------------- */
function fillPresetSelect() {
  $("pPreset").innerHTML =
    '<option value="">Custom / OpenAI-compatible…</option>' +
    presets.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("");
}

function openForm(provider) {
  const p = provider || null;
  $("formTitle").textContent = p ? "Edit “" + p.label + "”" : "Add a provider";
  $("pId").value = p ? p.id : "";
  $("pPreset").value = p && p.builtin ? p.id : "";
  $("pLabel").value = p ? p.label : "";
  $("pKind").value = p ? p.kind : "openai";
  $("pModel").value = p ? p.model || "" : "";
  $("pBase").value = p ? p.base : "";
  $("pKey").value = p ? p.apiKey || "" : "";
  $("pKey").type = "password";
  $("btnPeekKey").textContent = "Show";
  const preset = p ? presets.find((x) => x.id === p.id) : null;
  $("pKeyHint").innerHTML = preset && preset.keyUrl
    ? `Get a key: <a href="${esc(preset.keyUrl)}" target="_blank" rel="noreferrer">${esc(preset.keyUrl)}</a>`
    : "Stored locally in this browser profile only.";
  out($("formTestOut"), "", "");
  $("providerForm").hidden = false;
  $("providerForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("pLabel").focus();
}

function closeForm() {
  $("providerForm").hidden = true;
}

function formProvider() {
  return {
    id: $("pId").value || undefined,
    label: $("pLabel").value.trim(),
    kind: $("pKind").value,
    model: $("pModel").value.trim(),
    base: $("pBase").value.trim(),
    apiKey: $("pKey").value.trim(),
  };
}

$("btnAddProvider").addEventListener("click", () => openForm(null));
$("btnCancelForm").addEventListener("click", closeForm);

$("pPreset").addEventListener("change", () => {
  const preset = presets.find((p) => p.id === $("pPreset").value);
  if (!preset) return;
  const existing = (settings.providers || []).find((p) => p.id === preset.id);
  $("pId").value = preset.id;
  $("pLabel").value = preset.label;
  $("pKind").value = preset.kind;
  $("pModel").value = preset.model || "";
  $("pBase").value = preset.base;
  if (existing && existing.apiKey) $("pKey").value = existing.apiKey;
  $("pKeyHint").innerHTML = preset.keyUrl
    ? `Get a key: <a href="${esc(preset.keyUrl)}" target="_blank" rel="noreferrer">${esc(preset.keyUrl)}</a>` +
      (preset.note ? ` · ${esc(preset.note)}` : "")
    : esc(preset.note || "No API key required.");
});

$("btnPeekKey").addEventListener("click", () => {
  const el = $("pKey");
  const show = el.type === "password";
  el.type = show ? "text" : "password";
  $("btnPeekKey").textContent = show ? "Hide" : "Show";
});

$("btnSaveProvider").addEventListener("click", async () => {
  const res = await send({ cmd: "providers:save", provider: formProvider(), activate: !settings.activeProviderId });
  if (!res || !res.ok) return toast((res && res.error) || "Could not save the provider.", "err");
  settings.providers = res.providers;
  settings.activeProviderId = res.activeProviderId;
  renderProviders();
  closeForm();
  toast("Provider saved", "ok");
});

$("btnTestForm").addEventListener("click", async () => {
  const target = $("formTestOut");
  out(target, "Testing…", "busy");
  const res = await send({ cmd: "providers:test", provider: formProvider() });
  if (res && res.ok) out(target, `✓ ${res.text || "connection ok"} (${res.ms} ms)`, "ok");
  else out(target, "✕ " + ((res && res.error) || "Test failed."), "err");
});

/* ---------------- engine + telegram tests ---------------- */
$("btnTestEngine").addEventListener("click", async () => {
  const target = $("engineTestOut");
  out(target, "Testing the active engine…", "busy");
  const res = await send({ cmd: "test:ai" });
  if (res && res.ok) out(target, `✓ ${res.text || "connection ok"} (${res.ms} ms)`, "ok");
  else out(target, "✕ " + ((res && res.error) || "Test failed."), "err");
});

$("btnTestTelegram").addEventListener("click", async () => {
  const target = $("tgTestOut");
  out(target, "Sending…", "busy");
  const res = await send({
    cmd: "test:telegram",
    override: {
      telegramToken: $("telegramToken").value.trim(),
      telegramChatId: $("telegramChatId").value.trim(),
    },
  });
  if (res && res.ok) out(target, `✓ Message sent by @${res.bot}`, "ok");
  else out(target, "✕ " + ((res && res.error) || "Test failed."), "err");
});

/* ---------------- data tools ---------------- */
$("btnExportAll").addEventListener("click", async () => {
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

$("btnImportAll").addEventListener("click", () => $("fileImportAll").click());
$("fileImportAll").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const res = await send({ cmd: "macros:import", data });
    if (!res || !res.ok) throw new Error((res && res.error) || "Invalid file.");
    toast(`Imported ${res.count} macro${res.count === 1 ? "" : "s"}`, "ok");
  } catch (err) {
    toast("Import failed: " + err.message, "err");
  }
  e.target.value = "";
});

$("btnClearHistory").addEventListener("click", async () => {
  if (!confirm("Clear the run history?")) return;
  await send({ cmd: "history:clear" });
  toast("History cleared", "ok");
});

$("btnResetAll").addEventListener("click", async () => {
  if (!confirm("Erase all macros, settings, API keys and history from this browser?")) return;
  if (!confirm("This cannot be undone. Continue?")) return;
  try {
    await B.storage.local.clear();
  } catch (e) {}
  toast("Everything erased — reloading…", "ok");
  setTimeout(() => location.reload(), 900);
});

/* ---------------- paint ---------------- */
function paintSettings() {
  $("tabProvider").value = settings.tabProvider || "gemini";
  $("assistOnStall").checked = !!settings.assistOnStall;
  $("aiTimeoutMs").value = settings.aiTimeoutMs;
  $("aiRetries").value = settings.aiRetries;
  $("tabRecycleEvery").value = settings.tabRecycleEvery;
  $("stepDelayMs").value = settings.stepDelayMs;
  $("maxLoops").value = settings.maxLoops;
  $("memoryEnabled").checked = !!settings.memoryEnabled;
  $("questionnaireContext").value = settings.questionnaireContext || "";
  $("telegramEnabled").checked = !!settings.telegramEnabled;
  $("telegramToken").value = settings.telegramToken || "";
  $("telegramChatId").value = settings.telegramChatId || "";
  paintMode();
  renderProviders();
}

bindInput("tabProvider", "tabProvider");
bindInput("assistOnStall", "assistOnStall");
bindInput("aiTimeoutMs", "aiTimeoutMs", num(15000, 600000, 90000));
bindInput("aiRetries", "aiRetries", num(0, 5, 1));
bindInput("tabRecycleEvery", "tabRecycleEvery", num(0, 200, 5));
bindInput("stepDelayMs", "stepDelayMs", num(200, 20000, 900));
bindInput("maxLoops", "maxLoops", num(1, 5000, 100));
bindInput("memoryEnabled", "memoryEnabled");
bindInput("questionnaireContext", "questionnaireContext");
bindInput("telegramEnabled", "telegramEnabled");
bindInput("telegramToken", "telegramToken", (v) => String(v).trim());
bindInput("telegramChatId", "telegramChatId", (v) => String(v).trim());

/* ---------------- boot ---------------- */
(async function boot() {
  const res = await send({ cmd: "settings:get" });
  if (!res || !res.settings) {
    toast("Could not load the settings. Reload the extension.", "err");
    return;
  }
  settings = res.settings;
  presets = res.presets || [];
  if (res.version) {
    $("verLabel").textContent = "v" + res.version;
    $("aboutVersion").textContent = "v" + res.version;
  }
  fillPresetSelect();
  paintSettings();
  showPage(location.hash.replace("#", "") || "providers");
})();

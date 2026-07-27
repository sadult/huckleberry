/* Huckleberry — Background Orchestrator (v0.3.1)
 * Engine: macro storage, run engine, multi-provider AI routing, questionnaire
 * memory, run history, Telegram remote control, stall detection + manual assist.
 * Runs on Firefox (event page) and Chrome (service worker).
 */
"use strict";

const B = globalThis.browser ?? globalThis.chrome;
const VERSION = "0.3.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TG = (tok) => "https://api.telegram.org/bot" + tok;

/* ============================ Provider presets ============================
 * kind:
 *   "gemini"    -> Google Generative Language API (POST {base}/models/{model}:generateContent)
 *   "openai"    -> OpenAI-compatible Chat Completions (POST {base}/chat/completions)
 *   "anthropic" -> Anthropic Messages API (POST {base}/messages)
 */
const PRESETS = [
  { id: "gemini", label: "Google Gemini", kind: "gemini", base: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash", keyUrl: "https://aistudio.google.com/apikey", note: "Free tier in Google AI Studio." },
  { id: "openai", label: "OpenAI", kind: "openai", base: "https://api.openai.com/v1", model: "gpt-4o-mini", keyUrl: "https://platform.openai.com/api-keys", note: "Official ChatGPT API." },
  { id: "openrouter", label: "OpenRouter", kind: "openai", base: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", keyUrl: "https://openrouter.ai/keys", note: "One key, hundreds of models." },
  { id: "groq", label: "Groq", kind: "openai", base: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", keyUrl: "https://console.groq.com/keys", note: "Very fast, generous free tier." },
  { id: "anthropic", label: "Anthropic Claude", kind: "anthropic", base: "https://api.anthropic.com/v1", model: "claude-3-5-haiku-latest", keyUrl: "https://console.anthropic.com/settings/keys", note: "Claude Messages API." },
  { id: "mistral", label: "Mistral AI", kind: "openai", base: "https://api.mistral.ai/v1", model: "mistral-small-latest", keyUrl: "https://console.mistral.ai/api-keys", note: "European models, free tier." },
  { id: "deepseek", label: "DeepSeek", kind: "openai", base: "https://api.deepseek.com/v1", model: "deepseek-chat", keyUrl: "https://platform.deepseek.com/api_keys", note: "Low cost, strong reasoning." },
  { id: "cerebras", label: "Cerebras", kind: "openai", base: "https://api.cerebras.ai/v1", model: "llama-3.3-70b", keyUrl: "https://cloud.cerebras.ai", note: "Fastest tokens per second." },
  { id: "together", label: "Together AI", kind: "openai", base: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", keyUrl: "https://api.together.ai/settings/api-keys", note: "Open models at scale." },
  { id: "ollama", label: "Ollama (local)", kind: "openai", base: "http://localhost:11434/v1", model: "llama3.1", keyUrl: "https://ollama.com", note: "Runs on your machine, no key needed.", keyOptional: true },
];

function defaultProviders() {
  return PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    base: p.base,
    model: p.model,
    apiKey: "",
    builtin: true,
    keyOptional: !!p.keyOptional,
  }));
}

/* ============================ Storage ============================ */
const store = {
  async get(key, fallback) {
    const o = await B.storage.local.get(key);
    return o[key] ?? fallback;
  },
  async set(key, value) {
    await B.storage.local.set({ [key]: value });
  },
};

const DEFAULT_SETTINGS = {
  aiMode: "api", // "api" | "tab"
  tabProvider: "gemini", // browser-tab mode target: "gemini" | "chatgpt"
  activeProviderId: "gemini",
  providers: defaultProviders(),
  memoryEnabled: true,
  questionnaireContext: "",
  telegramEnabled: false,
  telegramToken: "",
  telegramChatId: "",
  stepDelayMs: 900,
  maxLoops: 100,
  aiTimeoutMs: 90000, // per-question ceiling before a stall is declared
  aiRetries: 1, // automatic retries (with a tab refresh) before asking you
  tabRecycleEvery: 5, // browser-tab mode: start a fresh chat every N questions
  assistOnStall: true, // pause and ask you instead of failing the run
};

/* Merge stored settings with defaults, and migrate pre-0.3 layouts. */
function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  delete s.language;

  const stored = Array.isArray(s.providers) ? s.providers : [];
  const merged = [];
  for (const preset of defaultProviders()) {
    const found = stored.find((p) => p && p.id === preset.id);
    merged.push(found ? { ...preset, ...found, builtin: true, kind: found.kind || preset.kind } : preset);
  }
  for (const p of stored) {
    if (!p || !p.id || merged.some((m) => m.id === p.id)) continue;
    merged.push({ ...p, builtin: false });
  }

  // Migration from v3.x flat keys.
  const legacy = [
    ["gemini", "geminiApiKey", "geminiModel"],
    ["openai", "openaiApiKey", "openaiModel"],
    ["openrouter", "openrouterApiKey", "openrouterModel"],
    ["groq", "groqApiKey", "groqModel"],
  ];
  for (const [id, keyField, modelField] of legacy) {
    const target = merged.find((p) => p.id === id);
    if (target) {
      if (!target.apiKey && raw && raw[keyField]) target.apiKey = raw[keyField];
      if (raw && raw[modelField]) target.model = raw[modelField] || target.model;
    }
    delete s[keyField];
    delete s[modelField];
  }
  if (raw && raw.customApiKey && raw.customBaseUrl && !merged.some((p) => p.id === "legacy-custom")) {
    merged.push({
      id: "legacy-custom",
      label: "Custom (imported)",
      kind: "openai",
      base: String(raw.customBaseUrl).replace(/\/+$/, ""),
      model: raw.customModel || "",
      apiKey: raw.customApiKey,
      builtin: false,
    });
  }
  delete s.customApiKey;
  delete s.customModel;
  delete s.customBaseUrl;

  if (raw && raw.manualProvider && !raw.tabProvider) s.tabProvider = raw.manualProvider === "chatgpt" ? "chatgpt" : "gemini";
  delete s.manualProvider;
  if (s.aiMode === "manual") s.aiMode = "tab";

  s.providers = merged;
  if (!merged.some((p) => p.id === s.activeProviderId)) s.activeProviderId = merged[0] ? merged[0].id : "gemini";
  s.aiTimeoutMs = Math.max(15000, Number(s.aiTimeoutMs) || 90000);
  s.aiRetries = Math.max(0, Math.min(5, Number(s.aiRetries) ?? 1));
  s.tabRecycleEvery = Math.max(0, Math.min(50, Number(s.tabRecycleEvery) ?? 5));
  s.stepDelayMs = Math.max(200, Number(s.stepDelayMs) || 900);
  s.maxLoops = Math.max(1, Number(s.maxLoops) || 100);
  return s;
}

async function getSettings() {
  return normalizeSettings(await store.get("settings", {}));
}
async function saveSettings(next) {
  const s = normalizeSettings(next);
  await store.set("settings", s);
  return s;
}
function activeProvider(s) {
  return s.providers.find((p) => p.id === s.activeProviderId) || s.providers[0] || null;
}
function aiLabel(s) {
  if (s.aiMode === "tab") return s.tabProvider === "chatgpt" ? "ChatGPT tab" : "Gemini tab";
  const p = activeProvider(s);
  return p ? `${p.label} · ${p.model}` : "no provider";
}

/* ============================ Run state ============================ */
let run = null;

function broadcast(msg) {
  try {
    const p = B.runtime.sendMessage({ channel: "hb-events", ...msg });
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}
function log(text, kind = "info") {
  if (run) {
    run.logs.push({ t: Date.now(), text, kind });
    if (run.logs.length > 300) run.logs.shift();
  }
  broadcast({ type: "log", text, kind });
}
function runSnapshot() {
  if (!run) return { status: "idle", logs: [], answered: 0, assists: 0, startedAt: 0, current: "" };
  return {
    status: run.status,
    macroName: run.macro?.name,
    logs: run.logs.slice(-60),
    awaitingConfirm: !!run.confirmResolve,
    confirmMessage: run.confirmMessage || "",
    awaitingAssist: !!run.assistResolve,
    assistQuestion: run.assistQuestion || "",
    assistReason: run.assistReason || "",
    current: run.current || "",
    answered: run.answered || 0,
    assists: run.assists || 0,
    startedAt: run.startedAt || 0,
  };
}
function notify(id, title, message) {
  try {
    B.notifications.create(id, {
      type: "basic",
      iconUrl: B.runtime.getURL("icons/icon128.png"),
      title,
      message,
    });
  } catch (e) {}
}

/* ============================ Tab helpers ============================ */
async function tabCall(tabId, payload, { retries = 20, delay = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    if (run && run.stop) throw new Error("stopped");
    try {
      const res = await B.tabs.sendMessage(tabId, payload);
      if (res !== undefined) return res;
    } catch (e) {
      lastErr = e;
    }
    await sleep(delay);
  }
  throw new Error("Could not reach the page (" + (lastErr?.message || "timeout") + ")");
}

function waitForLoad(tabId, timeout = 35000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        B.tabs.onUpdated.removeListener(listener);
      } catch (e) {}
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    B.tabs.onUpdated.addListener(listener);
    B.tabs
      .get(tabId)
      .then((t) => {
        if (t && t.status === "complete") setTimeout(finish, 300);
      })
      .catch(finish);
    setTimeout(finish, timeout);
  });
}

async function settleTab(tabId) {
  const s = run?.settings || (await getSettings());
  await sleep(s.stepDelayMs);
  try {
    const t = await B.tabs.get(tabId);
    if (t.status === "loading") {
      await waitForLoad(tabId);
      await sleep(600);
    }
  } catch (e) {}
}

/* ============================ Prompt ============================ */
function buildPrompt(question, s, fmt) {
  let ctx = "";
  if (s.memoryEnabled && (s.questionnaireContext || "").trim()) {
    ctx += "Persistent context for this questionnaire — always take it into account:\n" + s.questionnaireContext.trim() + "\n\n";
  }
  if ((fmt || "").trim()) {
    ctx += "Question format described by the user — every question follows it:\n" + fmt.trim() + "\n\n";
  }
  return (
    ctx +
    "This is a question from a practice questionnaire. Pick the correct option.\n" +
    "Reply with the exact text of the correct option and nothing else: no explanation, no preamble, no quotes.\n" +
    "If the options are numbered, reply with the option text only, not its number.\n\n" +
    "Question:\n" +
    question
  );
}

/* ============================ API providers ============================ */
async function fetchJson(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(5000, timeoutMs || 60000));
  let res;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === "AbortError") throw new Error("Request timed out");
    throw new Error("Network error: " + (e?.message || "request failed"));
  }
  clearTimeout(timer);
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (e) {}
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || (raw || "").slice(0, 200);
    throw new Error(`HTTP ${res.status}${detail ? " — " + detail : ""}`);
  }
  return data;
}

function requireProvider(provider) {
  if (!provider) throw new Error("No AI provider selected — open Settings → Providers.");
  const base = String(provider.base || "").replace(/\/+$/, "");
  if (!base) throw new Error(`${provider.label}: base URL is missing.`);
  if (!provider.model) throw new Error(`${provider.label}: model name is missing.`);
  if (!provider.apiKey && !provider.keyOptional) throw new Error(`${provider.label}: API key is missing.`);
  return base;
}

async function askApi(prompt, provider, timeoutMs) {
  const base = requireProvider(provider);
  const kind = provider.kind || "openai";

  if (kind === "gemini") {
    const data = await fetchJson(
      `${base}/models/${encodeURIComponent(provider.model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": provider.apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
        }),
      },
      timeoutMs
    );
    const cand = data?.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || "").join("").trim();
    if (!text) {
      const why = data?.promptFeedback?.blockReason || cand?.finishReason;
      throw new Error("Empty reply from Gemini" + (why ? ` (${why})` : ""));
    }
    return text;
  }

  if (kind === "anthropic") {
    const data = await fetchJson(
      `${base}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": provider.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: 1024,
          temperature: 0.1,
          messages: [{ role: "user", content: prompt }],
        }),
      },
      timeoutMs
    );
    const text = (data?.content || []).map((c) => c.text || "").join("").trim();
    if (!text) throw new Error("Empty reply from Claude");
    return text;
  }

  // OpenAI-compatible chat completions
  const headers = { "Content-Type": "application/json" };
  if (provider.apiKey) headers.Authorization = "Bearer " + provider.apiKey;
  if (/openrouter\.ai/.test(base)) {
    headers["HTTP-Referer"] = "https://github.com/themersad/huckleberry";
    headers["X-Title"] = "Huckleberry";
  }
  const data = await fetchJson(
    `${base}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.1,
        max_tokens: 1024,
        messages: [
          { role: "system", content: "You solve practice questionnaires. Reply with the exact text of the correct option only, with no extra words." },
          { role: "user", content: prompt },
        ],
      }),
    },
    timeoutMs
  );
  const text = (data?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error(`Empty reply from ${provider.label || "the provider"}`);
  return text;
}

/* ============================ Browser-tab mode (no API key) ============================ */
const TAB_TARGETS = {
  gemini: { label: "Gemini tab", url: "https://gemini.google.com/app", match: ["*://gemini.google.com/*"], script: "ai/gemini.js" },
  chatgpt: { label: "ChatGPT tab", url: "https://chatgpt.com/", match: ["*://chatgpt.com/*", "*://chat.openai.com/*"], script: "ai/chatgpt.js" },
};
const tabTarget = (s) => TAB_TARGETS[s.tabProvider === "chatgpt" ? "chatgpt" : "gemini"];
const tabPending = new Map();

async function findOrCreateAiTab(target) {
  for (const pattern of target.match) {
    try {
      const tabs = await B.tabs.query({ url: pattern });
      if (tabs && tabs[0]) return tabs[0];
    } catch (e) {}
  }
  const tab = await B.tabs.create({ url: target.url, active: false });
  await waitForLoad(tab.id, 45000);
  await sleep(3500);
  return tab;
}

/* Long chats are the #1 cause of "it stops answering after 6-7 questions":
 * the conversation grows, the page throttles, and the composer stops accepting
 * new turns. Periodically starting a fresh chat keeps the tab healthy. */
async function recycleAiTab(target, why) {
  try {
    const tab = await findOrCreateAiTab(target);
    log("Starting a fresh " + target.label + (why ? " (" + why + ")" : "") + "…", "warn");
    await B.tabs.update(tab.id, { url: target.url });
    await waitForLoad(tab.id, 45000);
    await sleep(3000);
    try {
      await B.scripting.executeScript({ target: { tabId: tab.id }, files: [target.script] });
    } catch (e) {}
    if (run) run.tabAsks = 0;
    return tab;
  } catch (e) {
    log("Could not refresh the " + target.label + ": " + e.message, "warn");
    return null;
  }
}

/* Ask through a logged-in AI tab.
 * Protocol: the bridge ACKs immediately, then delivers the answer through
 * storage (durable) plus an "ai:result" message (fast). The background polls,
 * which also keeps the MV3 worker alive for the whole wait. */
async function askTab(prompt, s, timeoutMs) {
  const target = tabTarget(s);
  const tab = await findOrCreateAiTab(target);
  log("Sending the question to the " + target.label + "…");

  const reqId = "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  let resolveResult;
  const resultPromise = new Promise((r) => {
    resolveResult = r;
  });
  tabPending.set(reqId, resolveResult);
  try {
    await B.storage.local.remove("hbAiResult");
  } catch (e) {}

  try {
    let ack = null;
    try {
      ack = await tabCall(tab.id, { cmd: "ai:ask", reqId, prompt }, { retries: 4, delay: 700 });
    } catch (e) {
      ack = null;
    }
    if (!ack) {
      try {
        await B.scripting.executeScript({ target: { tabId: tab.id }, files: [target.script] });
      } catch (e) {}
      await sleep(700);
      ack = await tabCall(tab.id, { cmd: "ai:ask", reqId, prompt }, { retries: 10, delay: 800 });
    }
    if (!ack || !ack.ok) throw new Error(ack?.error || `Could not reach the ${target.label} — make sure you are logged in there.`);
    if (typeof ack.text === "string" && !ack.accepted) return ack.text; // legacy bridge

    const budget = Math.max(20000, timeoutMs || 90000);
    const deadline = Date.now() + budget;
    for (;;) {
      if (run && run.stop) throw new Error("stopped");
      let res = await Promise.race([resultPromise, sleep(800).then(() => null)]);
      if (!res) {
        try {
          const stored = await store.get("hbAiResult", null);
          if (stored && stored.reqId === reqId) res = stored;
        } catch (e) {}
      }
      if (res) {
        try {
          await B.storage.local.remove("hbAiResult");
        } catch (e) {}
        if (!res.ok) throw new Error(res.error || `No answer from the ${target.label}.`);
        return res.text;
      }
      if (Date.now() > deadline) {
        throw new Error(`The ${target.label} stopped responding (no reply within ${Math.round(budget / 1000)}s).`);
      }
    }
  } finally {
    tabPending.delete(reqId);
  }
}

async function askOnce(question, s, fmt, timeoutMs) {
  const prompt = buildPrompt(question, s, fmt);
  if (s.aiMode === "tab") return await askTab(prompt, s, timeoutMs);
  return await askApi(prompt, activeProvider(s), timeoutMs);
}

/* ============================ Stall detection + manual assist ============================
 * Real-world failure this solves: in browser-tab mode the AI chat stops replying
 * after a handful of questions. Instead of dying, Huckleberry:
 *   1. refreshes the AI chat and retries automatically,
 *   2. if it still fails, pauses and asks you for that one answer,
 *   3. applies your answer and resumes the remaining questions on its own.
 */
async function waitAssist(question, reason) {
  run.status = "assist";
  run.assistQuestion = question;
  run.assistReason = reason;
  run.assists = (run.assists || 0) + 1;
  log("Paused — waiting for your answer. " + reason, "ask");
  broadcast({ type: "assist", question, reason, status: "assist" });
  notify("hb-assist", "Huckleberry needs you", "The AI stopped answering. Open the sidebar and type the answer for this question.");
  tgSend(
    "⚠️ The AI stopped answering.\n\nQuestion:\n" +
      String(question || "").slice(0, 900) +
      "\n\nSend the answer with:\n/answer <exact option text>\n/retry to try the AI again\n/stop to end the run"
  );

  const res = await new Promise((resolve) => {
    run.assistResolve = resolve;
  });
  run.assistResolve = null;
  run.assistQuestion = "";
  run.assistReason = "";
  run.status = "running";
  broadcast({ type: "assist-done", status: "running" });
  return res; // { action: "answer" | "retry" | "stop", text? }
}

/* Ask the AI with timeout, auto-retry, tab recycling and manual fallback. */
async function askQuestion(question, fmt) {
  const s = run.settings;
  const target = s.aiMode === "tab" ? tabTarget(s) : null;

  // Proactive hygiene: refresh the chat every N questions in tab mode.
  if (target && s.tabRecycleEvery > 0) {
    run.tabAsks = (run.tabAsks || 0) + 1;
    if (run.tabAsks > s.tabRecycleEvery) {
      await recycleAiTab(target, `chat hygiene after ${s.tabRecycleEvery} questions`);
      run.tabAsks = 1;
    }
  }

  const attempts = 1 + (s.aiRetries || 0);
  let lastError = null;

  for (;;) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (run.stop) throw new Error("stopped");
      try {
        const answer = await askOnce(question, s, fmt, s.aiTimeoutMs);
        const clean = String(answer || "").trim();
        if (!clean) throw new Error("The AI returned an empty answer.");
        // A repeated identical answer for a different question means the chat is
        // stuck on its previous turn.
        if (target && run.lastAnswer && clean === run.lastAnswer && question !== run.lastQuestion) {
          throw new Error("The AI repeated its previous answer — the chat looks stuck.");
        }
        run.lastAnswer = clean;
        run.lastQuestion = question;
        return clean;
      } catch (e) {
        if (run.stop || e.message === "stopped") throw e;
        lastError = e;
        log(`AI attempt ${attempt}/${attempts} failed: ${e.message}`, "warn");
        if (attempt < attempts) {
          if (target) await recycleAiTab(target, "recovering after a stall");
          else await sleep(1500);
        }
      }
    }

    if (!s.assistOnStall) throw lastError || new Error("The AI did not answer.");

    const res = await waitAssist(question, lastError ? lastError.message : "The AI did not answer.");
    if (!res || res.action === "stop") {
      run.stop = true;
      throw new Error("stopped");
    }
    if (res.action === "answer") {
      const manual = String(res.text || "").trim();
      if (manual) {
        log("Using your answer and resuming automatically.", "success");
        run.lastAnswer = manual;
        run.lastQuestion = question;
        if (target) await recycleAiTab(target, "fresh start before the next question");
        return manual;
      }
    }
    // "retry": refresh the chat and loop through the attempts again.
    if (target) await recycleAiTab(target, "manual retry");
    lastError = null;
  }
}

/* ============================ Telegram ============================ */
async function tgSend(text) {
  const s = run?.settings || (await getSettings());
  if (!s.telegramEnabled || !s.telegramToken || !s.telegramChatId) return;
  try {
    await fetch(TG(s.telegramToken) + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: s.telegramChatId, text }),
    });
  } catch (e) {}
}

let tgPolling = false;
async function tgPollLoop() {
  if (tgPolling) return;
  tgPolling = true;
  try {
    for (;;) {
      const s = await getSettings();
      if (!s.telegramEnabled || !s.telegramToken) break;
      const offset = await store.get("tgOffset", 0);
      let data = null;
      try {
        const res = await fetch(TG(s.telegramToken) + "/getUpdates?timeout=20&offset=" + (offset + 1));
        data = await res.json();
      } catch (e) {
        await sleep(6000);
        continue;
      }
      if (!data?.ok) {
        await sleep(8000);
        continue;
      }
      for (const u of data.result || []) {
        await store.set("tgOffset", u.update_id);
        try {
          await handleTgUpdate(u, s);
        } catch (e) {}
      }
    }
  } finally {
    tgPolling = false;
  }
}

async function handleTgUpdate(u, s) {
  const msg = u.message || u.edited_message;
  if (!msg || !msg.text) return;
  const chatId = String(msg.chat.id);
  if (s.telegramChatId && chatId !== String(s.telegramChatId)) return; // owner only
  const text = msg.text.trim();
  const reply = (t) =>
    fetch(TG(s.telegramToken) + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: t }),
    }).catch(() => {});

  if (/^\/(start|help)/.test(text)) {
    await reply(
      "Huckleberry — remote control\n\n" +
        "/list — list macros\n" +
        "/run 1 or /run <name> — run a macro\n" +
        "/skip 1 — run, jumping straight to the questions\n" +
        "/status — current status\n" +
        "/next — confirm and continue\n" +
        "/answer <text> — answer a stalled question\n" +
        "/retry — ask the AI again\n" +
        "/stop — stop the run"
    );
    return;
  }
  if (/^\/list/.test(text)) {
    const macros = await store.get("macros", []);
    if (!macros.length) return reply("No macros saved yet.");
    await reply("Macros:\n" + macros.map((m, i) => `${i + 1}. ${m.name} (${m.steps.length} steps)`).join("\n"));
    return;
  }
  if (/^\/status/.test(text)) {
    const snap = runSnapshot();
    await reply(
      snap.status === "idle"
        ? "Idle — no run in progress."
        : `Status: ${snap.status}\nMacro: ${snap.macroName || "-"}\nStep: ${snap.current || "-"}\nAnswered: ${snap.answered}` +
            (snap.awaitingAssist ? `\n\nWaiting for your answer:\n${snap.assistQuestion.slice(0, 600)}` : "")
    );
    return;
  }
  const answerMatch = text.match(/^\/answer\s+([\s\S]+)$/);
  if (answerMatch) {
    if (run && run.assistResolve) {
      run.assistResolve({ action: "answer", text: answerMatch[1].trim() });
      await reply("Got it — applying your answer and resuming.");
    } else await reply("Nothing is waiting for an answer right now.");
    return;
  }
  if (/^\/retry/.test(text)) {
    if (run && run.assistResolve) {
      run.assistResolve({ action: "retry" });
      await reply("Retrying with the AI…");
    } else await reply("Nothing is waiting for a retry right now.");
    return;
  }
  if (/^\/next/.test(text)) {
    if (run && run.confirmResolve) {
      run.confirmResolve(true);
      await reply("Continuing…");
    } else await reply("Nothing is waiting for confirmation.");
    return;
  }
  if (/^\/stop/.test(text)) {
    if (run && (run.status === "running" || run.confirmResolve || run.assistResolve)) {
      run.stop = true;
      if (run.confirmResolve) run.confirmResolve(false);
      if (run.assistResolve) run.assistResolve({ action: "stop" });
      await reply("Stop requested.");
    } else await reply("No run in progress.");
    return;
  }
  const runMatch = text.match(/^\/(run|skip)\s+(.+)$/);
  if (runMatch) {
    const macros = await store.get("macros", []);
    const key = runMatch[2].trim();
    const idx = parseInt(key, 10);
    let macro = null;
    if (!isNaN(idx) && macros[idx - 1]) macro = macros[idx - 1];
    else macro = macros.find((m) => m.name.toLowerCase().includes(key.toLowerCase()));
    if (!macro) return reply("Macro not found. Send /list to see them.");
    const startFrom = runMatch[1] === "skip" ? "questions" : null;
    await reply(`Starting "${macro.name}"${startFrom ? " (jumping to the questions)" : ""}…`);
    startRun(macro.id, { startFrom }).catch((e) => reply("Error: " + e.message));
    return;
  }
}

try {
  B.alarms.create("hb-tg", { periodInMinutes: 1 });
  B.alarms.onAlarm.addListener((a) => {
    if (a.name === "hb-tg") tgPollLoop();
  });
} catch (e) {}
tgPollLoop();

/* ============================ History ============================ */
async function pushHistory(entry) {
  const h = await store.get("history", []);
  h.unshift(entry);
  if (h.length > 60) h.length = 60;
  await store.set("history", h);
  broadcast({ type: "history-changed" });
}

/* ============================ Runner ============================ */
function findLoopEnd(steps, startIdx) {
  let depth = 0;
  for (let i = startIdx + 1; i < steps.length; i++) {
    if (steps[i].type === "loop_start") depth++;
    else if (steps[i].type === "loop_end") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return steps.length; // unterminated loop: run to the end of the macro
}

async function waitConfirm(message) {
  run.confirmMessage = message;
  log("Paused: " + message, "ask");
  broadcast({ type: "confirm", message });
  tgSend("Question: " + message + "\n\nContinue: /next\nFinish: /stop");
  notify("hb-confirm", "Huckleberry", message);
  const ok = await new Promise((res) => {
    run.confirmResolve = res;
  });
  run.confirmResolve = null;
  run.confirmMessage = "";
  broadcast({ type: "confirm-done" });
  return ok;
}

function missedStep(step, r, what) {
  if (step.exitLoopOnMissing) {
    log(what + " not found — leaving the loop", "warn");
    return "break";
  }
  if (step.optional) {
    log(what + " not found — optional step, skipped", "warn");
    return "skip";
  }
  throw new Error(r.error || what + " not found");
}

const STEP_LABELS = {
  open_url: "Open URL",
  click: "Click",
  type: "Type text",
  extract: "Extract question",
  ask_ai: "Ask the AI",
  choose_answer: "Choose answer",
  loop_start: "Loop start",
  loop_end: "Loop end",
  wait: "Wait",
  restart_point: "Question start point",
  confirm_restart: "Confirm and repeat",
};
function stepLabel(step) {
  return (STEP_LABELS[step.type] || step.type) + (step.label ? ": " + step.label : "");
}

async function execStep(step) {
  const t = run.tabId;
  run.current = stepLabel(step);
  broadcast({ type: "progress", current: run.current, answered: run.answered || 0 });

  switch (step.type) {
    case "open_url": {
      log("Opening " + step.url);
      await B.tabs.update(t, { url: step.url });
      await waitForLoad(t);
      await sleep(1200);
      return;
    }
    case "click": {
      log("Click: " + (step.label || step.target?.text || ""));
      const r = await tabCall(t, { cmd: "exec:step", step });
      if (!r.ok) {
        const sig = missedStep(step, r, "Element");
        return sig === "break" ? "break" : undefined;
      }
      await settleTab(t);
      return;
    }
    case "type": {
      log("Typing into: " + (step.label || "field"));
      const r = await tabCall(t, { cmd: "exec:step", step });
      if (!r.ok) {
        const sig = missedStep(step, r, "Field");
        return sig === "break" ? "break" : undefined;
      }
      await settleTab(t);
      return;
    }
    case "extract": {
      log("Extracting the question text…");
      const r = await tabCall(t, { cmd: "exec:step", step });
      if (!r.ok) {
        const sig = missedStep(step, r, "Question area");
        return sig === "break" ? "break" : undefined;
      }
      run.vars.question = r.text;
      log("Question: " + r.text.slice(0, 90) + (r.text.length > 90 ? "…" : ""));
      return;
    }
    case "ask_ai": {
      if (!run.vars.question) throw new Error('Add an "Extract question" step before "Ask the AI".');
      log("Asking " + aiLabel(run.settings) + "…");
      const answer = await askQuestion(run.vars.question, run.macro && run.macro.questionFormat);
      run.vars.answer = answer;
      run.answered = (run.answered || 0) + 1;
      broadcast({ type: "stats", answered: run.answered });
      log("Answer: " + answer.slice(0, 90) + (answer.length > 90 ? "…" : ""), "success");
      return;
    }
    case "choose_answer": {
      if (!run.vars.answer) throw new Error("No answer available yet.");
      log("Selecting the matching option…");
      const r = await tabCall(t, { cmd: "exec:step", step, answer: run.vars.answer });
      if (!r.ok) throw new Error(r.error || "No option matched the answer.");
      log("Selected: " + (r.chosen || ""), "success");
      await settleTab(t);
      return;
    }
    case "wait": {
      log("Waiting " + step.ms + "ms");
      await sleep(step.ms || 1000);
      return;
    }
    case "restart_point":
      return; // marker only
    case "confirm_restart": {
      const ok = await waitConfirm(step.message || "Continue to the next questionnaire?");
      if (ok) return "restart";
      run.stop = true;
      throw new Error("stopped");
    }
    default:
      log("Unknown step type: " + step.type, "warn");
  }
}

async function execRange(steps, from, to) {
  for (let i = from; i < to; i++) {
    if (run.stop) throw new Error("stopped");
    const st = steps[i];
    if (st.type === "loop_start") {
      const end = findLoopEnd(steps, i);
      const max = st.maxIterations || run.settings.maxLoops;
      for (let k = 0; k < max; k++) {
        if (run.stop) throw new Error("stopped");
        log(`Loop iteration ${k + 1} of ${max}`);
        const sig = await execRange(steps, i + 1, end);
        if (sig === "break") break;
        if (sig === "restart") return "restart";
      }
      i = end;
      continue;
    }
    if (st.type === "loop_end") continue;
    const sig = await execStep(st);
    if (sig === "break") return "break";
    if (sig === "restart") return "restart";
  }
}

async function execProgram(steps, initialStart = 0) {
  let start = initialStart;
  let rounds = 0;
  const restartIdx = steps.findIndex((s) => s.type === "restart_point");
  while (rounds++ < 300) {
    const sig = await execRange(steps, start, steps.length);
    if (sig === "restart") {
      start = restartIdx >= 0 ? restartIdx : initialStart;
      log("Starting a new round from the question start point…");
      continue;
    }
    return;
  }
}

function questionStartIndex(steps) {
  let i = steps.findIndex((s) => s.type === "loop_start");
  if (i < 0) i = steps.findIndex((s) => s.type === "extract");
  const r = steps.findIndex((s) => s.type === "restart_point");
  if (r >= 0 && (i < 0 || r < i)) return r;
  return i;
}

async function startRun(macroId, opts = {}) {
  if (run && (run.status === "running" || run.status === "assist")) throw new Error("A run is already in progress.");
  const macros = await store.get("macros", []);
  const macro = macros.find((m) => m.id === macroId);
  if (!macro) throw new Error("Macro not found.");
  const settings = await getSettings();
  if (settings.aiMode === "api") {
    const p = activeProvider(settings);
    if (!p) throw new Error("No AI provider configured — open Settings → Providers.");
    if (!p.apiKey && !p.keyOptional) throw new Error(`${p.label} has no API key yet — add it in Settings → Providers.`);
  }

  const first = macro.steps[0];
  const skipToQuestions = opts.startFrom === "questions";

  let tabId;
  if (!skipToQuestions && first && first.type === "open_url") {
    const tab = await B.tabs.create({ url: first.url, active: true });
    tabId = tab.id;
    await waitForLoad(tabId);
    await sleep(1200);
  } else {
    const [active] = await B.tabs.query({ active: true, currentWindow: true });
    if (!active) throw new Error("No active tab found.");
    tabId = active.id;
  }

  run = {
    macro,
    settings,
    tabId,
    status: "running",
    logs: [],
    vars: {},
    stop: false,
    confirmResolve: null,
    confirmMessage: "",
    assistResolve: null,
    assistQuestion: "",
    assistReason: "",
    assists: 0,
    current: "",
    answered: 0,
    tabAsks: 0,
    lastAnswer: "",
    lastQuestion: "",
    startedAt: Date.now(),
  };
  // Keep the MV3 worker alive for the whole run (any cheap extension API call
  // resets the ~30s idle suspension timer).
  const keepAlive = setInterval(() => {
    try {
      B.runtime.getPlatformInfo();
    } catch (e) {}
  }, 20000);
  broadcast({ type: "run", status: "running", macroName: macro.name });
  log(`Starting "${macro.name}" with ${aiLabel(settings)}`);
  tgSend(`Run started: "${macro.name}"`);

  try {
    const steps = macro.steps.filter((s, i) => !(i === 0 && s.type === "open_url"));
    let initialStart = 0;
    if (skipToQuestions) {
      const qi = questionStartIndex(steps);
      if (qi < 0) throw new Error("This macro has no question start point (loop or extract step).");
      initialStart = qi;
      log("Jumping straight to the questions (step " + (qi + 1) + ")");
    }
    await execProgram(steps, initialStart);
    run.status = "done";
    log("Run finished successfully.", "success");
    tgSend(`Run finished — ${run.answered || 0} questions answered.`);
  } catch (e) {
    if (run.stop || e.message === "stopped") {
      run.status = "stopped";
      log("Run stopped.", "warn");
      tgSend("Run stopped.");
    } else {
      run.status = "error";
      log("Error: " + e.message, "error");
      tgSend("Run failed: " + e.message);
    }
  }
  clearInterval(keepAlive);
  broadcast({ type: "run", status: run.status, answered: run.answered || 0 });
  pushHistory({
    id: "h" + Date.now(),
    name: macro.name,
    status: run.status,
    answered: run.answered || 0,
    assists: run.assists || 0,
    startedAt: run.startedAt,
    endedAt: Date.now(),
    skipped: skipToQuestions,
  });
}

/* ============================ Recorder ============================ */
async function startRecording(url) {
  let tabId;
  if (url) {
    const tab = await B.tabs.create({ url, active: true });
    tabId = tab.id;
    await waitForLoad(tabId);
    await sleep(900);
  } else {
    const [active] = await B.tabs.query({ active: true, currentWindow: true });
    if (!active) throw new Error("No active tab found.");
    tabId = active.id;
  }
  await injectRecorder(tabId);
  return { ok: true, tabId };
}

async function injectRecorder(tabId) {
  await B.scripting.executeScript({
    target: { tabId },
    files: ["content/selector.js", "content/executor.js", "content/recorder.js"],
  });
  await sleep(250);
  await B.tabs.sendMessage(tabId, { cmd: "recorder:start" }).catch(() => {});
}

// Re-attach the recorder panel after the page navigates while recording.
B.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const draft = await store.get("hbDraft", null);
  if (!draft || !draft.recording) return;
  try {
    await injectRecorder(tabId);
  } catch (e) {}
});

/* ============================ Messaging ============================ */
async function handleMessage(msg, sender) {
  switch (msg.cmd) {
    /* ---- macros ---- */
    case "macros:list":
      return { ok: true, macros: await store.get("macros", []), run: runSnapshot() };
    case "macros:delete": {
      const macros = (await store.get("macros", [])).filter((m) => m.id !== msg.id);
      await store.set("macros", macros);
      return { ok: true, macros };
    }
    case "macros:rename": {
      const macros = await store.get("macros", []);
      const m = macros.find((x) => x.id === msg.id);
      if (m) m.name = msg.name;
      await store.set("macros", macros);
      return { ok: true, macros };
    }
    case "macros:duplicate": {
      const macros = await store.get("macros", []);
      const m = macros.find((x) => x.id === msg.id);
      if (!m) return { ok: false, error: "Macro not found." };
      macros.push({ ...structuredClone(m), id: "m" + Date.now(), name: m.name + " (copy)" });
      await store.set("macros", macros);
      return { ok: true, macros };
    }
    case "macros:export": {
      const macros = await store.get("macros", []);
      const settings = await getSettings();
      const safe = { ...settings, providers: settings.providers.map((p) => ({ ...p, apiKey: "" })) };
      return { ok: true, data: { app: "huckleberry", version: VERSION, exportedAt: new Date().toISOString(), macros, settings: safe } };
    }
    case "macros:import": {
      // Accept every shape we have ever exported, plus a raw JSON string:
      //   { macros: [...] } | [...] | { steps: [...] } (a single macro)
      let data = msg.data ?? msg.json;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch (e) {
          return { ok: false, error: "That file is not valid JSON." };
        }
      }
      let incoming = [];
      if (Array.isArray(data)) incoming = data;
      else if (data && Array.isArray(data.macros)) incoming = data.macros;
      else if (data && Array.isArray(data.steps)) incoming = [data];

      const macros = await store.get("macros", []);
      const existing = new Set(macros.map((m) => m.name));
      let count = 0;
      for (const m of incoming) {
        if (!m || !Array.isArray(m.steps) || !m.steps.length) continue;
        let name = String(m.name || "Imported macro").trim() || "Imported macro";
        if (existing.has(name)) {
          let n = 2;
          while (existing.has(`${name} (${n})`)) n++;
          name = `${name} (${n})`;
        }
        existing.add(name);
        macros.push({
          id: "m" + Date.now().toString(36) + count + Math.random().toString(36).slice(2, 6),
          name,
          questionFormat: m.questionFormat || "",
          steps: m.steps,
          createdAt: Date.now(),
        });
        count++;
      }
      if (!count) return { ok: false, error: "No macro with steps was found in that file." };

      await store.set("macros", macros);
      // Confirm the write really landed before reporting success.
      const saved = await store.get("macros", []);
      if (saved.length !== macros.length) {
        return { ok: false, error: "The browser refused to save the macros. Check the extension storage quota." };
      }
      broadcast({ type: "macros-changed" });
      return { ok: true, count, macros: saved };
    }

    /* ---- recorder ---- */
    case "record:start":
      return await startRecording(msg.url);
    case "recorder:save": {
      // The recorder panel sends flat fields ({ name, steps, questionFormat }),
      // older builds sent them wrapped in `macro`, and the draft in storage is
      // the last resort. Accept all three so pressing Save never loses work.
      const draft = (await B.storage.local.get("hbDraft")).hbDraft || {};
      const src = msg.macro && typeof msg.macro === "object" ? msg.macro : msg;
      const steps = Array.isArray(src.steps) && src.steps.length
        ? src.steps
        : Array.isArray(draft.steps)
          ? draft.steps
          : [];

      if (!steps.length) {
        return { ok: false, error: "The macro had no steps, so there was nothing to save." };
      }

      const macros = await store.get("macros", []);
      const taken = new Set(macros.map((m) => m.name));
      let name = String(src.name || draft.name || "Untitled macro").trim() || "Untitled macro";
      if (taken.has(name)) {
        let n = 2;
        while (taken.has(`${name} (${n})`)) n++;
        name = `${name} (${n})`;
      }

      const macro = {
        id: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name,
        questionFormat: src.questionFormat || draft.questionFormat || "",
        steps,
        createdAt: Date.now(),
      };
      macros.push(macro);

      try {
        await store.set("macros", macros);
      } catch (e) {
        return { ok: false, error: "The browser refused to save the macro: " + (e && e.message ? e.message : e) };
      }

      // Read the list back: if the write silently failed, keep the draft so the
      // user can retry instead of losing everything they just recorded.
      const saved = await store.get("macros", []);
      if (!saved.some((m) => m.id === macro.id)) {
        return { ok: false, error: "The macro could not be stored. Check the extension storage quota and try again." };
      }

      await B.storage.local.remove("hbDraft");
      broadcast({ type: "macros-changed" });
      return { ok: true, macro, count: saved.length };
    }
    case "recorder:cancel":
      await B.storage.local.remove("hbDraft");
      broadcast({ type: "macros-changed" });
      return { ok: true };

    /* ---- AI tab bridge ---- */
    case "ai:result": {
      const resolve = tabPending.get(msg.reqId);
      if (resolve) resolve({ ok: msg.ok, text: msg.text, error: msg.error, reqId: msg.reqId });
      return { ok: true };
    }

    /* ---- run control ---- */
    case "run:start": {
      // Validate before reporting success, so the UI can show a real reason
      // instead of silently doing nothing.
      const macros = await store.get("macros", []);
      const macro = macros.find((m) => m.id === msg.id);
      if (!macro) return { ok: false, error: "That macro no longer exists." };
      if (!Array.isArray(macro.steps) || !macro.steps.length) {
        return { ok: false, error: "That macro has no steps to run." };
      }
      if (run && (run.status === "running" || run.status === "assist")) {
        return { ok: false, error: "A run is already in progress." };
      }
      const s = await getSettings();
      if (s.aiMode === "api") {
        const p = activeProvider(s);
        if (!p) return { ok: false, error: "No AI provider configured \u2014 open Settings \u2192 Providers." };
        if (!p.apiKey && !p.keyOptional) {
          return { ok: false, error: `${p.label} has no API key yet \u2014 add it in Settings \u2192 Providers.` };
        }
      }

      startRun(msg.id, { startFrom: msg.startFrom || null }).catch((e) => {
        const text = e && e.message ? e.message : String(e);
        if (run) run.status = "error";
        log("\u274c " + text, "error");
        broadcast({ type: "run", status: "error", error: text });
      });
      return { ok: true, macroName: macro.name };
    }
    case "run:stop":
      if (run) {
        run.stop = true;
        if (run.confirmResolve) run.confirmResolve(false);
        if (run.assistResolve) run.assistResolve({ action: "stop" });
      }
      return { ok: true };
    case "run:confirm":
      if (run && run.confirmResolve) run.confirmResolve(!!msg.ok);
      return { ok: true };
    case "run:manualAnswer":
      if (run && run.assistResolve) {
        run.assistResolve({ action: "answer", text: msg.text });
        return { ok: true };
      }
      return { ok: false, error: "Nothing is waiting for an answer." };
    case "run:retryAi":
      if (run && run.assistResolve) {
        run.assistResolve({ action: "retry" });
        return { ok: true };
      }
      return { ok: false, error: "Nothing is waiting for a retry." };
    case "run:state":
      return { ok: true, run: runSnapshot() };

    /* ---- history ---- */
    case "history:list":
      return { ok: true, history: await store.get("history", []) };
    case "history:clear":
      await store.set("history", []);
      return { ok: true };

    /* ---- settings ---- */
    case "settings:get":
      return { ok: true, settings: await getSettings(), presets: PRESETS, version: VERSION };
    case "settings:set": {
      const settings = await saveSettings({ ...(await getSettings()), ...msg.settings });
      if (settings.telegramEnabled) tgPollLoop();
      broadcast({ type: "settings-changed" });
      return { ok: true, settings };
    }

    /* ---- providers ---- */
    case "providers:list": {
      const s = await getSettings();
      return { ok: true, providers: s.providers, activeProviderId: s.activeProviderId, presets: PRESETS };
    }
    case "providers:save": {
      const s = await getSettings();
      const incoming = msg.provider || {};
      const id = incoming.id || "p" + Date.now().toString(36);
      const idx = s.providers.findIndex((p) => p.id === id);
      const clean = {
        id,
        label: (incoming.label || "Custom provider").trim(),
        kind: ["gemini", "openai", "anthropic"].includes(incoming.kind) ? incoming.kind : "openai",
        base: String(incoming.base || "").trim().replace(/\/+$/, ""),
        model: String(incoming.model || "").trim(),
        apiKey: String(incoming.apiKey ?? (idx >= 0 ? s.providers[idx].apiKey : "")),
        builtin: idx >= 0 ? !!s.providers[idx].builtin : false,
        keyOptional: idx >= 0 ? !!s.providers[idx].keyOptional : !!incoming.keyOptional,
      };
      if (!clean.base) return { ok: false, error: "Base URL is required." };
      if (!clean.model) return { ok: false, error: "Model name is required." };
      if (idx >= 0) s.providers[idx] = clean;
      else s.providers.push(clean);
      if (msg.activate) s.activeProviderId = clean.id;
      const saved = await saveSettings(s);
      broadcast({ type: "settings-changed" });
      return { ok: true, providers: saved.providers, activeProviderId: saved.activeProviderId };
    }
    case "providers:delete": {
      const s = await getSettings();
      const target = s.providers.find((p) => p.id === msg.id);
      if (!target) return { ok: false, error: "Provider not found." };
      if (target.builtin) {
        // Built-in presets are kept in the list but reset to a clean state.
        target.apiKey = "";
        const preset = PRESETS.find((p) => p.id === target.id);
        if (preset) {
          target.base = preset.base;
          target.model = preset.model;
        }
      } else {
        s.providers = s.providers.filter((p) => p.id !== msg.id);
      }
      const saved = await saveSettings(s);
      broadcast({ type: "settings-changed" });
      return { ok: true, providers: saved.providers, activeProviderId: saved.activeProviderId, reset: !!target.builtin };
    }
    case "providers:activate": {
      const s = await getSettings();
      if (!s.providers.some((p) => p.id === msg.id)) return { ok: false, error: "Provider not found." };
      s.activeProviderId = msg.id;
      const saved = await saveSettings(s);
      broadcast({ type: "settings-changed" });
      return { ok: true, activeProviderId: saved.activeProviderId };
    }
    case "providers:test": {
      const started = Date.now();
      try {
        const provider = msg.provider && msg.provider.base ? msg.provider : (await getSettings()).providers.find((p) => p.id === msg.id);
        const text = await askApi("Reply with the single word: OK", provider, 30000);
        return { ok: true, text: String(text).slice(0, 200), ms: Date.now() - started };
      } catch (e) {
        return { ok: false, error: e.message, ms: Date.now() - started };
      }
    }

    /* ---- diagnostics ---- */
    case "test:ai": {
      const s = await getSettings();
      const started = Date.now();
      try {
        const text = s.aiMode === "tab" ? await askTab("Reply with the single word: OK", s, 60000) : await askApi("Reply with the single word: OK", activeProvider(s), 30000);
        return { ok: true, text: String(text).slice(0, 200), ms: Date.now() - started };
      } catch (e) {
        return { ok: false, error: e.message, ms: Date.now() - started };
      }
    }
    case "test:telegram": {
      const s = await getSettings();
      if (!s.telegramToken) return { ok: false, error: "Bot token is missing." };
      try {
        const me = await (await fetch(TG(s.telegramToken) + "/getMe")).json();
        if (!me.ok) return { ok: false, error: me.description || "Invalid token." };
        if (s.telegramChatId) {
          const sent = await (
            await fetch(TG(s.telegramToken) + "/sendMessage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: s.telegramChatId, text: "Huckleberry is connected ✅" }),
            })
          ).json();
          if (!sent.ok) return { ok: false, error: sent.description || "Could not send a message to that chat ID." };
        }
        return { ok: true, bot: me.result.username };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    default:
      return { ok: false, error: "Unknown command: " + msg.cmd };
  }
}

/* Every UI surface checks `res.ok` before using a response, so normalise here:
 * a handler that resolves with a plain object (or nothing) still reports
 * success. Without this a successful action can look like a silent failure. */
function normaliseResponse(r) {
  if (r === undefined || r === null) return { ok: true };
  if (typeof r !== "object") return { ok: true, value: r };
  if (Object.prototype.hasOwnProperty.call(r, "ok")) return r;
  return { ok: true, ...r };
}

B.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.channel === "hb-events") return; // ignore our own broadcasts
  handleMessage(msg, sender)
    .then((r) => sendResponse(normaliseResponse(r)))
    .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
  return true; // async response
});

/* ============================ Sidebar / action wiring ============================ */
try {
  if (B.sidePanel && B.sidePanel.setPanelBehavior) {
    // Chrome / Edge: clicking the toolbar icon opens the side panel.
    B.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } else if (B.action && B.action.onClicked) {
    // Firefox: toggle the sidebar from the toolbar icon.
    B.action.onClicked.addListener(() => {
      try {
        B.sidebarAction.toggle();
      } catch (e) {}
    });
  }
} catch (e) {}

B.runtime.onInstalled.addListener(async () => {
  await saveSettings(await getSettings()); // seed + migrate settings on install/update
});

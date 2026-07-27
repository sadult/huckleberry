/* Huckleberry — ChatGPT Bridge (browser-tab mode)
 * Injected into chatgpt.com. It types the question into the composer,
 * sends it, waits for the complete reply and hands the text back to the
 * background orchestrator. Reply detection uses a MutationObserver, which
 * is fast and immune to background-tab timer throttling.
 * No API key required — it uses your logged-in session.
 */
(() => {
  "use strict";
  if (window.__fmChatgptBridge) return;
  window.__fmChatgptBridge = true;
  const B = globalThis.browser ?? globalThis.chrome;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findInput() {
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('div[contenteditable="true"][id*="prompt"]') ||
      document.querySelector('main div[contenteditable="true"]') ||
      document.querySelector('main textarea')
    );
  }

  function findSendButton() {
    return (
      document.querySelector('button[data-testid="send-button"]:not([disabled])') ||
      document.querySelector("#composer-submit-button:not([disabled])") ||
      document.querySelector('button[aria-label*="Send" i]:not([disabled])') ||
      document.querySelector('button[aria-label*="\u0627\u0631\u0633\u0627\u0644"]:not([disabled])')
    );
  }

  const isStreaming = () =>
    !!(
      document.querySelector('button[data-testid="stop-button"]') ||
      document.querySelector('button[aria-label*="Stop" i]')
    );

  function assistantNodes() {
    return [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  }

  /* Reply waiting via MutationObserver:
   * - every DOM change triggers an immediate check (works even in hidden or
   *   unfocused tabs, where setTimeout/setInterval get heavily throttled)
   * - resolves as soon as streaming has stopped and the text has been stable
   *   for ~1s, instead of slow fixed-interval polling */
  function waitForReply(before) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 150000;
      const stableMs = 1000;
      let lastText = "";
      let lastChange = Date.now();
      let done = false;
      let timer = null;
      const obs = new MutationObserver(() => check());
      const finish = (ok, v) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        ok ? resolve(v) : reject(v);
      };
      function check() {
        if (done) return;
        clearTimeout(timer);
        if (Date.now() > deadline) return finish(false, new Error("Timed out waiting for the ChatGPT reply."));
        const list = assistantNodes();
        if (list.length > before) {
          const cur = (list[list.length - 1].innerText || "").trim();
          if (cur && cur !== lastText) { lastText = cur; lastChange = Date.now(); }
          if (cur && cur === lastText && !isStreaming() && Date.now() - lastChange >= stableMs) {
            return finish(true, cur);
          }
        }
        timer = setTimeout(check, 300);
      }
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      check();
    });
  }

  async function ask(prompt) {
    const input = findInput();
    if (!input) throw new Error("ChatGPT composer not found — make sure you are logged in.");
    const before = assistantNodes().length;

    input.focus();
    if (input.tagName === "TEXTAREA") {
      input.value = prompt;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, prompt);
    }
    await sleep(350);

    const btn = findSendButton();
    if (btn) btn.click();
    else {
      const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      input.dispatchEvent(new KeyboardEvent("keydown", opts));
    }

    return await waitForReply(before);
  }

  /* Reliability fix: never hold the message channel open during the long AI wait —
   * the background worker may be suspended meanwhile, killing the late
   * sendResponse and stalling the run. ACK immediately, then deliver the
   * result via storage + an "ai:result" runtime message. Idempotent per reqId. */
  let busyReqId = null;
  B.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || (msg.cmd !== "ai:ask" && msg.cmd !== "chatgpt:ask")) return;
    const reqId = msg.reqId || "r" + Date.now().toString(36);
    if (busyReqId === reqId) {
      sendResponse({ ok: true, accepted: true, duplicate: true });
      return;
    }
    busyReqId = reqId;
    sendResponse({ ok: true, accepted: true });
    const deliver = async (res) => {
      if (busyReqId === reqId) busyReqId = null;
      const payload = { cmd: "ai:result", reqId, at: Date.now(), ...res };
      try { await B.storage.local.set({ hbAiResult: payload }); } catch (e) {}
      try { B.runtime.sendMessage(payload).then(() => {}, () => {}); } catch (e) {}
    };
    ask(msg.prompt)
      .then((text) => deliver({ ok: true, text }))
      .catch((e) => deliver({ ok: false, error: e.message }));
  });
})();

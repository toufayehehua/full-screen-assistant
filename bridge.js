(() => {
  "use strict";

  const channel = "full-screen-assistant/v1";
  const requests = new Set();
  const activationReplies = new Map();
  const prepareReplies = new Map();
  const expansionKeys = new Map();
  let tabSession = null;
  let userGestureAt = 0;
  let activatedAt = 0;

  for (const event of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(event, e => { if (e.isTrusted) userGestureAt = Date.now(); }, { capture: true, passive: true });
  }

  function post(message) {
    window.postMessage({ channel, direction: "extension", ...message }, "*");
  }

  async function send(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch (error) { return { error: error.message }; }
  }

  function relayExpansion(key) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ channel, direction: "frame", type: "expand", sessionId: key.sessionId, token: key.token }, "*");
    }
  }

  function containsFrame(root, source) {
    if ([...root.querySelectorAll("iframe")].some(frame => frame.contentWindow === source)) return true;
    return [...root.querySelectorAll("*")].some(element => element.shadowRoot && containsFrame(element.shadowRoot, source));
  }

  window.addEventListener("message", async event => {
    const data = event.data;
    if (data?.channel === channel && data.direction === "frame" && data.type === "expand") {
      if (data.sessionId !== tabSession || typeof data.token !== "string" || data.token.length > 100 || event.source === window || !containsFrame(document, event.source)) return;
      const result = await send({ type: "FSA_EXPAND_ALLOWED", sessionId: data.sessionId, token: data.token });
      if (result?.ok && data.sessionId === tabSession) {
        post({ type: "expand-authorized", sessionId: data.sessionId, token: data.token });
        relayExpansion(data);
      }
      return;
    }
    if (event.source !== window || data?.channel !== channel || data.direction !== "page") return;
    if (data.type === "tab-state" && typeof data.requestId === "string" && data.requestId.length <= 100) {
      const result = tabSession ? { sessionId: tabSession } : await send({ type: "FSA_TAB_STATE" });
      post({ type: "tab-state", requestId: data.requestId, known: !!result && !result.error, sessionId: result?.sessionId });
    } else if (data.type === "start") {
      if (Date.now() - Math.max(userGestureAt, activatedAt) > 15000 || requests.size) {
        post({ type: "started", requestId: data.requestId, error: "No active video request" });
        return;
      }
      if (typeof data.requestId !== "string" || data.requestId.length > 100) return;
      requests.add(data.requestId);
      const preview = typeof data.preview === "string" && data.preview.startsWith("data:image/jpeg;base64,") && data.preview.length <= 350000 ? data.preview : undefined;
      const result = await send({ type: "FSA_START", requestId: data.requestId, title: document.title.slice(0, 200), sourceUrl: location.href, preview });
      if (result?.error) requests.delete(data.requestId);
      else if (result?.expandToken) expansionKeys.set(data.requestId, { sessionId: result.sessionId, token: result.expandToken });
      post({ type: "started", requestId: data.requestId, sessionId: result?.sessionId, error: result?.error });
    } else if (data.type === "restore-prepared") {
      prepareReplies.get(data.prepareId)?.();
    } else if (data.type === "activation-done") {
      activationReplies.get(data.requestId)?.({ found: data.found === true });
      activationReplies.delete(data.requestId);
    } else if (data.type === "candidate" && typeof data.requestId === "string" && Number.isFinite(data.score)) {
      await send({ type: "FSA_CANDIDATE", requestId: data.requestId, score: data.score });
    } else if (requests.has(data.requestId)) {
      if (data.type === "expand") {
        const key = expansionKeys.get(data.requestId);
        if (key && key.sessionId === tabSession) relayExpansion(key);
      } else if (data.type === "entered") await send({ type: "FSA_ENTERED", requestId: data.requestId });
      else if (data.type === "exit" || data.type === "stop") {
        const result = await send({ type: data.type === "exit" ? "FSA_EXIT_REQUEST" : "FSA_STOP", requestId: data.requestId });
        if (result?.error) post({ type: "restore-failed", requestId: data.requestId });
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === "FSA_SOURCE_URL") {
      if (sender.id === chrome.runtime.id) respond({ sourceUrl: location.href });
    } else if (message.type === "FSA_TAB_ACTIVE") {
      tabSession = message.sessionId;
      post({ type: "tab-active", sessionId: message.sessionId });
    } else if (message.type === "FSA_TAB_RESTORED") {
      if (tabSession !== message.sessionId) return;
      tabSession = null;
      post({ type: "tab-restored", sessionId: message.sessionId });
    } else if (message.type === "FSA_SOURCE_ALIVE") respond({ alive: requests.has(message.requestId) });
    else if (message.type === "FSA_PROBE") post({ type: "probe", requestId: message.requestId });
    else if (message.type === "FSA_ACTIVATE") {
      activatedAt = Date.now();
      if (message.requestId) activationReplies.set(message.requestId, respond);
      post({ type: "activate", toggle: message.toggle, requestId: message.requestId });
      if (message.requestId) return true;
    } else if (message.type === "FSA_PREPARE_RESTORE") {
      if (!requests.has(message.requestId)) { respond({ ok: false }); return; }
      const prepareId = crypto.randomUUID();
      const finish = () => {
        clearTimeout(timer);
        prepareReplies.delete(prepareId);
        respond({ ok: true });
      };
      const timer = setTimeout(finish, 1000);
      prepareReplies.set(prepareId, finish);
      post({ type: "prepare-restore", requestId: message.requestId, prepareId, animate: message.animate === true });
      return true;
    } else if (message.type === "FSA_RESTORED" && requests.has(message.requestId)) {
      requests.delete(message.requestId);
      expansionKeys.delete(message.requestId);
      post({ type: "restored", requestId: message.requestId, animate: message.animate === true });
    } else if (message.type === "FSA_RESTORE_FAILED" && requests.has(message.requestId)) {
      post({ type: "restore-failed", requestId: message.requestId });
    }
  });

  window.addEventListener("pagehide", () => {
    for (const requestId of requests) void send({ type: "FSA_STOP", requestId });
    requests.clear();
    expansionKeys.clear();
    tabSession = null;
    for (const finish of prepareReplies.values()) finish();
    activationReplies.clear();
  });
})();

const SESSION_KEY = "fsaSessions";
const MODE = "original-tab";
const MANAGED_PHASES = new Set(["preparing", "moving", "moved", "active", "restoring", "restore_failed", "closing"]);
const placeholderURL = chrome.runtime.getURL("placeholder.html");
const probes = new Map();
const cancelled = new Map();
let pending = Promise.resolve();

function serialized(work) {
  const result = pending.then(work, work);
  pending = result.catch(() => {});
  return result;
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const errorText = error => String(error?.message || error);
const missing = error => /(?:no (?:tab|window)|invalid (?:tab|window)|(?:tab|window).*not found|does not exist)/i.test(errorText(error));

async function getTab(id) {
  if (!Number.isInteger(id)) return null;
  try { return await chrome.tabs.get(id); }
  catch (error) { if (missing(error)) return null; throw error; }
}

async function getWindow(id) {
  if (!Number.isInteger(id)) return null;
  try { return await chrome.windows.get(id); }
  catch (error) { if (missing(error)) return null; throw error; }
}

async function readSessions() {
  return (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] || {};
}

async function saveSessions(sessions) {
  await chrome.storage.session.set({ [SESSION_KEY]: sessions });
}

function frameOptions(session, current = false) {
  return !current && session.sourceDocumentId ? { documentId: session.sourceDocumentId } : { frameId: session.sourceFrameId };
}

async function boundedMessage(tabId, message, options, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      tabId === null ? chrome.runtime.sendMessage(message) : chrome.tabs.sendMessage(tabId, message, options),
      new Promise(resolve => { timer = setTimeout(resolve, milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function tellSource(session, message, milliseconds = 500) {
  const payload = { ...message, requestId: session.requestId, sessionId: session.id };
  const deadline = Date.now() + milliseconds;
  try {
    return await boundedMessage(session.sourceTabId, payload, frameOptions(session), milliseconds);
  } catch {
    // A navigation can replace the document. Returning the real tab must not
    // depend on an obsolete renderer replying to a message.
    if (session.sourceDocumentId && Date.now() < deadline) {
      try { return await boundedMessage(session.sourceTabId, payload, frameOptions(session, true), deadline - Date.now()); }
      catch { /* The current frame may also have navigated or closed. */ }
    }
  }
}

async function broadcastTab(session, type) {
  let timer;
  try {
    // No frame/document filter: ancestors must know that a descendant owns the
    // tab session before its native fullscreen event reaches their document.
    await Promise.race([
      chrome.tabs.sendMessage(session.sourceTabId, { type, sessionId: session.id }).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 300); }),
    ]);
  } catch { /* A closing tab or extension context can also reject synchronously. */ }
  finally { clearTimeout(timer); }
}

function sourceMatches(session, sender) {
  return sender.id === chrome.runtime.id && sender.tab?.id === session.sourceTabId &&
    (session.sourceDocumentId ? sender.documentId === session.sourceDocumentId : sender.frameId === session.sourceFrameId);
}

function placeholderMatches(session, sender) {
  return sender.id === chrome.runtime.id && sender.tab?.id === session.placeholderTabId &&
    sender.url === `${placeholderURL}#${session.id}`;
}

function ownedPlaceholder(session, tab) {
  const url = `${placeholderURL}#${session.id}`;
  return tab?.id === session.placeholderTabId && (tab.pendingUrl ? tab.pendingUrl === url : tab.url === url);
}

function sourceURL(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

async function originalPageURL(message, sender) {
  const url = sourceURL(sender.tab?.url);
  if (url) return url;
  if (sender.frameId === 0) return sourceURL(message.sourceUrl);
  try {
    const top = await boundedMessage(sender.tab.id, { type: "FSA_SOURCE_URL" }, { frameId: 0 }, 400);
    return sourceURL(top?.sourceUrl);
  } catch { return null; }
}

function requestKey(sender, requestId) {
  return `${sender.tab?.id}:${sender.documentId || sender.frameId}:${requestId}`;
}

function checkCancelled(key) {
  if (cancelled.has(key)) throw new Error("Fullscreen request cancelled");
}

async function ensureFullscreen(windowId) {
  let timer;
  let changed;
  try {
    await new Promise((resolve, reject) => {
      const finish = () => resolve();
      changed = window => { if (window.id === windowId && window.state === "fullscreen") finish(); };
      chrome.windows.onBoundsChanged.addListener(changed);
      // Creation may already have committed its fullscreen bounds. Otherwise
      // onBoundsChanged arrives when the native transition commits.
      timer = setTimeout(finish, 1200);
      chrome.windows.update(windowId, { state: "fullscreen", focused: true }).catch(reject);
    });
    const window = await chrome.windows.get(windowId);
    if (window.state !== "fullscreen") throw new Error("The video window did not enter fullscreen");
  } finally {
    clearTimeout(timer);
    if (changed) chrome.windows.onBoundsChanged.removeListener(changed);
  }
}

async function focusBrowser(source, destination) {
  if (source.windowId === destination.id) return;
  const videoWindow = await getWindow(source.windowId);
  if (!videoWindow?.focused) return;
  await chrome.windows.update(destination.id, { focused: true });
  let stableSince = 0;
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    const [browser, video] = await Promise.all([getWindow(destination.id), getWindow(source.windowId)]);
    if (!browser || !video) return;
    if (browser.focused && !video.focused) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= 350) return;
    } else stableSince = 0;
    await delay(50);
  }
}

async function destinationFor(session, source) {
  const placeholder = await getTab(session.placeholderTabId);
  const anchor = ownedPlaceholder(session, placeholder) ? placeholder : null;
  const id = anchor?.windowId ?? (session.originClosed ? null : session.originWindowId);
  const window = await getWindow(id);
  if (!window || window.type !== "normal" || Boolean(window.incognito) !== Boolean(source.incognito)) return null;
  return { window, anchor };
}

async function removePlaceholder(session) {
  const tab = await getTab(session.placeholderTabId);
  // Navigating the placeholder turns it into a user tab. Never delete it.
  if (!ownedPlaceholder(session, tab)) return false;
  try { await chrome.tabs.remove(tab.id); }
  catch (error) { if (!missing(error)) throw error; }
  return true;
}

async function cleanupClosedSource(sessions, session) {
  await removePlaceholder(session);
  delete sessions[session.id];
  await saveSessions(sessions);
  await broadcastTab(session, "FSA_TAB_RESTORED");
  return { ok: true, sourceClosed: true };
}

async function closeSession(sessions, session) {
  session.phase = "closing";
  await saveSessions(sessions);
  // Removing only the bound video lets its sole-tab window close naturally,
  // while preserving any other tabs the user added to that window.
  try { await chrome.tabs.remove(session.sourceTabId); }
  catch (error) { if (!missing(error)) throw error; }
  return cleanupClosedSource(sessions, session);
}

async function placeholderGone(session) {
  if (!Number.isInteger(session.placeholderTabId)) return false;
  const tab = await getTab(session.placeholderTabId);
  // A new tab can still have no committed or exposed pending URL. Wait for
  // its own ready response rather than treating startup as user navigation.
  if (!session.placeholderReady && tab?.status === "loading" && !tab.pendingUrl && (!tab.url || tab.url === "about:blank")) return false;
  return !ownedPlaceholder(session, tab);
}

async function preparePlaceholder(session) {
  const deadline = Date.now() + 900;
  while (Date.now() < deadline && !await placeholderGone(session)) {
    try {
      // The placeholder is an extension page, not a tab content script.
      const ready = await boundedMessage(null, {
        type: "FSA_PREPARE_PLACEHOLDER", sessionId: session.id, title: session.title, preview: session.preview, sourceUrl: session.sourceUrl,
      }, undefined, Math.min(450, deadline - Date.now()));
      if (ready?.ok) { session.placeholderReady = true; return true; }
    } catch { /* A newly created placeholder may not have registered yet. */ }
    await delay(40);
  }
  return false;
}

async function restoreSession(sessions, session) {
  if (!sessions[session.id]) return { ok: true };
  try {
    if (session.phase === "closing" || await placeholderGone(session)) return await closeSession(sessions, session);
    let source = await getTab(session.sourceTabId);
    if (!source) return await cleanupClosedSource(sessions, session);
    session.phase = "restoring";
    await saveSessions(sessions);
    let destination = await destinationFor(session, source);
    const previousDestinationId = destination?.window.id;
    const sourceWasFocused = (await getWindow(source.windowId))?.focused === true;
    if (destination) await focusBrowser(source, destination.window);
    if (await placeholderGone(session)) return await closeSession(sessions, session);
    await tellSource(session, { type: "FSA_PREPARE_RESTORE", animate: true }, 2000);
    if (await placeholderGone(session)) return await closeSession(sessions, session);
    source = await getTab(session.sourceTabId);
    if (!source) return await cleanupClosedSource(sessions, session);
    // The user may have moved or closed the placeholder during the ACK.
    destination = await destinationFor(session, source);
    if (sourceWasFocused && destination && destination.window.id !== previousDestinationId) {
      // Only follow an anchor moved during this foreground return while our
      // first destination still has focus; background returns never steal it.
      await focusBrowser({ windowId: previousDestinationId }, destination.window);
    }
    if (await placeholderGone(session)) return await closeSession(sessions, session);
    source = await getTab(session.sourceTabId);
    if (!source) return await cleanupClosedSource(sessions, session);
    destination = await destinationFor(session, source);
    if (!destination) {
      // The original browser was closed. Keep the real page in its current
      // window instead of copying, reloading, or closing it.
      const window = await chrome.windows.get(source.windowId);
      if (window.state === "fullscreen") await chrome.windows.update(window.id, { state: "normal" });
      await removePlaceholder(session);
      delete sessions[session.id];
      await saveSessions(sessions);
      await broadcastTab(session, "FSA_TAB_RESTORED");
      await tellSource(session, { type: "FSA_RESTORED", animate: true });
      return { ok: true, fallback: true };
    }

    const { window, anchor } = destination;
    const [selected] = await chrome.tabs.query({ windowId: window.id, active: true });
    const activateSource = anchor?.active === true;
    const pinned = anchor ? anchor.pinned : session.originPinned;
    let groupId = pinned ? -1 : (anchor?.groupId ?? session.originGroupId);
    if (groupId >= 0 && !(await chrome.tabs.query({ windowId: window.id, groupId })).length) groupId = -1;

    if (source.pinned) await chrome.tabs.update(source.id, { pinned: false });
    if (source.windowId !== window.id) {
      // Cross-window moves cannot insert into the middle of a group.
      await chrome.tabs.move(source.id, { windowId: window.id, index: -1 });
    }
    if (pinned) await chrome.tabs.update(source.id, { pinned: true });
    else if (groupId >= 0) await chrome.tabs.group({ groupId, tabIds: [source.id] });
    else if ((await chrome.tabs.get(source.id)).groupId >= 0) await chrome.tabs.ungroup([source.id]);

    const currentAnchor = await getTab(session.placeholderTabId);
    if (Number.isInteger(session.placeholderTabId) && !ownedPlaceholder(session, currentAnchor)) return await closeSession(sessions, session);
    const index = ownedPlaceholder(session, currentAnchor) && currentAnchor.windowId === window.id ? currentAnchor.index : session.originIndex;
    await chrome.tabs.move(source.id, { index: Math.max(0, index) });
    const returned = await chrome.tabs.get(source.id);
    if (returned.windowId !== window.id) throw new Error("The video tab was not returned to its browser");
    if (activateSource) await chrome.tabs.update(source.id, { active: true });
    else if (selected && selected.id !== source.id && await getTab(selected.id)) await chrome.tabs.update(selected.id, { active: true });

    if (!await removePlaceholder(session) && Number.isInteger(session.placeholderTabId)) return await closeSession(sessions, session);
    delete sessions[session.id];
    await saveSessions(sessions);
    await broadcastTab(session, "FSA_TAB_RESTORED");
    await tellSource(session, { type: "FSA_RESTORED", animate: true });
    return { ok: true };
  } catch (error) {
    if (session.phase === "closing") throw error;
    // A failed move is retryable. Keep the original page and its session even
    // after a partial return; never close its window as a rollback shortcut.
    session.phase = "restore_failed";
    session.lastError = errorText(error);
    sessions[session.id] = session;
    await saveSessions(sessions);
    await tellSource(session, { type: "FSA_RESTORE_FAILED" });
    throw error;
  }
}

async function startSession(message, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || !Number.isInteger(sender.frameId) ||
      typeof message.requestId !== "string" || message.requestId.length > 100) throw new Error("Invalid source request");
  const key = requestKey(sender, message.requestId);
  const sessions = await readSessions();
  for (const existing of Object.values(sessions)) {
    if (existing.mode !== MODE || existing.sourceTabId !== sender.tab.id) continue;
    const sameOwner = sourceMatches(existing, sender) && existing.sourceFrameId === sender.frameId;
    if (MANAGED_PHASES.has(existing.phase) && !sameOwner) {
      throw new Error("Exit this tab's current fullscreen session before starting another frame");
    }
    if (existing.requestId === message.requestId && sameOwner && existing.phase === "active") {
      if (!existing.expandToken) {
        existing.expandToken = crypto.randomUUID();
        await saveSessions(sessions);
      }
      return { sessionId: existing.id, expandToken: existing.expandToken };
    }
    await restoreSession(sessions, existing);
  }
  checkCancelled(key);
  const source = await chrome.tabs.get(sender.tab.id);
  const origin = await chrome.windows.get(source.windowId);
  if (origin.type !== "normal") throw new Error("Video tabs must start in a normal browser window");
  const session = {
    id: crypto.randomUUID(), expandToken: crypto.randomUUID(), mode: MODE, phase: "preparing", requestId: message.requestId,
    sourceTabId: source.id, sourceFrameId: sender.frameId, sourceDocumentId: sender.documentId,
    originWindowId: source.windowId, originIndex: source.index, originPinned: Boolean(source.pinned), originGroupId: source.groupId ?? -1,
    placeholderTabId: null, videoWindowId: null, createdAt: Date.now(),
    title: String(message.title || "").slice(0, 200), sourceUrl: await originalPageURL(message, sender),
    preview: typeof message.preview === "string" && message.preview.length <= 350000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=\r\n]+$/.test(message.preview) ? message.preview : null,
  };
  sessions[session.id] = session;
  await saveSessions(sessions);
  try {
    checkCancelled(key);
    const placeholder = await chrome.tabs.create({
      windowId: source.windowId, index: source.index, pinned: source.pinned, active: false,
      url: `${placeholderURL}#${session.id}`,
    });
    session.placeholderTabId = placeholder.id;
    await saveSessions(sessions);
    if (session.originGroupId >= 0) {
      await chrome.tabs.group({ groupId: session.originGroupId, tabIds: [placeholder.id] });
      // Joining a group can append its new member; keep the placeholder in the
      // real source tab's original slot before detaching that source.
      await chrome.tabs.move(placeholder.id, { index: session.originIndex });
    }
    if (await placeholderGone(session)) throw new Error("The video placeholder was closed or replaced");
    checkCancelled(key);
    session.phase = "moving";
    await saveSessions(sessions);
    const videoWindow = await chrome.windows.create({ tabId: source.id, type: "normal", state: "fullscreen", focused: true, incognito: source.incognito });
    if (!Number.isInteger(videoWindow?.id)) throw new Error("The video window was not created");
    session.videoWindowId = videoWindow.id;
    session.phase = "moved";
    await saveSessions(sessions);
    checkCancelled(key);
    // Select the replacement only after the real page has left this window,
    // so switching tabs cannot pause the video before it is detached.
    if (source.active) await chrome.tabs.update(placeholder.id, { active: true });
    await ensureFullscreen(videoWindow.id);
    checkCancelled(key);
    session.phase = "active";
    await saveSessions(sessions);
    await broadcastTab(session, "FSA_TAB_ACTIVE");
    checkCancelled(key);
    return { sessionId: session.id, expandToken: session.expandToken };
  } catch (error) {
    try {
      const current = await getTab(session.sourceTabId);
      if (session.phase === "closing" || await placeholderGone(session)) await closeSession(sessions, session);
      else if (current?.windowId === session.originWindowId && ["preparing", "moving"].includes(session.phase)) {
        // Nothing was detached. Do not change the real tab's group/pin state
        // while rolling back a failed placeholder creation or grouping step.
        await removePlaceholder(session);
        delete sessions[session.id];
        await saveSessions(sessions);
      } else await restoreSession(sessions, session);
    } catch { /* Keep failed rollback metadata for retry. */ }
    throw error;
  } finally { cancelled.delete(key); }
}

async function handleMessage(message, sender) {
  if (message.type === "FSA_START") return startSession(message, sender);
  const sessions = await readSessions();
  const session = message.sessionId ? sessions[message.sessionId] : Object.values(sessions).find(entry => entry.requestId === message.requestId && sourceMatches(entry, sender));
  if (!session || session.mode !== MODE) return { error: "Session is no longer available", sessionEnded: message.type === "FSA_PLACEHOLDER_READY" };
  if (message.type === "FSA_EXPAND_ALLOWED") {
    // Ancestor frames have different documents. Possession of this private
    // session token and membership in the real source tab authorize expansion.
    if (sender.id === chrome.runtime.id && sender.tab?.id === session.sourceTabId &&
        session.phase === "active" && typeof session.expandToken === "string" &&
        message.token === session.expandToken) return { ok: true };
    return { error: "Invalid expansion request" };
  }
  const source = sourceMatches(session, sender);
  const placeholder = placeholderMatches(session, sender);
  if (!source && !placeholder) return { error: "Invalid session sender" };
  if (message.type === "FSA_PLACEHOLDER_READY" && placeholder) return session.entered ?
    { title: session.title, preview: session.preview, sourceUrl: session.sourceUrl } : { pending: true };
  if (message.type === "FSA_ENTERED" && source) {
    session.entered = true;
    await saveSessions(sessions);
    await preparePlaceholder(session);
    await saveSessions(sessions);
    return { ok: true };
  }
  if (message.type === "FSA_EXIT_REQUEST" || (message.type === "FSA_STOP" && source)) return restoreSession(sessions, session);
  return { error: "Unknown session message" };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message.type !== "string" || !message.type.startsWith("FSA_")) return;
  // The matching extension page answers this runtime broadcast directly.
  // It must not queue behind the START transaction waiting for that reply.
  if (message.type === "FSA_PREPARE_PLACEHOLDER") return;
  if (message.type === "FSA_TAB_STATE") {
    if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id)) {
      respond({ error: "Invalid tab state request" });
      return;
    }
    // Read outside the transaction queue. An ancestor checking an in-flight
    // native fullscreen must not wait behind START or PREPARE_RESTORE's ACK.
    readSessions().then(sessions => {
      const session = Object.values(sessions).find(entry => entry.mode === MODE &&
        entry.sourceTabId === sender.tab.id && MANAGED_PHASES.has(entry.phase));
      return session ? { sessionId: session.id, phase: session.phase } : { sessionId: null };
    }).then(respond, error => respond({ error: errorText(error) }));
    return true;
  }
  if (message.type === "FSA_CANDIDATE") {
    const probe = probes.get(message.requestId);
    if (sender.id === chrome.runtime.id && probe && sender.tab?.id === probe.tabId && Number.isFinite(message.score) && message.score > 0) {
      probe.candidates.push({ score: message.score, frameId: sender.frameId, documentId: sender.documentId });
    }
    respond({ ok: true });
    return;
  }
  if (message.type === "FSA_STOP" && sender.id === chrome.runtime.id && sender.tab && typeof message.requestId === "string") {
    cancelled.set(requestKey(sender, message.requestId), Date.now());
    for (const [key, time] of cancelled) if (Date.now() - time > 60000) cancelled.delete(key);
  }
  serialized(() => handleMessage(message, sender)).then(respond, error => respond({ error: errorText(error) }));
  return true;
});

chrome.action.onClicked.addListener(async tab => {
  if (!Number.isInteger(tab.id)) return;
  const sessions = await readSessions();
  const existing = Object.values(sessions).find(session => session.mode === MODE && [session.sourceTabId, session.placeholderTabId].includes(tab.id));
  if (existing) {
    await serialized(async () => {
      const current = await readSessions();
      if (current[existing.id]) await restoreSession(current, current[existing.id]);
    }).catch(() => {});
    return;
  }
  const requestId = crypto.randomUUID();
  const probe = { tabId: tab.id, candidates: [] };
  probes.set(requestId, probe);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "FSA_PROBE", requestId });
    await delay(180);
    const best = probe.candidates.sort((a, b) => b.score - a.score)[0];
    if (best) await chrome.tabs.sendMessage(tab.id, { type: "FSA_ACTIVATE", toggle: true },
      best.documentId ? { documentId: best.documentId } : { frameId: best.frameId });
  } catch { /* Restricted Chrome pages and old documents have no bridge. */ }
  finally { probes.delete(requestId); }
});

chrome.tabs.onRemoved.addListener(tabId => {
  void serialized(async () => {
    const sessions = await readSessions();
    for (const session of Object.values(sessions)) {
      if (session.mode !== MODE) continue;
      if (session.sourceTabId === tabId) await cleanupClosedSource(sessions, session);
      else if (session.placeholderTabId === tabId) await closeSession(sessions, session);
    }
  }).catch(() => {});
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void serialized(async () => {
    const sessions = await readSessions();
    for (const session of Object.values(sessions)) {
      if (session.mode === MODE && session.placeholderTabId === removedTabId) await closeSession(sessions, session);
    }
  }).catch(() => {});
});

chrome.tabs.onAttached.addListener(tabId => {
  void serialized(async () => {
    const sessions = await readSessions();
    for (const session of Object.values(sessions)) {
      if (session.mode !== MODE || session.phase !== "active" || session.sourceTabId !== tabId) continue;
      const source = await getTab(tabId);
      // Our initial detach ends in videoWindowId; our return runs in the
      // restoring phase. Only a later external reparenting triggers recovery.
      if (source && source.windowId !== session.videoWindowId) await restoreSession(sessions, session);
    }
  }).catch(() => {});
});

chrome.windows.onRemoved.addListener(windowId => {
  void serialized(async () => {
    const sessions = await readSessions();
    for (const session of Object.values(sessions)) {
      if (session.mode !== MODE) continue;
      if (session.originWindowId === windowId) {
        session.originClosed = true;
        await restoreSession(sessions, session);
      } else if (session.videoWindowId === windowId) {
        if (!await getTab(session.sourceTabId)) await cleanupClosedSource(sessions, session);
        else await restoreSession(sessions, session);
      }
    }
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.status && !change.url && change.discarded !== true) return;
  void serialized(async () => {
    const sessions = await readSessions();
    for (const session of Object.values(sessions)) {
      if (session.mode !== MODE) continue;
      if (session.placeholderTabId === tabId) {
        const url = `${placeholderURL}#${session.id}`;
        // Chrome can report about:blank before the new extension page commits.
        // Recheck that transient against the live tab; real website navigation
        // remains terminal even when the user immediately goes back.
        if ((change.url && change.url !== url && change.url !== "about:blank") || (tab?.pendingUrl && tab.pendingUrl !== url) ||
            await placeholderGone(session)) await closeSession(sessions, session);
      } else if (session.sourceTabId === tabId && (change.status === "loading" || change.discarded === true)) {
        const alive = await tellSource(session, { type: "FSA_SOURCE_ALIVE" });
        if (alive?.alive === false) await restoreSession(sessions, session);
      }
    }
  }).catch(() => {});
});

// Service workers naturally stop while watching a video. Keep valid active
// sessions intact; recover only interrupted transactions or orphaned anchors.
void serialized(async () => {
  const sessions = await readSessions();
  for (const session of Object.values(sessions)) {
    if (session.mode !== MODE) {
      delete sessions[session.id];
      continue;
    }
    const source = await getTab(session.sourceTabId);
    if (!source) { await cleanupClosedSource(sessions, session); continue; }
    const placeholder = await getTab(session.placeholderTabId);
    if (session.phase !== "active" || await placeholderGone(session) || source.windowId === placeholder?.windowId) {
      try { await restoreSession(sessions, session); } catch { /* Retryable metadata is retained. */ }
    }
  }
  await saveSessions(sessions);
}).catch(() => {});

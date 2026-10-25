import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const workerSource = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
const extensionId = "test-extension";
const extensionURL = `chrome-extension://${extensionId}/`;
const clone = value => value === undefined ? undefined : structuredClone(value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class ChromeEvent {
  listeners = new Set();
  addListener = listener => this.listeners.add(listener);
  removeListener = listener => this.listeners.delete(listener);
  hasListener = listener => this.listeners.has(listener);
  emit(...args) {
    for (const listener of [...this.listeners]) listener(...clone(args));
  }
}

function browserFixture({ otherTabs = false, grouped = false, pinned = false } = {}) {
  const state = {
    tabs: new Map(), windows: new Map(), content: new Map(), extensionPages: new Map(), groups: new Set(),
    store: {}, calls: [], messages: [], errors: [], timers: new Set(), clock: 100000,
    nextTab: 100, nextWindow: 20, failMoves: false, noSourceReplies: false,
  };
  let chrome;
  const record = (method, ...args) => {
    state.clock += 20;
    state.calls.push({ method, args: clone(args) });
  };
  const tabsIn = windowId => [...state.tabs.values()].filter(tab => tab.windowId === windowId).sort((a, b) => a.index - b.index);
  const tab = id => {
    const value = state.tabs.get(id);
    if (!value) throw new Error(`No tab with id: ${id}`);
    return value;
  };
  const window = id => {
    const value = state.windows.get(id);
    if (!value) throw new Error(`No window with id: ${id}`);
    return value;
  };
  const windowInfo = (id, options = {}) => {
    const result = clone(window(id));
    if (options.populate) result.tabs = clone(tabsIn(id));
    return result;
  };
  const normalize = windowId => tabsIn(windowId).forEach((item, index) => { item.index = index; });
  const activate = id => {
    const current = tab(id);
    for (const item of tabsIn(current.windowId)) item.active = item.id === id;
  };
  const focus = id => {
    window(id);
    for (const item of state.windows.values()) item.focused = item.id === id;
    queueMicrotask(() => chrome.windows.onFocusChanged.emit(id));
  };
  const removeEmptyWindow = windowId => {
    if (state.windows.has(windowId) && tabsIn(windowId).length === 0) {
      state.windows.delete(windowId);
      queueMicrotask(() => chrome.windows.onRemoved.emit(windowId));
    }
  };
  const createTab = data => {
    const owner = window(data.windowId);
    const list = tabsIn(owner.id);
    let index = Math.max(0, Math.min(data.index ?? list.length, list.length));
    const pinnedCount = list.filter(item => item.pinned).length;
    index = data.pinned ? Math.min(index, pinnedCount) : Math.max(index, pinnedCount);
    for (const item of list) if (item.index >= index) item.index++;
    const item = {
      id: data.id ?? state.nextTab++, windowId: owner.id, index, active: data.active ?? true,
      pinned: !!data.pinned, groupId: data.groupId ?? -1, incognito: !!owner.incognito,
      url: data.url ?? "https://example.test/user-page", status: "complete", title: data.title ?? "User page",
    };
    state.tabs.set(item.id, item);
    if (item.url.startsWith(extensionURL)) state.extensionPages.set(item.id, item.url);
    state.content.set(item.id, { documentId: data.documentId ?? `doc-${item.id}`, position: 37.25, identity: randomUUID() });
    if (item.active || !list.some(existing => existing.active)) activate(item.id);
    if (item.groupId >= 0) state.groups.add(item.groupId);
    return clone(item);
  };
  const removeTab = id => {
    const current = tab(id);
    const { windowId, active, index } = current;
    const closingWindow = tabsIn(windowId).length === 1;
    state.tabs.delete(id);
    state.content.delete(id);
    state.extensionPages.delete(id);
    normalize(windowId);
    if (active && tabsIn(windowId).length) activate(tabsIn(windowId)[Math.max(0, index - 1)]?.id ?? tabsIn(windowId)[0].id);
    for (const groupId of [...state.groups]) if (![...state.tabs.values()].some(item => item.groupId === groupId)) state.groups.delete(groupId);
    queueMicrotask(() => chrome.tabs.onRemoved.emit(id, { windowId, isWindowClosing: closingWindow }));
    removeEmptyWindow(windowId);
  };
  const moveTab = (id, properties, { enforceGroups = true } = {}) => {
    const current = tab(id);
    const sourceId = current.windowId;
    const destinationId = properties.windowId ?? sourceId;
    if (window(sourceId).type !== "normal" || window(destinationId).type !== "normal") throw new Error("Tabs can only move within normal windows");
    const crossWindow = sourceId !== destinationId;
    const previousIndex = current.index;
    const wasActive = current.active;
    const destination = tabsIn(destinationId).filter(item => item.id !== id);
    let index = properties.index < 0 ? destination.length : Math.min(properties.index, destination.length);
    if (crossWindow && enforceGroups && index > 0 && index < destination.length &&
        destination[index - 1].groupId >= 0 && destination[index - 1].groupId === destination[index].groupId) {
      throw new Error("Invalid tab index breaks group contiguity");
    }
    const pinnedCount = destination.filter(item => item.pinned).length;
    index = current.pinned ? Math.min(index, pinnedCount) : Math.max(index, pinnedCount);
    const destinationActive = destination.find(item => item.active)?.id;
    current.windowId = -1;
    normalize(sourceId);
    if (crossWindow && wasActive && tabsIn(sourceId).length) {
      activate(tabsIn(sourceId)[Math.max(0, previousIndex - 1)]?.id ?? tabsIn(sourceId)[0].id);
    }
    current.windowId = destinationId;
    current.index = index;
    current.active = crossWindow ? !destinationActive : wasActive;
    if (crossWindow) current.groupId = -1;
    for (const item of destination) if (item.index >= index) item.index++;
    normalize(destinationId);
    if (current.active) activate(id);
    if (crossWindow) {
      queueMicrotask(() => chrome.tabs.onDetached.emit(id, { oldWindowId: sourceId, oldPosition: previousIndex }));
      queueMicrotask(() => chrome.tabs.onAttached.emit(id, { newWindowId: destinationId, newPosition: current.index }));
      removeEmptyWindow(sourceId);
    }
    for (const groupId of [...state.groups]) if (![...state.tabs.values()].some(item => item.groupId === groupId)) state.groups.delete(groupId);
    return clone(current);
  };

  async function deliverMessage(id, message, options, transport) {
    if (transport === "tabs" && state.extensionPages.has(id)) {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    if (state.beforeSendMessage) await state.beforeSendMessage(id, message, options);
    tab(id);
    state.messages.push({ tabId: id, message: clone(message), options: clone(options), transport });
    if (transport === "tabs" && state.noSourceReplies) throw new Error("Receiving end does not exist");
    if (options?.documentId && options.documentId !== state.content.get(id)?.documentId) throw new Error("Document no longer exists");
    const response = message.type === "FSA_SOURCE_ALIVE" ?
      (Object.hasOwn(state, "sourceAliveResponse") ? state.sourceAliveResponse : { alive: true }) :
      message.type === "FSA_PREPARE_PLACEHOLDER" && Object.hasOwn(state, "placeholderResponse") ? state.placeholderResponse :
      message.type === "FSA_SOURCE_URL" ? { sourceUrl: state.sourceUrl } : { ok: true };
    record(`${transport}.messageResponse`, id, message.type, response);
    return response;
  }

  function makeChrome() {
    return {
      runtime: {
        id: extensionId, getURL: path => extensionURL + path, onMessage: new ChromeEvent(),
        onInstalled: new ChromeEvent(), onStartup: new ChromeEvent(),
        sendMessage: async message => {
          record("runtime.sendMessage", message);
          if (message.type !== "FSA_PREPARE_PLACEHOLDER") return { ok: true };
          const target = [...state.extensionPages].find(([, url]) => url === `${extensionURL}placeholder.html#${message.sessionId}`);
          if (!target) throw new Error("Could not establish connection. Receiving end does not exist.");
          return deliverMessage(target[0], message, undefined, "runtime");
        },
      },
      storage: { session: {
        get: async key => { record("storage.get", key); return clone(key ? { [key]: state.store[key] } : state.store); },
        set: async values => { record("storage.set", values); Object.assign(state.store, clone(values)); },
      } },
      action: { onClicked: new ChromeEvent() },
      windows: {
        onRemoved: new ChromeEvent(), onBoundsChanged: new ChromeEvent(), onFocusChanged: new ChromeEvent(),
        get: async (id, options) => { record("windows.get", id); return windowInfo(id, options); },
        getAll: async options => [...state.windows.keys()].map(id => windowInfo(id, options)),
        create: async data => {
          record("windows.create", data);
          if (state.beforeWindowCreate) await state.beforeWindowCreate();
          const id = state.nextWindow++;
          state.windows.set(id, { id, type: data.type ?? "normal", state: data.state ?? "normal", focused: false, incognito: !!data.incognito, width: 1280, height: 800 });
          if (data.tabId !== undefined) moveTab(data.tabId, { windowId: id, index: 0 });
          else createTab({ windowId: id, url: data.url, active: true });
          if (data.focused !== false) focus(id);
          queueMicrotask(() => chrome.windows.onBoundsChanged.emit(windowInfo(id)));
          return windowInfo(id, { populate: true });
        },
        update: async (id, data) => {
          record("windows.update", id, data);
          Object.assign(window(id), clone(data));
          if (data.focused) focus(id);
          if (data.state) queueMicrotask(() => chrome.windows.onBoundsChanged.emit(windowInfo(id)));
          return windowInfo(id);
        },
        remove: async id => {
          record("windows.remove", id);
          for (const item of [...tabsIn(id)]) removeTab(item.id);
          removeEmptyWindow(id);
        },
      },
      tabs: {
        onRemoved: new ChromeEvent(), onUpdated: new ChromeEvent(), onReplaced: new ChromeEvent(), onAttached: new ChromeEvent(), onDetached: new ChromeEvent(), onMoved: new ChromeEvent(),
        get: async id => { record("tabs.get", id); return clone(tab(id)); },
        query: async filter => {
          record("tabs.query", filter);
          return clone([...state.tabs.values()].filter(item => Object.entries(filter).every(([key, value]) => item[key] === value)));
        },
        create: async data => {
          record("tabs.create", data);
          const created = createTab(data);
          if (state.beforeCreateReturn) await state.beforeCreateReturn(created, data);
          return clone(tab(created.id));
        },
        update: async (id, data) => {
          record("tabs.update", id, data);
          const current = tab(id);
          if (data.url) {
            current.url = data.url;
            state.content.set(id, { documentId: `navigated-${id}`, position: 0, identity: randomUUID() });
            if (data.url.startsWith(extensionURL)) state.extensionPages.set(id, data.url);
            else state.extensionPages.delete(id);
          }
          Object.assign(current, clone(data));
          if (data.active) activate(id);
          if (data.pinned !== undefined) moveTab(id, { index: data.pinned ? 0 : -1 });
          return clone(current);
        },
        move: async (id, data) => {
          record("tabs.move", id, data);
          if (state.failMoves) throw new Error("Tabs cannot be edited right now (user may be dragging a tab).");
          if (state.failReorder && id === 1 && data.windowId === undefined) throw new Error("The final source reorder failed");
          return moveTab(id, data);
        },
        group: async data => {
          record("tabs.group", data);
          if (state.failGroups) throw new Error("Tab group could not be preserved");
          const ids = Array.isArray(data.tabIds) ? data.tabIds : [data.tabIds];
          if (!state.groups.has(data.groupId)) throw new Error("No group with id");
          for (const id of ids) {
            const current = tab(id);
            const members = tabsIn(current.windowId).filter(item => item.groupId === data.groupId && item.id !== id);
            const last = members.at(-1)?.index ?? tabsIn(current.windowId).length - 1;
            moveTab(id, { index: last + 1 - (current.index <= last ? 1 : 0) }, { enforceGroups: false });
            current.groupId = data.groupId;
          }
          return data.groupId;
        },
        ungroup: async ids => {
          record("tabs.ungroup", ids);
          for (const id of Array.isArray(ids) ? ids : [ids]) tab(id).groupId = -1;
          for (const id of [...state.groups]) if (![...state.tabs.values()].some(item => item.groupId === id)) state.groups.delete(id);
        },
        remove: async ids => {
          record("tabs.remove", ids);
          if (state.beforeTabsRemove) await state.beforeTabsRemove(ids);
          for (const id of Array.isArray(ids) ? ids : [ids]) removeTab(id);
        },
        sendMessage: async (id, message, options) => {
          record("tabs.sendMessage", id, message, options);
          return deliverMessage(id, message, options, "tabs");
        },
        reload: async () => { throw new Error("Migration must not reload the real page"); },
        duplicate: async () => { throw new Error("Migration must not duplicate the real page"); },
      },
    };
  }

  const env = {
    state, tabsIn,
    sourceSender(documentId = state.content.get(1)?.documentId) {
      return { id: extensionId, tab: clone(tab(1)), frameId: 0, documentId, url: tab(1).url };
    },
    placeholderSender(session) {
      return { id: extensionId, tab: clone(tab(session.placeholderTabId)), frameId: 0, documentId: state.content.get(session.placeholderTabId)?.documentId,
        url: `${extensionURL}placeholder.html#${session.id}` };
    },
    session: () => Object.values(state.store.fsaSessions ?? {})[0],
    async start({ entered = true } = {}) {
      const result = await env.send({ type: "FSA_START", requestId: "source-request", title: "Original player", preview: "data:image/jpeg;base64,/9j/2Q==" }, env.sourceSender());
      assert.ok(result?.sessionId, `Start failed: ${JSON.stringify(result)}`);
      if (entered) {
        const confirmed = await env.send({ type: "FSA_ENTERED", sessionId: result.sessionId }, env.sourceSender());
        assert.equal(confirmed?.error, undefined);
      }
      return env.session();
    },
    send(message, sender) {
      record("runtime.request", message.type, message);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Runtime request did not respond: ${message.type}`)), 5000);
        const respond = result => {
          clearTimeout(timer);
          record("runtime.respond", message.type, result);
          resolve(clone(result));
        };
        let asynchronous = false;
        for (const listener of [...chrome.runtime.onMessage.listeners]) asynchronous ||= listener(clone(message), clone(sender), respond) === true;
        if (!asynchronous) queueMicrotask(() => respond(undefined));
      });
    },
    async until(predicate, message) {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await delay(5);
      }
      throw new Error(message);
    },
    addUserWindow(id = 70) {
      state.windows.set(id, { id, type: "normal", state: "normal", focused: false, incognito: false, width: 1000, height: 700 });
      return id;
    },
    addUserTab: data => createTab(data),
    moveUserTab: (id, data) => moveTab(id, data),
    activateUserTab: activate,
    focusUserWindow: focus,
    closeUserTab: removeTab,
    updateUserTab(id, change, properties = {}) {
      Object.assign(tab(id), clone(properties), clone(change));
      if (change.url?.startsWith(extensionURL)) state.extensionPages.set(id, change.url);
      else if (change.url && change.url !== "about:blank") state.extensionPages.delete(id);
      chrome.tabs.onUpdated.emit(id, change, tab(id));
    },
    tabMessage: (id, message) => chrome.tabs.sendMessage(id, message),
    workerMessage(message, sender) {
      const responses = [];
      const returns = [...chrome.runtime.onMessage.listeners].map(listener =>
        listener(clone(message), clone(sender), response => responses.push(clone(response))));
      return { responses, returns };
    },
    replaceUserTab(id, url) {
      const previous = clone(tab(id));
      state.tabs.delete(id);
      state.content.delete(id);
      normalize(previous.windowId);
      const replacement = createTab({ windowId: previous.windowId, index: previous.index, active: previous.active, url });
      chrome.tabs.onReplaced.emit(replacement.id, id);
      return replacement;
    },
    closeUserWindow(id) { for (const item of [...tabsIn(id)]) removeTab(item.id); removeEmptyWindow(id); },
    async launch() {
      for (const timer of state.timers) clearTimeout(timer);
      state.timers.clear();
      chrome = makeChrome();
      const TestDate = class extends Date { static now() { return state.clock; } };
      const context = vm.createContext({
        chrome, crypto: { randomUUID }, Date: TestDate, URL, console,
        setTimeout(fn, ms = 0) {
          const handle = setTimeout(() => { state.timers.delete(handle); state.clock += ms; fn(); }, Math.min(ms, 10));
          state.timers.add(handle);
          return handle;
        },
        clearTimeout(handle) { state.timers.delete(handle); clearTimeout(handle); },
      });
      vm.runInContext(workerSource, context, { filename: "service-worker.js" });
      await delay(5);
    },
    dispose() { for (const timer of state.timers) clearTimeout(timer); state.timers.clear(); },
  };
  state.windows.set(10, { id: 10, type: "normal", state: "normal", focused: true, incognito: false, width: 1200, height: 900 });
  chrome = makeChrome();
  if (grouped) {
    createTab({ id: 2, windowId: 10, index: 0, groupId: 41, active: false });
    createTab({ id: 1, windowId: 10, index: 1, groupId: 41, active: true, documentId: "doc-source", url: "https://example.test/video" });
    createTab({ id: 3, windowId: 10, index: 2, groupId: 41, active: false });
    createTab({ id: 4, windowId: 10, index: 3, active: false });
  } else if (pinned) {
    createTab({ id: 2, windowId: 10, index: 0, pinned: true, active: false });
    createTab({ id: 1, windowId: 10, index: 1, pinned: true, active: true, documentId: "doc-source", url: "https://example.test/video" });
    createTab({ id: 3, windowId: 10, index: 2, active: false });
  } else {
    createTab({ id: 1, windowId: 10, index: 0, active: true, documentId: "doc-source", url: "https://example.test/video" });
    if (otherTabs) createTab({ id: 2, windowId: 10, index: 1, active: false });
  }
  return env;
}

const results = [];
const failures = [];
async function test(name, run, options) {
  const env = browserFixture(options);
  try {
    await env.launch();
    await run(env);
    assert.deepEqual(env.state.errors, []);
    results.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.stack || error}`);
  } finally { env.dispose(); }
}

await test("creates a placeholder before detaching a sole real tab into a normal fullscreen window", async env => {
  const content = env.state.content.get(1);
  const session = await env.start();
  assert.equal(env.state.windows.has(10), true, "The original browser must not disappear when it had one tab");
  assert.equal(env.state.tabs.get(session.placeholderTabId).windowId, 10);
  assert.equal(env.state.tabs.get(session.placeholderTabId).active, true, "The selected source slot must remain selected through its placeholder");
  assert.equal(env.state.content.get(1), content, "The same document and media position must survive detaching");
  const videoWindow = env.state.windows.get(env.state.tabs.get(1).windowId);
  assert.equal(videoWindow.type, "normal");
  assert.equal(videoWindow.state, "fullscreen");
  const create = env.state.calls.findIndex(call => call.method === "tabs.create");
  const detach = env.state.calls.findIndex(call => call.method === "windows.create");
  assert.ok(create >= 0 && create < detach);
  assert.equal(env.state.calls[detach].args[0].tabId, 1);
  const selectPlaceholder = env.state.calls.findIndex(call => call.method === "tabs.update" &&
    call.args[0] === session.placeholderTabId && call.args[1].active === true);
  assert.ok(selectPlaceholder > detach, "Select the placeholder after detaching the source, so the original document is not hidden prematurely");
  assert.equal(env.state.calls.some(call => call.method === "tabs.update" && call.args[1].url), false);
  const activeBroadcast = env.state.calls.findIndex(call => call.method === "tabs.sendMessage" && call.args[1].type === "FSA_TAB_ACTIVE");
  const startReply = env.state.calls.findIndex(call => call.method === "runtime.respond" && call.args[0] === "FSA_START");
  assert.ok(activeBroadcast > detach && activeBroadcast < startReply,
    "All ancestors must receive the tab session before the source can enter native fullscreen");
  const broadcast = env.state.calls[activeBroadcast].args;
  assert.equal(broadcast[0], 1);
  assert.equal(broadcast[1].sessionId, session.id);
  assert.equal(broadcast[2], undefined, "A tab broadcast must not filter frames or documents");
});

for (const initialURL of ["", "about:blank"]) {
  await test(`a newly created ${initialURL || "empty-URL"} placeholder with the expected pending URL does not close its video`, async env => {
    const content = env.state.content.get(1);
    let preparedBeforeCommit = false;
    env.state.beforeCreateReturn = async (created, data) => {
      env.updateUserTab(created.id, { url: initialURL, status: "loading" }, { pendingUrl: data.url });
    };
    env.state.beforeSendMessage = async (id, message) => {
      if (message.type !== "FSA_PREPARE_PLACEHOLDER") return;
      const placeholder = env.state.tabs.get(id);
      assert.equal(placeholder.url, initialURL);
      assert.equal(placeholder.pendingUrl, `${extensionURL}placeholder.html#${message.sessionId}`);
      assert.equal(env.state.tabs.get(1).windowId, env.session().videoWindowId, "The source must enter its own video window before the placeholder appears");
      assert.equal(env.session().entered, true);
      preparedBeforeCommit = true;
      env.updateUserTab(id, { url: placeholder.pendingUrl, status: "complete" }, { pendingUrl: undefined });
    };
    const session = await env.start();
    await env.send({ type: "FSA_PLACEHOLDER_READY", sessionId: session.id }, env.placeholderSender(session));
    assert.equal(preparedBeforeCommit, true, "A pending owned placeholder must reach its preparation handshake");
    assert.equal(env.state.tabs.get(1).windowId, session.videoWindowId);
    assert.equal(env.state.content.get(1), content);
    assert.equal(env.session()?.phase, "active");
    assert.equal(env.state.calls.some(call => call.method === "tabs.remove"), false);
  });
}

await test("a loading placeholder with no exposed URL waits for its own preparation and commits without losing the source", async env => {
  const content = env.state.content.get(1);
  let prepared = false;
  env.state.beforeCreateReturn = async created => {
    env.updateUserTab(created.id, { url: "", status: "loading" }, { pendingUrl: undefined });
  };
  env.state.beforeSendMessage = async (id, message) => {
    if (message.type !== "FSA_PREPARE_PLACEHOLDER") return;
    const placeholder = env.state.tabs.get(id);
    assert.equal(placeholder.url, "");
    assert.equal(placeholder.pendingUrl, undefined);
    assert.equal(env.state.tabs.get(1).windowId, env.session().videoWindowId);
    assert.equal(env.session().entered, true);
    assert.equal(env.state.calls.some(call => call.method === "windows.create"), true);
    prepared = true;
    env.updateUserTab(id, { url: `${extensionURL}placeholder.html#${message.sessionId}`, status: "complete" });
  };
  const session = await env.start();
  await env.send({ type: "FSA_PLACEHOLDER_READY", sessionId: session.id }, env.placeholderSender(session));
  assert.equal(prepared, true);
  assert.equal(env.session()?.phase, "active");
  assert.equal(env.state.tabs.get(1).windowId, session.videoWindowId);
  assert.equal(env.state.content.get(1), content);
  assert.equal(env.state.calls.some(call => call.method === "tabs.remove"), false);
});

await test("a video enters fullscreen before placeholder readiness and survives a failed placeholder presentation", async env => {
  const content = env.state.content.get(1);
  for (const response of [undefined, { ok: false }]) {
    env.state.placeholderResponse = response;
    env.state.beforeCreateReturn = async (created, data) => {
      env.updateUserTab(created.id, { url: "about:blank", status: "loading" }, { pendingUrl: data.url });
    };
    const before = env.state.calls.length;
    const result = await env.send({ type: "FSA_START", requestId: `unready-${String(response?.ok)}`, title: "Original player" }, env.sourceSender());
    assert.ok(result?.sessionId, "Placeholder readiness must not gate source-window creation");
    const session = env.session();
    assert.equal(env.state.tabs.get(1).windowId, session.videoWindowId);
    assert.equal(env.state.windows.get(session.videoWindowId).state, "fullscreen");
    assert.equal(env.state.calls.slice(before).some(call => call.method === "runtime.sendMessage" && call.args[0].type === "FSA_PREPARE_PLACEHOLDER"), false);
    const confirmed = await env.send({ type: "FSA_ENTERED", sessionId: session.id }, env.sourceSender());
    assert.equal(confirmed?.error, undefined);
    assert.equal(env.session()?.entered, true);
    assert.notEqual(env.session()?.placeholderReady, true);
    assert.equal(env.state.tabs.get(1).windowId, session.videoWindowId);
    assert.equal(env.state.content.get(1), content);
    assert.equal(env.state.tabs.has(2), true);
    assert.equal(env.state.calls.slice(before).some(call => call.method === "tabs.remove" &&
      (Array.isArray(call.args[0]) ? call.args[0] : [call.args[0]]).includes(1)), false);
    assert.equal((await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, env.placeholderSender(session)))?.error, undefined);
    assert.equal(env.state.tabs.get(1).windowId, 10);
  }
}, { otherTabs: true });

await test("a queued blank URL report cannot terminate a placeholder that has already committed", async env => {
  env.state.beforeWindowCreate = async () => {
    const { placeholderTabId, id } = env.session();
    env.updateUserTab(placeholderTabId, { url: "about:blank", status: "loading" });
    env.updateUserTab(placeholderTabId, { url: `${extensionURL}placeholder.html#${id}`, status: "complete" });
  };
  const session = await env.start();
  await env.send({ type: "FSA_PLACEHOLDER_READY", sessionId: session.id }, env.placeholderSender(session));
  assert.equal(env.session()?.phase, "active");
  assert.equal(env.state.tabs.get(1).windowId, session.videoWindowId);
  assert.equal(env.state.tabs.has(session.placeholderTabId), true);
  assert.equal(env.state.calls.some(call => call.method === "tabs.remove"), false);
});

await test("placeholder presentation waits until the source reports entered fullscreen", async env => {
  let releasePlaceholder;
  let sawPlaceholder;
  const placeholderGate = new Promise(resolve => { releasePlaceholder = resolve; });
  const placeholderSeen = new Promise(resolve => { sawPlaceholder = resolve; });
  env.state.beforeSendMessage = async (id, message) => {
    if (message.type === "FSA_PREPARE_PLACEHOLDER") { sawPlaceholder(); await placeholderGate; }
  };
  const started = env.start();
  try {
    await placeholderSeen;
    assert.equal(env.state.calls.some(call => call.method === "windows.create"), true,
      "The real source window must already exist before preparing the visible placeholder");
    assert.equal(env.session().entered, true);
    assert.equal(env.state.tabs.get(1).windowId, env.session().videoWindowId);
    assert.equal(env.state.messages.some(item => item.message.type === "FSA_PREPARE_MOVE"), false,
      "Do not expand or blur the original player before its tab is detached");
  } finally { releasePlaceholder(); }
  const session = await started;
  const createIndex = env.state.calls.findIndex(call => call.method === "windows.create");
  const enteredIndex = env.state.calls.findIndex(call => call.method === "runtime.request" && call.args[0] === "FSA_ENTERED");
  const requestIndex = env.state.calls.findIndex(call => call.method === "runtime.sendMessage" && call.args[0].type === "FSA_PREPARE_PLACEHOLDER");
  const responseIndex = env.state.calls.findIndex(call => call.method === "runtime.messageResponse" && call.args[1] === "FSA_PREPARE_PLACEHOLDER");
  assert.ok(createIndex >= 0 && enteredIndex > createIndex && requestIndex > enteredIndex,
    "Only an already-entered source may trigger visible placeholder presentation");
  assert.ok(responseIndex > requestIndex, "Extension pages acknowledge through runtime messaging");
  const placeholderRequest = env.state.messages.find(item => item.message.type === "FSA_PREPARE_PLACEHOLDER");
  assert.equal(placeholderRequest.tabId, session.placeholderTabId);
  assert.equal(placeholderRequest.transport, "runtime");
  assert.equal(env.state.calls.some(call => call.method === "tabs.sendMessage" && call.args[0] === session.placeholderTabId), false);
  assert.equal(placeholderRequest.message.preview, session.preview);
  assert.equal(placeholderRequest.message.title, session.title);
  assert.equal(placeholderRequest.message.sourceUrl, session.sourceUrl);
  assert.equal(env.session().placeholderReady, true);
});

await test("a guarded source startup exposes only pending until it enters fullscreen", async env => {
  const session = await env.start({ entered: false });
  assert.equal(env.state.windows.get(session.videoWindowId).state, "fullscreen");
  assert.equal(env.state.tabs.get(1).windowId, session.videoWindowId);
  assert.equal(env.state.calls.some(call => call.method === "runtime.sendMessage" && call.args[0].type === "FSA_PREPARE_PLACEHOLDER"), false);
  const sender = env.placeholderSender(session);
  assert.deepEqual(await env.send({ type: "FSA_PLACEHOLDER_READY", sessionId: session.id }, sender), { pending: true });
  assert.equal((await env.send({ type: "FSA_ENTERED", sessionId: session.id }, env.sourceSender()))?.error, undefined);
  const ready = await env.send({ type: "FSA_PLACEHOLDER_READY", sessionId: session.id }, sender);
  assert.equal(ready.title, session.title);
  assert.equal(ready.preview, session.preview);
  assert.equal(ready.sourceUrl, session.sourceUrl);
  assert.equal(env.session().placeholderReady, true);
});

await test("the worker never answers a placeholder preparation broadcast and extension pages reject content-script messaging", async env => {
  const session = await env.start();
  const message = { type: "FSA_PREPARE_PLACEHOLDER", sessionId: session.id };
  const result = env.workerMessage(message, env.sourceSender());
  assert.deepEqual(result.responses, [], "Only the matching placeholder extension page may acknowledge its own readiness");
  assert.equal(result.returns.every(value => value === undefined), true, "The worker must not queue the broadcast behind START");
  await assert.rejects(env.tabMessage(session.placeholderTabId, message), /Receiving end does not exist/,
    "tabs.sendMessage reaches content scripts, not an extension page's runtime listener");
  assert.equal(env.session()?.phase, "active");
  assert.equal(env.state.tabs.get(1).windowId, session.videoWindowId);
});

await test("restore focuses the original browser before preparing its background video and moving it home", async env => {
  const session = await env.start();
  const before = env.state.calls.length;
  const result = await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, env.placeholderSender(session));
  assert.equal(result?.error, undefined);
  const calls = env.state.calls.slice(before);
  const prepareIndex = calls.findIndex(call => call.method === "tabs.sendMessage" && call.args[1].type === "FSA_PREPARE_RESTORE");
  const ackIndex = calls.findIndex(call => call.method === "tabs.messageResponse" && call.args[1] === "FSA_PREPARE_RESTORE");
  const focusIndex = calls.findIndex(call => call.method === "windows.update" && call.args[0] === 10 && call.args[1].focused === true);
  const moveIndex = calls.findIndex(call => call.method === "tabs.move" && call.args[0] === 1);
  assert.ok(focusIndex >= 0 && prepareIndex > focusIndex, "Hide native exit/layout restoration behind the focused placeholder window");
  assert.ok(ackIndex > prepareIndex && moveIndex > ackIndex, "Return the real tab only after its background layout and cover are prepared");
  assert.equal(env.state.tabs.get(1).windowId, 10);
});

await test("moving the placeholder during the restore ACK updates focus and returns the same video to its new window", async env => {
  const session = await env.start();
  const content = env.state.content.get(1);
  env.addUserWindow(70);
  env.addUserTab({ id: 40, windowId: 70, active: true });
  let release;
  let preparationSeen;
  const gate = new Promise(resolve => { release = resolve; });
  const preparing = new Promise(resolve => { preparationSeen = resolve; });
  env.state.beforeSendMessage = async (id, message) => {
    if (message.type === "FSA_PREPARE_RESTORE") { preparationSeen(); await gate; }
  };
  const before = env.state.calls.length;
  const restored = env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, env.placeholderSender(session));
  try {
    await preparing;
    env.moveUserTab(session.placeholderTabId, { windowId: 70, index: 1 });
    env.activateUserTab(session.placeholderTabId);
  } finally { release(); }
  const result = await restored;
  assert.equal(result?.error, undefined);
  const focusCalls = env.state.calls.slice(before).filter(call => call.method === "windows.update" && call.args[1].focused === true);
  assert.deepEqual(focusCalls.map(call => call.args[0]), [10, 70], "Follow an anchor moved during background preparation before revealing its returned video");
  assert.equal(env.state.windows.get(70).focused, true);
  assert.equal(env.state.tabs.get(1).windowId, 70);
  assert.equal(env.state.tabs.get(1).index, 1);
  assert.equal(env.state.tabs.get(1).active, true);
  assert.equal(env.state.content.get(1), content);
  assert.equal(env.state.tabs.get(2).windowId, 10);
  assert.equal(env.state.tabs.get(40).windowId, 70);
  assert.equal(env.state.tabs.has(session.placeholderTabId), false);
  assert.equal(env.session(), undefined);
}, { otherTabs: true });

await test("moving the placeholder during a return does not steal focus from a user-selected third window", async env => {
  const session = await env.start();
  env.addUserWindow(70);
  env.addUserTab({ id: 40, windowId: 70, active: true });
  env.addUserWindow(90);
  env.addUserTab({ id: 50, windowId: 90, active: true });
  let release;
  let preparationSeen;
  const gate = new Promise(resolve => { release = resolve; });
  const preparing = new Promise(resolve => { preparationSeen = resolve; });
  env.state.beforeSendMessage = async (id, message) => {
    if (message.type === "FSA_PREPARE_RESTORE") { preparationSeen(); await gate; }
  };
  const before = env.state.calls.length;
  const restored = env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, env.placeholderSender(session));
  try {
    await preparing;
    env.moveUserTab(session.placeholderTabId, { windowId: 70, index: 1 });
    env.activateUserTab(session.placeholderTabId);
    env.focusUserWindow(90);
  } finally { release(); }
  assert.equal((await restored)?.error, undefined);
  const focusCalls = env.state.calls.slice(before).filter(call => call.method === "windows.update" && call.args[1].focused === true);
  assert.deepEqual(focusCalls.map(call => call.args[0]), [10], "A user's new foreground window must take precedence over following the moved placeholder");
  assert.equal(env.state.windows.get(90).focused, true);
  assert.equal(env.state.tabs.get(1).windowId, 70);
  assert.equal(env.state.tabs.get(50).windowId, 90);
  assert.equal(env.session(), undefined);
}, { otherTabs: true });

await test("an initially inactive source keeps the original browser's selected tab", async env => {
  env.activateUserTab(2);
  const session = await env.start();
  assert.equal(env.state.tabs.get(2).active, true);
  assert.equal(env.state.tabs.get(session.placeholderTabId).active, false);
  assert.equal(env.state.calls.some(call => call.method === "tabs.update" &&
    call.args[0] === session.placeholderTabId && call.args[1].active === true), false);
  const result = await env.send({ type: "FSA_EXIT_REQUEST", requestId: session.requestId }, env.sourceSender());
  assert.equal(result?.error, undefined);
  assert.equal(env.state.tabs.get(1).windowId, 10);
  assert.equal(env.state.tabs.get(2).active, true);
  assert.equal(env.state.tabs.get(1).active, false);
}, { otherTabs: true });

await test("unauthorized starts and mismatched source documents cannot mutate the session", async env => {
  const content = env.state.content.get(1);
  const sender = env.sourceSender();
  const deniedStart = await env.send({ type: "FSA_START", requestId: "unauthorized", title: "spoof" },
    { ...sender, id: "another-extension" });
  assert.ok(deniedStart?.error);
  assert.equal(env.state.tabs.get(1).windowId, 10);
  assert.equal(env.state.content.get(1), content);
  assert.equal(env.state.calls.some(call => call.method === "tabs.create" || call.method === "windows.create"), false);
  const session = await env.start();
  const videoWindowId = env.state.tabs.get(1).windowId;
  const deniedExit = await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id },
    { ...env.sourceSender(), documentId: "unrelated-document" });
  assert.ok(deniedExit?.error);
  assert.equal(env.state.tabs.get(1).windowId, videoWindowId);
  assert.equal(env.session().id, session.id);
});

await test("validates placeholder identity before returning preview metadata", async env => {
  const session = await env.start();
  const sender = env.placeholderSender(session);
  const ready = await env.send({ type: "FSA_PLACEHOLDER_READY", sessionId: session.id }, sender);
  assert.equal(ready.title, "Original player");
  assert.equal(ready.preview, "data:image/jpeg;base64,/9j/2Q==");
  assert.equal(Object.hasOwn(ready, "expandToken"), false, "The placeholder must not receive the private expansion token");
  const denied = await env.send({ type: "FSA_PLACEHOLDER_READY", sessionId: session.id }, { ...sender, url: "https://example.test/spoof" });
  assert.ok(denied?.error, "A page that is not the owned placeholder must not receive session data");
});

await test("the trusted source tab URL overrides page-provided history metadata", async env => {
  const sender = env.sourceSender();
  const started = await env.send({ type: "FSA_START", requestId: "trusted-history-url", sourceUrl: "https://spoof.test/not-the-original-page" }, sender);
  const session = env.session();
  assert.equal(started.sessionId, session.id);
  assert.equal(session.sourceUrl, "https://example.test/video");
  await env.send({ type: "FSA_ENTERED", sessionId: session.id }, env.sourceSender());
  const prepared = env.state.messages.find(item => item.message.type === "FSA_PREPARE_PLACEHOLDER");
  assert.equal(prepared.message.sourceUrl, "https://example.test/video");
  const ready = await env.send({ type: "FSA_PLACEHOLDER_READY", sessionId: session.id }, env.placeholderSender(session));
  assert.equal(ready.sourceUrl, "https://example.test/video");
  assert.equal(env.state.messages.some(item => item.message.type === "FSA_SOURCE_URL"), false);
});

await test("a child source with a hidden tab URL obtains only the top frame history URL", async env => {
  for (const sourceUrl of ["https://top.test/watch?id=original", undefined]) {
    env.state.sourceUrl = sourceUrl;
    const sender = { ...env.sourceSender(), frameId: 7 };
    delete sender.tab.url;
    const started = await env.send({ type: "FSA_START", requestId: `child-history-${sourceUrl ? "known" : "unknown"}`, sourceUrl: "https://iframe.test/embed/must-not-be-restored" }, sender);
    const session = env.session();
    assert.equal(started.sessionId, session.id);
    assert.equal(session.sourceUrl, sourceUrl || null, "A failed top-frame lookup must not fall back to the iframe document URL");
    const queried = env.state.messages.filter(item => item.message.type === "FSA_SOURCE_URL").at(-1);
    assert.equal(queried.tabId, 1);
    assert.deepEqual(queried.options, { frameId: 0 });
    assert.equal((await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, env.placeholderSender(session)))?.error, undefined);
  }
});

await test("history metadata rejects invalid URLs and marks ended placeholder sessions explicitly", async env => {
  const rejected = ["javascript:alert(1)", "data:text/html,private", "file:///tmp/private.html", "chrome-extension://test-extension/placeholder.html", "not a URL", "https://example.test/" + "x".repeat(8192)];
  for (let i = 0; i < rejected.length; i++) {
    const sender = env.sourceSender();
    delete sender.tab.url;
    const started = await env.send({ type: "FSA_START", requestId: `invalid-history-${i}`, sourceUrl: rejected[i] }, sender);
    const session = env.session();
    assert.equal(started.sessionId, session.id);
    assert.equal(session.sourceUrl, null, "Only bounded HTTP(S) URLs may be used for placeholder back navigation");
    const placeholderSender = env.placeholderSender(session);
    assert.equal((await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, placeholderSender))?.error, undefined);
    const ended = await env.send({ type: "FSA_PLACEHOLDER_READY", sessionId: session.id }, placeholderSender);
    assert.equal(ended.sessionEnded, true);
    assert.ok(ended.error);
    assert.equal(Object.hasOwn(ended, "sourceUrl"), false);
  }
});

await test("private expansion tokens authorize only active ancestors in the real source tab", async env => {
  const request = { type: "FSA_START", requestId: "private-expansion", title: "Original player" };
  const started = await env.send(request, env.sourceSender());
  const session = env.session();
  assert.equal(started.sessionId, session.id);
  assert.equal(typeof started.expandToken, "string");
  assert.ok(started.expandToken.length >= 32);
  assert.equal(started.expandToken, session.expandToken);
  const windowsBefore = env.state.calls.filter(call => call.method === "windows.create").length;
  const repeated = await env.send(request, env.sourceSender());
  assert.equal(repeated.expandToken, started.expandToken, "Idempotent source requests retain the same private capability");
  assert.equal(env.state.calls.filter(call => call.method === "windows.create").length, windowsBefore);
  const ancestor = { ...env.sourceSender(), frameId: 7, documentId: "ancestor-document" };
  const allowed = { type: "FSA_EXPAND_ALLOWED", sessionId: session.id, token: started.expandToken };
  assert.deepEqual(await env.send(allowed, ancestor), { ok: true }, "Ancestor documents can differ from the original source frame");
  assert.ok((await env.send({ ...allowed, token: "wrong-token" }, ancestor))?.error);
  assert.ok((await env.send({ ...allowed, token: undefined }, ancestor))?.error);
  const other = env.addUserTab({ windowId: 10, active: false });
  assert.ok((await env.send(allowed, { ...ancestor, tab: other }))?.error);
  assert.ok((await env.send(allowed, { ...ancestor, id: "another-extension" }))?.error);
  assert.ok((await env.send(allowed, env.placeholderSender(session)))?.error);
  for (const phase of ["preparing", "moving", "restoring", "restore_failed"]) {
    env.state.store.fsaSessions[session.id].phase = phase;
    assert.ok((await env.send(allowed, ancestor))?.error, `Expansion must be denied in phase ${phase}`);
  }
  env.state.store.fsaSessions[session.id].phase = "active";
  const ready = await env.send({ type: "FSA_PLACEHOLDER_READY", sessionId: session.id }, env.placeholderSender(session));
  assert.equal(JSON.stringify(ready).includes(started.expandToken), false);
  for (const item of env.state.messages.filter(item => ["FSA_TAB_ACTIVE", "FSA_TAB_RESTORED"].includes(item.message.type))) {
    assert.equal(item.message.sessionId, session.id);
    assert.equal(JSON.stringify(item.message).includes(started.expandToken), false, "Tab-wide broadcasts must never leak the private token");
  }
});

await test("tab-state queries disclose only the caller tab's managed session and phase", async env => {
  const session = await env.start();
  const ancestor = { ...env.sourceSender(), frameId: 8, documentId: "different-ancestor-document" };
  for (const phase of ["preparing", "moving", "moved", "active", "restoring", "restore_failed"]) {
    env.state.store.fsaSessions[session.id].phase = phase;
    const result = await env.send({ type: "FSA_TAB_STATE" }, ancestor);
    assert.deepEqual(result, { sessionId: session.id, phase });
    assert.equal(JSON.stringify(result).includes(session.expandToken), false);
  }
  env.state.store.fsaSessions[session.id].phase = "active";
  const other = env.addUserTab({ windowId: 10, active: false });
  assert.deepEqual(await env.send({ type: "FSA_TAB_STATE", tabId: 1 }, { ...ancestor, tab: other }), { sessionId: null },
    "The caller cannot request another tab's state by passing a tab ID");
  assert.deepEqual(await env.send({ type: "FSA_TAB_STATE" }, env.placeholderSender(session)), { sessionId: null });
  assert.ok((await env.send({ type: "FSA_TAB_STATE" }, { ...ancestor, id: "another-extension" }))?.error);
  assert.ok((await env.send({ type: "FSA_TAB_STATE" }, { id: extensionId }))?.error);
  delete env.state.store.fsaSessions[session.id];
  assert.deepEqual(await env.send({ type: "FSA_TAB_STATE" }, ancestor), { sessionId: null });
});

await test("ancestor tab-state queries do not wait behind an in-flight move transaction", async env => {
  let entered = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  env.state.beforeWindowCreate = async () => { entered = true; await gate; };
  const sender = env.sourceSender();
  const started = env.send({ type: "FSA_START", requestId: "query-during-move", title: "Original player" }, sender);
  await env.until(() => entered, "Expected the transaction to be waiting for its new window");
  let result;
  const queried = env.send({ type: "FSA_TAB_STATE" }, { ...sender, frameId: 3, documentId: "parent-frame" }).then(value => { result = value; });
  try {
    await Promise.race([queried, delay(60)]);
    assert.ok(result?.sessionId, "A parent fullscreen guard must receive its answer before the pending move completes");
    assert.equal(result.phase, "moving");
  } finally {
    release();
    await started;
    await queried;
  }
});

await test("a concurrent START from another frame never replaces the tab's managed session", async env => {
  let entered = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  env.state.beforeWindowCreate = async () => { entered = true; await gate; };
  const owner = env.sourceSender();
  const originalRequest = { type: "FSA_START", requestId: "owned-start", title: "Original player" };
  const original = env.send(originalRequest, owner);
  await env.until(() => entered, "Expected the original frame's startup transaction");
  const competing = env.send({ type: "FSA_START", requestId: "competing-frame" },
    { ...owner, frameId: 7, documentId: "other-frame-document" });
  release();
  const started = await original;
  assert.ok(started?.sessionId);
  assert.ok((await competing)?.error);
  assert.equal(env.session().id, started.sessionId);
  assert.equal(env.state.tabs.get(1).windowId, env.session().videoWindowId);
  assert.equal(env.state.calls.filter(call => call.method === "windows.create").length, 1);
  assert.equal(env.state.messages.some(item => item.message.type === "FSA_PREPARE_RESTORE"), false,
    "A competing frame must not restore and detach the original owner's tab again");
  const repeated = await env.send(originalRequest, env.sourceSender());
  assert.equal(repeated.sessionId, started.sessionId);
  assert.equal(repeated.expandToken, started.expandToken);
  for (const phase of ["preparing", "moving", "moved", "active", "restoring", "restore_failed"]) {
    env.state.store.fsaSessions[started.sessionId].phase = phase;
    const result = await env.send({ type: "FSA_START", requestId: `competing-${phase}` },
      { ...env.sourceSender(), frameId: 8 });
    assert.ok(result?.error, `A different frame cannot replace managed phase ${phase}`);
    assert.equal(env.session().id, started.sessionId);
  }
  env.state.store.fsaSessions[started.sessionId].phase = "active";
});

await test("pages cannot forge tab-wide session coordination messages", async env => {
  const session = await env.start();
  const videoWindowId = env.state.tabs.get(1).windowId;
  const before = env.state.calls.length;
  for (const sender of [env.sourceSender(), env.placeholderSender(session), { ...env.sourceSender(), id: "another-extension" }]) {
    for (const type of ["FSA_TAB_ACTIVE", "FSA_TAB_RESTORED"]) {
      const result = await env.send({ type, sessionId: session.id }, sender);
      assert.ok(result?.error, "Coordination broadcasts can only originate in the worker");
    }
  }
  assert.equal(env.session().id, session.id);
  assert.equal(env.session().phase, "active");
  assert.equal(env.state.tabs.get(1).windowId, videoWindowId);
  assert.equal(env.state.calls.slice(before).some(call => call.method === "tabs.sendMessage" || call.method === "tabs.move"), false);
});

await test("restores the real tab to the placeholder's current window and index", async env => {
  const content = env.state.content.get(1);
  const session = await env.start();
  env.addUserWindow(70);
  env.addUserTab({ id: 40, windowId: 70, active: true });
  env.moveUserTab(session.placeholderTabId, { windowId: 70, index: 1 });
  env.activateUserTab(session.placeholderTabId);
  env.focusUserWindow(70);
  const result = await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, env.placeholderSender(session));
  assert.equal(result?.error, undefined);
  assert.equal(env.state.tabs.get(1).windowId, 70);
  assert.equal(env.state.tabs.get(1).index, 1);
  assert.equal(env.state.tabs.get(1).active, true);
  assert.equal(env.state.content.get(1), content);
  assert.equal(env.state.tabs.has(session.placeholderTabId), false);
  assert.equal(env.session(), undefined);
  assert.ok(env.state.messages.some(item => item.message.type === "FSA_RESTORED"));
  const cleared = env.state.messages.findIndex(item => item.message.type === "FSA_TAB_RESTORED");
  const restored = env.state.messages.findIndex(item => item.message.type === "FSA_RESTORED");
  assert.ok(cleared >= 0 && cleared < restored, "Ancestor CSS must clear before the source's live blur restoration");
  assert.equal(env.state.messages[cleared].message.sessionId, session.id);
  assert.equal(env.state.messages[cleared].options, undefined);
  assert.equal(Object.hasOwn(env.state.messages[cleared].message, "expandToken"), false);
  assert.equal(Object.hasOwn(env.state.messages[cleared].message, "token"), false);
}, { otherTabs: true });

await test("background restoration preserves the browser's other active tab and window focus", async env => {
  const session = await env.start();
  env.activateUserTab(2);
  env.addUserWindow(70);
  env.addUserTab({ id: 40, windowId: 70, active: true });
  env.focusUserWindow(70);
  const before = env.state.calls.length;
  const result = await env.send({ type: "FSA_EXIT_REQUEST", requestId: session.requestId }, env.sourceSender());
  assert.equal(result?.error, undefined);
  assert.equal(env.state.tabs.get(2).active, true);
  assert.equal(env.state.tabs.get(1).active, false);
  assert.equal(env.state.windows.get(70).focused, true);
  assert.equal(env.state.calls.slice(before).some(call => call.method === "windows.update" && call.args[1].focused), false);
}, { otherTabs: true });

await test("restoring the source does not close user tabs added to the independent window", async env => {
  const session = await env.start();
  const videoWindowId = env.state.tabs.get(1).windowId;
  env.addUserTab({ id: 40, windowId: videoWindowId, active: false, url: "https://example.test/new-user-tab" });
  const result = await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, env.placeholderSender(session));
  assert.equal(result?.error, undefined);
  assert.equal(env.state.tabs.get(1).windowId, 10);
  assert.equal(env.state.tabs.get(40).windowId, videoWindowId);
  assert.equal(env.state.windows.has(videoWindowId), true);
  assert.equal(env.state.tabs.get(40).url, "https://example.test/new-user-tab");
});

await test("manual reparenting of an active source restores it without closing either user window", async env => {
  const content = env.state.content.get(1);
  const session = await env.start();
  const videoWindowId = env.state.tabs.get(1).windowId;
  // Keep this window alive so only onAttached, not onRemoved, can initiate recovery.
  env.addUserTab({ id: 41, windowId: videoWindowId, active: false });
  env.addUserWindow(70);
  env.addUserTab({ id: 40, windowId: 70, active: true });
  env.moveUserTab(1, { windowId: 70, index: 1 });
  await env.until(() => env.session() === undefined && env.state.tabs.get(1)?.windowId === 10,
    "An externally reparented active source must return through the normal recovery path");
  assert.equal(env.state.content.get(1), content);
  assert.equal(env.state.tabs.has(session.placeholderTabId), false);
  assert.equal(env.state.tabs.get(40).windowId, 70);
  assert.equal(env.state.tabs.get(41).windowId, videoWindowId);
  assert.equal(env.state.windows.has(70), true);
  assert.equal(env.state.windows.has(videoWindowId), true);
});

await test("the worker's own detach and restore attachment events do not trigger recovery loops", async env => {
  const session = await env.start();
  await delay(25);
  assert.equal(env.session().id, session.id);
  assert.equal(env.state.tabs.get(1).windowId, session.videoWindowId);
  assert.equal(env.state.messages.some(item => item.message.type === "FSA_PREPARE_RESTORE"), false);
  const restored = await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, env.placeholderSender(session));
  assert.equal(restored?.error, undefined);
  await delay(25);
  assert.equal(env.session(), undefined);
  assert.equal(env.state.tabs.get(1).windowId, 10);
  assert.equal(env.state.messages.filter(item => item.message.type === "FSA_PREPARE_RESTORE").length, 1);
  assert.equal(env.state.calls.filter(call => call.method === "windows.create").length, 1);
});

await test("restores grouped tabs without cross-window insertion into the middle of a group", async env => {
  const session = await env.start();
  assert.equal(env.state.tabs.get(session.placeholderTabId).groupId, 41, "The placeholder must keep the original group alive");
  const result = await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, env.placeholderSender(session));
  assert.equal(result?.error, undefined);
  assert.equal(env.state.tabs.get(1).groupId, 41);
  assert.equal(env.state.tabs.get(1).index, 1);
  assert.equal(env.state.groups.has(41), true);
  assert.equal(env.state.tabs.has(session.placeholderTabId), false);
}, { grouped: true });

await test("failed placeholder grouping leaves the untouched original tab layout and document intact", async env => {
  const original = clone(env.state.tabs.get(1));
  const content = env.state.content.get(1);
  env.state.failGroups = true;
  const failed = await env.send({ type: "FSA_START", requestId: "group-failed", title: "Original player" }, env.sourceSender());
  assert.ok(failed?.error);
  const source = env.state.tabs.get(1);
  assert.equal(source.windowId, original.windowId);
  assert.equal(source.index, original.index);
  assert.equal(source.pinned, original.pinned);
  assert.equal(source.groupId, original.groupId);
  assert.equal(env.state.content.get(1), content);
  assert.equal(env.state.tabs.size, 4, "Only the failed placeholder may be removed");
  assert.equal(env.state.calls.some(call => call.method === "windows.create"), false);
  assert.equal(env.session(), undefined);
}, { grouped: true });

await test("restores the original pinned position while retaining the real tab", async env => {
  const content = env.state.content.get(1);
  const session = await env.start();
  assert.equal(env.state.tabs.get(session.placeholderTabId).pinned, true);
  const result = await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, env.placeholderSender(session));
  assert.equal(result?.error, undefined);
  assert.equal(env.state.tabs.get(1).pinned, true);
  assert.equal(env.state.tabs.get(1).index, 1);
  assert.equal(env.state.content.get(1), content);
}, { pinned: true });

await test("a move failure keeps the real page and session available for retry", async env => {
  const content = env.state.content.get(1);
  const session = await env.start();
  const sender = env.placeholderSender(session);
  env.state.failMoves = true;
  const before = env.state.messages.length;
  const failed = await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, sender);
  assert.ok(failed?.error);
  assert.equal(env.state.content.get(1), content);
  assert.equal(env.state.tabs.has(session.placeholderTabId), true);
  assert.ok(env.session(), "A failed restore must remain retryable");
  assert.ok(env.state.messages.some(item => item.message.type === "FSA_RESTORE_FAILED"));
  assert.equal(env.state.messages.slice(before).some(item => item.message.type === "FSA_TAB_RESTORED"), false,
    "An unsuccessful return must leave the tab-wide active session in place");
  env.state.failMoves = false;
  const retried = await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, sender);
  assert.equal(retried?.error, undefined);
  assert.equal(env.state.tabs.get(1).windowId, 10);
  assert.equal(env.session(), undefined);
});

await test("a failure after returning the real tab keeps retry metadata and rejects native expansion", async env => {
  const content = env.state.content.get(1);
  const session = await env.start();
  const sender = env.placeholderSender(session);
  const before = env.state.messages.length;
  env.state.failReorder = true;
  const failed = await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, sender);
  assert.ok(failed?.error);
  assert.equal(env.state.tabs.get(1).windowId, 10, "The same source can already be home when a later layout step fails");
  assert.equal(env.state.content.get(1), content);
  assert.equal(env.state.tabs.has(session.placeholderTabId), true);
  assert.equal(env.session().phase, "restore_failed");
  assert.equal(env.state.messages.slice(before).some(item => item.message.type === "FSA_TAB_RESTORED"), false);
  assert.deepEqual(await env.send({ type: "FSA_TAB_STATE" }, env.sourceSender()), { sessionId: session.id, phase: "restore_failed" });
  assert.ok((await env.send({ type: "FSA_EXPAND_ALLOWED", sessionId: session.id, token: session.expandToken }, env.sourceSender()))?.error);
  env.state.failReorder = false;
  assert.equal((await env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, sender))?.error, undefined);
  assert.equal(env.state.tabs.get(1).windowId, 10);
  assert.equal(env.session(), undefined);
  assert.equal(env.state.content.get(1), content);
});

await test("cancelling an in-flight window creation returns the same source tab safely", async env => {
  const content = env.state.content.get(1);
  let release;
  let entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  env.state.beforeWindowCreate = async () => { entered = true; await gate; };
  const sender = env.sourceSender();
  const started = env.send({ type: "FSA_START", requestId: "cancelled-start", title: "Original player" }, sender);
  await env.until(() => entered, "Expected an in-flight browser window creation");
  const stopped = env.send({ type: "FSA_STOP", requestId: "cancelled-start" }, sender);
  release();
  const result = await started;
  await stopped;
  assert.ok(result?.error, "A cancelled startup must not report a new active fullscreen session");
  assert.equal(env.state.content.get(1), content);
  assert.equal(env.state.tabs.get(1).windowId, 10);
  assert.equal(env.state.windows.get(10).state, "normal");
  assert.equal(env.session(), undefined);
});

await test("closing the real video tab removes only its placeholder and does not recreate the video", async env => {
  const session = await env.start();
  const before = env.state.calls.length;
  env.closeUserTab(1);
  await env.until(() => env.session() === undefined && !env.state.tabs.has(session.placeholderTabId), "Closed video left an orphaned placeholder");
  assert.equal(env.state.tabs.has(1), false);
  assert.equal(env.state.tabs.has(2), true);
  assert.equal(env.state.calls.slice(before).some(call => call.method === "tabs.create" || call.method === "windows.create"), false);
  assert.ok(env.state.calls.slice(before).some(call => call.method === "tabs.sendMessage" &&
    call.args[1].type === "FSA_TAB_RESTORED" && call.args[1].sessionId === session.id),
  "Closing the source still clears the tab-wide coordination state on a best-effort basis");
}, { otherTabs: true });

await test("closing the placeholder closes its video and independent window while retaining other browser tabs", async env => {
  const session = await env.start();
  const videoWindowId = session.videoWindowId;
  const before = env.state.calls.length;
  env.focusUserWindow(10);
  env.closeUserTab(session.placeholderTabId);
  await env.until(() => env.session() === undefined && !env.state.tabs.has(1), "Closing placeholder did not close its video");
  assert.equal(env.state.windows.has(videoWindowId), false);
  assert.equal(env.state.tabs.has(2), true);
  assert.equal(env.state.tabs.get(2).active, true);
  assert.equal(env.state.calls.slice(before).some(call => call.method === "tabs.move"), false, "A discarded video must not be returned first");
}, { otherTabs: true });

await test("navigating a placeholder preserves the new user page and closes its video", async env => {
  const session = await env.start();
  const placeholder = env.state.tabs.get(session.placeholderTabId);
  const videoWindowId = session.videoWindowId;
  const url = "https://example.test/placeholder-replaced-by-user";
  const replacement = { documentId: "user-replacement", position: 0, identity: randomUUID() };
  env.state.content.set(placeholder.id, replacement);
  env.updateUserTab(placeholder.id, { status: "loading", url });
  await env.until(() => env.session() === undefined && !env.state.tabs.has(1), "Navigation did not close its video");
  assert.equal(env.state.windows.has(videoWindowId), false);
  assert.equal(env.state.tabs.get(placeholder.id).url, url);
  assert.equal(env.state.content.get(placeholder.id), replacement);
});

await test("closing the original browser also closes its detached video without recreating tabs", async env => {
  const session = await env.start();
  const videoWindowId = env.state.tabs.get(1).windowId;
  const before = env.state.calls.length;
  env.closeUserWindow(10);
  await env.until(() => env.session() === undefined && !env.state.tabs.has(1), "Closing the browser left its video playing");
  assert.equal(env.state.windows.has(videoWindowId), false);
  assert.equal(env.state.calls.slice(before).some(call => call.method === "windows.create" || call.method === "tabs.create"), false);
  assert.equal(env.state.tabs.has(session.placeholderTabId), false);
});

await test("a URL-only placeholder update closes its video and retains the navigated tab", async env => {
  const session = await env.start();
  const url = "https://example.test/url-only-navigation";
  env.updateUserTab(session.placeholderTabId, { url });
  await env.until(() => env.session() === undefined && !env.state.tabs.has(1), "A URL-only event did not end the video session");
  assert.equal(env.state.tabs.get(session.placeholderTabId).url, url);
  assert.equal(env.state.windows.has(session.videoWindowId), false);
});

await test("pending placeholder navigation closes the video before its committed URL changes", async env => {
  const session = await env.start();
  const url = "https://example.test/pending-navigation";
  const previousURL = env.state.tabs.get(session.placeholderTabId).url;
  env.updateUserTab(session.placeholderTabId, { status: "loading" }, { pendingUrl: url });
  await env.until(() => env.session() === undefined && !env.state.tabs.has(1), "Pending navigation left the video playing");
  assert.equal(env.state.tabs.get(session.placeholderTabId).url, previousURL);
  assert.equal(env.state.tabs.get(session.placeholderTabId).pendingUrl, url);
});

await test("browser replacement of a placeholder closes the bound video while retaining the replacement", async env => {
  const session = await env.start();
  const replacement = env.replaceUserTab(session.placeholderTabId, "https://example.test/prerendered-page");
  await env.until(() => env.session() === undefined && !env.state.tabs.has(1), "Tab replacement left the original video playing");
  assert.equal(env.state.tabs.has(session.placeholderTabId), false);
  assert.equal(env.state.tabs.get(replacement.id).url, replacement.url);
  assert.equal(env.state.windows.has(session.videoWindowId), false);
});

await test("selecting another browser tab keeps the placeholder and detached video active", async env => {
  const session = await env.start();
  const before = env.state.calls.length;
  env.activateUserTab(2);
  env.focusUserWindow(10);
  await delay(25);
  assert.equal(env.session().id, session.id);
  assert.equal(env.state.tabs.get(1).windowId, session.videoWindowId);
  assert.equal(env.state.windows.get(session.videoWindowId).state, "fullscreen");
  assert.equal(env.state.tabs.has(session.placeholderTabId), true);
  assert.equal(env.state.tabs.get(2).active, true);
  assert.equal(env.state.calls.slice(before).some(call => call.method === "tabs.remove" || call.method === "tabs.move"), false);
}, { otherTabs: true });

await test("closing a placeholder never removes user tabs added to the video window", async env => {
  const session = await env.start();
  const other = env.addUserTab({ windowId: session.videoWindowId, active: false, url: "https://example.test/keep-this-tab" });
  const content = env.state.content.get(other.id);
  const before = env.state.calls.length;
  env.closeUserTab(session.placeholderTabId);
  await env.until(() => env.session() === undefined && !env.state.tabs.has(1), "The bound video was not closed");
  assert.equal(env.state.windows.has(session.videoWindowId), true);
  assert.equal(env.state.tabs.get(other.id).windowId, session.videoWindowId);
  assert.equal(env.state.content.get(other.id), content);
  assert.equal(env.state.calls.slice(before).some(call => call.method === "windows.remove"), false);
});

for (const action of ["close", "navigate"]) {
  await test(`${action} of the placeholder during the restore ACK closes the video instead of returning it`, async env => {
    const session = await env.start();
    let entered = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    env.state.beforeSendMessage = async (id, message) => {
      if (message.type === "FSA_PREPARE_RESTORE") { entered = true; await gate; }
    };
    const before = env.state.calls.length;
    const restored = env.send({ type: "FSA_EXIT_REQUEST", sessionId: session.id }, env.placeholderSender(session));
    try {
      await env.until(() => entered, "Expected a pending restore ACK");
      if (action === "close") env.closeUserTab(session.placeholderTabId);
      else env.updateUserTab(session.placeholderTabId, { status: "loading", url: "https://example.test/replaced-during-return" });
    } finally { release(); }
    await restored;
    await env.until(() => env.session() === undefined && !env.state.tabs.has(1), "The discarded session returned or retained its video");
    assert.equal(env.state.calls.slice(before).some(call => call.method === "tabs.move" && call.args[0] === 1), false);
    assert.equal(env.state.windows.has(session.videoWindowId), false);
    if (action === "navigate") assert.equal(env.state.tabs.get(session.placeholderTabId).url, "https://example.test/replaced-during-return");
    assert.equal(env.state.tabs.has(2), true);
  }, { otherTabs: true });
}

await test("closing a placeholder while its video window is still being created ends the new session", async env => {
  let entered = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  env.state.beforeWindowCreate = async () => { entered = true; await gate; };
  const started = env.send({ type: "FSA_START", requestId: "closed-during-create", title: "Original player" }, env.sourceSender());
  let placeholderId;
  try {
    await env.until(() => entered, "Expected an in-flight video window creation");
    placeholderId = env.session().placeholderTabId;
    env.closeUserTab(placeholderId);
  } finally { release(); }
  const result = await started;
  assert.ok(result?.error, "Closing the anchor must prevent a successful fullscreen response");
  await env.until(() => env.session() === undefined && !env.state.tabs.has(1), "An in-flight detached video survived its placeholder");
  assert.equal(env.state.tabs.has(placeholderId), false);
  assert.equal(env.state.tabs.has(2), true);
  assert.equal([...env.state.windows.values()].some(window => window.state === "fullscreen"), false);
}, { otherTabs: true });

await test("worker restart closes a detached video whose placeholder vanished while it was asleep", async env => {
  const session = await env.start();
  // No event is delivered while the worker is asleep; restart reconciliation
  // must discover the missing placeholder from Chrome's current tab state.
  env.state.tabs.delete(session.placeholderTabId);
  env.state.content.delete(session.placeholderTabId);
  env.activateUserTab(2);
  const before = env.state.calls.length;
  await env.launch();
  await env.until(() => env.session() === undefined && !env.state.tabs.has(1), "Restart kept an orphaned detached video alive");
  assert.equal(env.state.windows.has(session.videoWindowId), false);
  assert.equal(env.state.tabs.has(2), true);
  assert.equal(env.state.calls.slice(before).some(call => call.method === "tabs.move"), false);
}, { otherTabs: true });

for (const action of ["close", "navigate"]) {
  await test(`${action} of the placeholder while presenting an entered video closes only its bound video`, async env => {
    const session = await env.start({ entered: false });
    let release;
    let preparationSeen;
    const gate = new Promise(resolve => { release = resolve; });
    const preparing = new Promise(resolve => { preparationSeen = resolve; });
    env.state.beforeSendMessage = async (id, message) => {
      if (message.type === "FSA_PREPARE_PLACEHOLDER") { preparationSeen(); await gate; }
    };
    const confirmed = env.send({ type: "FSA_ENTERED", sessionId: session.id }, env.sourceSender());
    try {
      await preparing;
      assert.equal(env.state.tabs.get(1).windowId, session.videoWindowId);
      if (action === "close") env.closeUserTab(session.placeholderTabId);
      else env.updateUserTab(session.placeholderTabId, { url: "https://example.test/entry-replaced" });
    } finally { release(); }
    await confirmed;
    await env.until(() => env.session() === undefined && !env.state.tabs.has(1), "The discarded placeholder retained its fullscreen video");
    assert.equal(env.state.calls.filter(call => call.method === "windows.create").length, 1);
    assert.equal(env.state.tabs.has(2), true);
    if (action === "navigate") assert.equal(env.state.tabs.get(session.placeholderTabId).url, "https://example.test/entry-replaced");
    else assert.equal(env.state.tabs.has(session.placeholderTabId), false);
  }, { otherTabs: true });
}

await test("a placeholder navigation remains terminal when its URL changes back before event handling", async env => {
  const session = await env.start();
  const originalURL = env.state.tabs.get(session.placeholderTabId).url;
  env.updateUserTab(session.placeholderTabId, { url: "https://example.test/brief-navigation" });
  env.updateUserTab(session.placeholderTabId, { url: originalURL });
  await env.until(() => env.session() === undefined && !env.state.tabs.has(1), "A quick return to the placeholder URL lost the navigation event");
  assert.equal(env.state.windows.has(session.videoWindowId), false);
  assert.equal(env.state.tabs.has(2), true);
}, { otherTabs: true });

await test("worker restart retries a closing session after a transient video-tab removal failure", async env => {
  const session = await env.start();
  let failures = 0;
  env.state.beforeTabsRemove = async ids => {
    if ((Array.isArray(ids) ? ids : [ids]).includes(1)) {
      failures++;
      throw new Error("Tabs cannot be edited right now");
    }
  };
  env.closeUserTab(session.placeholderTabId);
  await env.until(() => env.session()?.phase === "closing" && failures === 1, "Failed removal did not retain its closing intent");
  assert.equal(env.state.tabs.has(1), true);
  env.state.beforeTabsRemove = undefined;
  await env.launch();
  await env.until(() => env.session() === undefined && !env.state.tabs.has(1), "Restart did not finish the interrupted close");
  assert.equal(env.state.windows.has(session.videoWindowId), false);
  assert.equal(env.state.tabs.has(2), true);
}, { otherTabs: true });

await test("source loading requires an explicit ended-document reply rather than an undefined or timed-out probe", async env => {
  const session = await env.start();
  const content = env.state.content.get(1);
  const before = env.state.calls.length;
  env.state.sourceAliveResponse = undefined;
  env.updateUserTab(1, { status: "loading" });
  await env.send({ type: "FSA_PLACEHOLDER_READY", sessionId: session.id }, env.placeholderSender(session));
  assert.equal(env.session()?.phase, "active", "An undefined renderer reply is not proof of navigation");
  assert.equal(env.state.tabs.get(1).windowId, session.videoWindowId);

  env.state.beforeSendMessage = async (id, message) => {
    if (message.type === "FSA_SOURCE_ALIVE") await new Promise(() => {});
  };
  env.updateUserTab(1, { status: "complete" });
  env.updateUserTab(1, { status: "loading" });
  await env.send({ type: "FSA_PLACEHOLDER_READY", sessionId: session.id }, env.placeholderSender(session));
  assert.equal(env.session()?.phase, "active", "A busy renderer's bounded probe timeout must not exit fullscreen");
  assert.equal(env.state.tabs.get(1).windowId, session.videoWindowId);
  assert.equal(env.state.calls.slice(before).some(call => call.method === "tabs.move" ||
    call.method === "tabs.sendMessage" && call.args[1].type === "FSA_PREPARE_RESTORE"), false);

  env.state.beforeSendMessage = undefined;
  env.state.sourceAliveResponse = { alive: false };
  env.updateUserTab(1, { status: "complete" });
  env.updateUserTab(1, { status: "loading" });
  await env.until(() => env.session() === undefined, "An explicit ended document should return the real tab");
  assert.equal(env.state.tabs.get(1).windowId, 10);
  assert.equal(env.state.content.get(1), content);
  assert.equal(env.state.tabs.has(session.placeholderTabId), false);
});

await test("restoration does not depend on the old SPA document replying", async env => {
  const session = await env.start();
  const oldSender = env.sourceSender();
  env.state.content.set(1, { documentId: "new-navigation-document", position: 19, identity: randomUUID() });
  const navigated = env.state.content.get(1);
  env.state.noSourceReplies = true;
  const result = await env.send({ type: "FSA_STOP", requestId: session.requestId }, oldSender);
  assert.equal(result?.error, undefined);
  assert.equal(env.state.tabs.get(1).windowId, 10);
  assert.equal(env.state.content.get(1), navigated);
  assert.equal(env.session(), undefined);
});

await test("worker restart leaves a valid active detached player intact", async env => {
  const session = await env.start();
  const videoWindowId = env.state.tabs.get(1).windowId;
  const before = env.state.calls.length;
  env.state.noSourceReplies = true;
  await env.launch();
  await delay(30);
  assert.ok(env.session());
  assert.equal(env.state.tabs.get(1).windowId, videoWindowId);
  assert.equal(env.state.tabs.has(session.placeholderTabId), true);
  assert.equal(env.state.calls.slice(before).some(call => call.method === "tabs.move" || call.method === "windows.remove"), false);
});

for (const phase of ["moving", "restoring"]) {
  await test(`worker restart recovers an interrupted ${phase} transaction using the real tab`, async env => {
    const content = env.state.content.get(1);
    const session = await env.start();
    env.state.store.fsaSessions[session.id].phase = phase;
    env.state.store.fsaSessions[session.id].sourceDocumentId = "expired-document";
    env.state.noSourceReplies = true;
    await env.launch();
    await env.until(() => env.session() === undefined, "Interrupted move/restore did not recover after worker restart");
    assert.equal(env.state.tabs.get(1).windowId, 10);
    assert.equal(env.state.content.get(1), content);
    assert.equal(env.state.tabs.has(session.placeholderTabId), false);
  });
}

console.log(`Completed ${results.length} worker safety scenarios.`);
if (failures.length) {
  console.error(`${failures.length} worker scenarios failed.`);
  process.exitCode = 1;
}

(() => {
  "use strict";

  const channel = "full-screen-assistant/v1";
  const nativeRequest = Element.prototype.requestFullscreen;
  const nativeExit = Document.prototype.exitFullscreen;
  const fullscreenProperties = new Map(["fullscreenElement", "webkitFullscreenElement", "webkitCurrentFullScreenElement", "fullscreen", "webkitIsFullScreen"].map(name => [name, Object.getOwnPropertyDescriptor(Document.prototype, name)]));
  const nativeFullscreenElement = () => fullscreenProperties.get("fullscreenElement")?.get?.call(document) || null;
  let active = null;
  let recoveringNative = false;
  let nativeRecovery = Promise.resolve();
  let tabSession = null;
  let expanded = null;
  const covers = new Set();
  const pendingFrames = new Map();
  const nativeChecks = new Map();

  function fallbackTarget() {
    return active?.moved && active.fallbackEntered && !active.restoring && active.target.isConnected ? active.target : null;
  }

  for (const [name, descriptor] of fullscreenProperties) {
    if (!descriptor?.get || !descriptor.configurable) continue;
    Object.defineProperty(Document.prototype, name, {
      ...descriptor,
      get() {
        const value = descriptor.get.call(this);
        const target = this === document && fallbackTarget();
        return value || (target ? name.endsWith("Element") ? target : true : value);
      },
    });
  }

  function fullscreenChanged(target) {
    const receiver = target?.isConnected ? target : document;
    receiver.dispatchEvent(new Event("fullscreenchange", { bubbles: true, composed: true }));
    if (fullscreenProperties.get("webkitFullscreenElement")?.get || fullscreenProperties.get("webkitCurrentFullScreenElement")?.get) {
      receiver.dispatchEvent(new Event("webkitfullscreenchange", { bubbles: true, composed: true }));
    }
  }

  function leaveFallback(session) {
    if (!session.fallbackEntered) return;
    session.fallbackEntered = false;
    if (!nativeFullscreenElement()) fullscreenChanged(session.target);
  }

  function post(message) {
    window.postMessage({ channel, direction: "page", ...message }, "*");
  }

  function managedTab() {
    const requestId = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { nativeChecks.delete(requestId); resolve({ known: false }); }, 2000);
      nativeChecks.set(requestId, result => { clearTimeout(timer); nativeChecks.delete(requestId); resolve(result); });
      post({ type: "tab-state", requestId });
    });
  }

  function elementsIn(root, name) {
    const elements = root.localName === name ? [root] : [...root.querySelectorAll(name)];
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) elements.push(...elementsIn(element.shadowRoot, name));
    }
    return elements;
  }

  function score(video) {
    const rect = video.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    const style = getComputedStyle(video);
    if (width < 32 || height < 32 || style.visibility === "hidden" || style.display === "none") return 0;
    return width * height * (video.paused ? 1 : 2);
  }

  function findVideo(root = document) {
    return elementsIn(root, "video").sort((a, b) => score(b) - score(a))[0] || null;
  }

  function hasVideoFrame(root) {
    return elementsIn(root, "iframe").some(frame => {
      const rect = frame.getBoundingClientRect();
      return rect.width >= 32 && rect.height >= 32;
    });
  }

  function playerFor(video) {
    // A toolbar entry has no website-selected target. Keep its existing controls.
    const rect = video.getBoundingClientRect();
    for (let node = video.parentElement; node && node !== document.body; node = node.parentElement) {
      const box = node.getBoundingClientRect();
      if (box.height > Math.max(rect.height * 1.8, innerHeight) || box.width > Math.max(rect.width * 1.8, innerWidth)) break;
      if (node.querySelector("button,[role=button]")) return node;
    }
    return video;
  }

  function preview(video) {
    if (!video?.videoWidth || video.readyState < 2) return;
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 960 / video.videoWidth, 540 / video.videoHeight);
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL("image/jpeg", 0.65);
      if (image.length <= 350000) return image;
    } catch { /* Protected/cross-origin video still uses its original player. */ }
  }

  function restoreStyles(session) {
    for (const item of session.styles.splice(0).reverse()) {
      if (item.element.style.getPropertyValue(item.name) !== item.applied || item.element.style.getPropertyPriority(item.name) !== "important") continue;
      if (item.value) item.element.style.setProperty(item.name, item.value, item.priority);
      else item.element.style.removeProperty(item.name);
    }
  }

  function setStyle(session, element, values) {
    for (const [name, applied] of Object.entries(values)) {
      const value = element.style.getPropertyValue(name);
      const priority = element.style.getPropertyPriority(name);
      element.style.setProperty(name, applied, "important");
      session.styles.push({ element, name, value, priority, applied: element.style.getPropertyValue(name) });
    }
  }

  function fillPlayer(session) {
    restoreStyles(session);
    releaseAncestors(session, session.target);
    setStyle(session, session.target, {
      position: "fixed", top: "0", right: "0", bottom: "0", left: "0", width: "100vw", height: "100vh",
      "margin-top": "0", "margin-right": "0", "margin-bottom": "0", "margin-left": "0",
      "max-width": "none", "max-height": "none", "z-index": "2147483646", "background-color": "#000",
    });
    for (const frame of session.target.querySelectorAll("iframe")) {
      setStyle(session, frame, { width: "100%", height: "100%", "max-width": "none", "max-height": "none" });
    }
    post({ type: "expand", requestId: session.requestId });
    session.fallbackEntered = true;
    fullscreenChanged(session.target);
  }

  function releaseAncestors(session, element) {
    for (let node = element.parentElement || element.getRootNode?.().host; node; node = node.parentElement || node.getRootNode?.().host) {
      if (session.ancestors?.has(node)) continue;
      session.ancestors?.add(node);
      setStyle(session, node, {
        transform: "none", filter: "none", perspective: "none", contain: "none",
        "overflow-x": "visible", "overflow-y": "visible", "clip-path": "none",
      });
    }
  }

  function expandFrame(frame) {
    expanded ||= { styles: [], frames: new WeakSet(), ancestors: new WeakSet() };
    if (expanded.frames.has(frame)) return;
    expanded.frames.add(frame);
    setStyle(expanded, frame, {
      position: "fixed", top: "0", right: "0", bottom: "0", left: "0", width: "100vw", height: "100vh",
      "margin-top": "0", "margin-right": "0", "margin-bottom": "0", "margin-left": "0",
      "max-width": "none", "max-height": "none", "z-index": "2147483646",
    });
    releaseAncestors(expanded, frame);
  }

  function makeCover(session) {
    const video = session.video;
    if (!video?.isConnected || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const host = document.createElement("div");
    host.setAttribute("data-full-screen-assistant", "");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:auto!important;z-index:2147483647!important;display:block!important;pointer-events:none!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;";
    host.setAttribute("aria-hidden", "true");
    const shadow = host.attachShadow({ mode: "closed" });
    const layer = document.createElement("div");
    layer.textContent = "点按以退出全屏幕";
    layer.style.cssText = "position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;background:rgba(25,28,34,.25);backdrop-filter:blur(64px);-webkit-backdrop-filter:blur(64px);color:rgba(255,255,255,.62);font:500 clamp(16px,2vw,26px)/1.4 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;border-radius:inherit;";
    shadow.append(layer);
    const position = () => {
      const rect = video.getBoundingClientRect();
      for (const [name, value] of Object.entries({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })) host.style.setProperty(name, `${value}px`, "important");
      host.style.setProperty("border-radius", getComputedStyle(video).borderRadius, "important");
    };
    const observer = new ResizeObserver(position);
    observer.observe(video);
    document.documentElement.append(host);
    position();
    const remove = () => {
      if (cover.removed) return;
      cover.removed = true;
      clearTimeout(cover.timer);
      for (const cancel of cover.waits) cancel();
      cover.waits.clear();
      observer.disconnect(); host.remove(); covers.delete(cover);
    };
    const cover = { host, layer, position, remove, waits: new Set(), removed: false, timer: setTimeout(remove, 5000) };
    covers.add(cover);
    return cover;
  }

  function painted(cover) {
    if (!cover || cover.removed) return Promise.resolve(false);
    return new Promise(resolve => {
      let frame, timer;
      const finish = ok => {
        cancelAnimationFrame(frame); clearTimeout(timer); cover.waits.delete(cancel);
        resolve(ok && !cover.removed);
      };
      const cancel = () => finish(false);
      cover.waits.add(cancel);
      // Hidden tabs can throttle rAF. The bounded fallback avoids blocking a
      // browser transaction while still requiring two frames when visible.
      timer = setTimeout(() => finish(true), 120);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => finish(true)); });
    });
  }

  async function reveal(cover) {
    if (!cover) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { cover.remove(); return; }
    clearTimeout(cover.timer);
    cover.position();
    if (!await painted(cover)) return;
    cover.position();
    // Reveal only after the returned/moved live video has a painted layout.
    cover.layer.style.transition = "backdrop-filter 480ms cubic-bezier(.2,.7,.2,1),-webkit-backdrop-filter 480ms cubic-bezier(.2,.7,.2,1),background-color 480ms ease,color 480ms ease";
    cover.layer.style.backdropFilter = cover.layer.style.webkitBackdropFilter = "blur(0px)";
    cover.layer.style.backgroundColor = "rgba(25,28,34,0)";
    cover.layer.style.color = "rgba(255,255,255,0)";
    cover.layer.addEventListener("transitionend", event => {
      if (event.propertyName === "backdrop-filter" || event.propertyName === "-webkit-backdrop-filter") cover.remove();
    });
    cover.timer = setTimeout(cover.remove, 660);
  }

  function finish(session, animate = false) {
    if (active !== session) return;
    active = null;
    clearTimeout(session.timeout);
    restoreStyles(session);
    leaveFallback(session);
    if (animate) reveal(session.cover || makeCover(session));
    else session.cover?.remove();
    session.resolve();
    session.resolveExit?.();
  }

  async function enter(session) {
    if (active !== session || !session.moved || session.restoring || session.exiting) return;
    await session.recovery;
    if (active !== session || !session.moved || session.restoring || session.exiting) return;
    session.entering = true;
    restoreStyles(session);
    try {
      // Keep the exact website-selected target, controls, captions and document.
      await nativeRequest.apply(session.target, session.args);
      session.nativeEntered = !!nativeFullscreenElement();
      leaveFallback(session);
    } catch {
      // A toolbar/native-control entry may have consumed transient activation.
      if (active === session && session.moved && !session.restoring && !session.exiting && session.target.isConnected) fillPlayer(session);
    } finally { session.entering = false; }
    if (active !== session || !session.moved || session.restoring || session.exiting) return;
    clearTimeout(session.timeout);
    post({ type: "entered", requestId: session.requestId });
    session.resolve();
  }

  function start(target, args, video) {
    if (active) {
      if (active.returnPending) {
        const previous = active;
        return requestRestore(previous).then(() => { if (!active) return start(target, args, video); });
      }
      if (active.target === target) {
        return active.moved && !active.restoring && !active.exiting && !nativeFullscreenElement() && !active.fallbackEntered ? enter(active) : active.promise;
      }
      active.target = target;
      active.args = args;
      active.video = video;
      return active.moved ? enter(active) : active.promise;
    }
    const session = { target, args, video, requestId: crypto.randomUUID(), styles: [], resolve: () => {}, moved: false, entering: false, restoring: false, recovery: nativeRecovery };
    for (const cover of covers) cover.remove();
    session.promise = new Promise(resolve => { session.resolve = resolve; });
    active = session;
    session.timeout = setTimeout(() => {
      if (active === session) post({ type: "stop", requestId: session.requestId });
    }, 15000);
    post({ type: "start", requestId: session.requestId, preview: preview(video) });
    return session.promise;
  }

  function requestRestore(session) {
    if (session.exiting) return session.exitPromise;
    session.exiting = true;
    session.exitPromise = new Promise(resolve => { session.resolveExit = resolve; });
    post({ type: "exit", requestId: session.requestId });
    return session.exitPromise;
  }

  if (!nativeRequest || !nativeExit) return;
  function requestFullscreen(...args) {
    const video = findVideo(this);
    if (video || hasVideoFrame(this)) return start(this, args, video);
    return nativeRequest.apply(this, args);
  }
  Element.prototype.requestFullscreen = requestFullscreen;
  for (const name of ["webkitRequestFullscreen", "webkitRequestFullScreen"]) {
    if (Element.prototype[name]) Element.prototype[name] = requestFullscreen;
  }
  Document.prototype.exitFullscreen = function (...args) {
    if (active && !active.restoring) return requestRestore(active);
    return nativeExit.apply(this, args);
  };

  window.addEventListener("fullscreenchange", async () => {
    const target = nativeFullscreenElement();
    if (active) {
      if (target && !active.moved && !recoveringNative) {
        recoveringNative = true;
        active.recovery = nativeRecovery = nativeExit.call(document).catch(() => {}).finally(() => { recoveringNative = false; });
      } else if (target && active.moved) active.nativeEntered = true;
      else if (active.nativeEntered && !active.restoring && !active.entering) void requestRestore(active);
      return;
    }
    // A descendant's native fullscreen also fires in all ancestor documents.
    if (!target || recoveringNative || tabSession) return;
    const video = findVideo(target);
    if (!video && !hasVideoFrame(target)) return;
    recoveringNative = true;
    try {
      const state = await managedTab();
      if (!state.known || state.sessionId || active || tabSession || nativeFullscreenElement() !== target || !target.isConnected) return;
      const exiting = nativeExit.call(document);
      nativeRecovery = exiting.catch(() => {});
      await exiting;
      if (!active && !nativeFullscreenElement() && target.isConnected) void start(target, [], video);
    } catch { /* A closed/navigated page cannot enter independent playback. */ }
    finally { recoveringNative = false; nativeRecovery = Promise.resolve(); }
  }, true);

  window.addEventListener("message", async event => {
    const message = event.data;
    if (message?.channel === channel && message.direction === "frame" && message.type === "expand") {
      if (message.sessionId !== tabSession || typeof message.token !== "string" || message.token.length > 100 || event.source === window) return;
      const frame = elementsIn(document, "iframe").find(element => element.contentWindow === event.source);
      if (frame) pendingFrames.set(message.token, frame);
      return;
    }
    if (event.source !== window || message?.channel !== channel || message.direction !== "extension") return;
    if (message.type === "tab-state") {
      nativeChecks.get(message.requestId)?.({ known: message.known === true, sessionId: message.sessionId });
    } else if (message.type === "tab-active") {
      if (tabSession !== message.sessionId) {
        if (expanded) restoreStyles(expanded);
        expanded = null;
        pendingFrames.clear();
      }
      tabSession = message.sessionId;
    } else if (message.type === "tab-restored") {
      if (message.sessionId !== tabSession) return;
      if (expanded) restoreStyles(expanded);
      expanded = null;
      pendingFrames.clear();
      tabSession = null;
    } else if (message.type === "expand-authorized") {
      if (message.sessionId !== tabSession) return;
      const frame = pendingFrames.get(message.token);
      pendingFrames.delete(message.token);
      if (frame?.isConnected) expandFrame(frame);
    } else if (message.type === "probe") {
      const video = findVideo();
      if (video && score(video)) post({ type: "candidate", requestId: message.requestId, score: score(video) });
    } else if (message.type === "activate") {
      const video = findVideo();
      if (active) {
        if (message.toggle !== false) await requestRestore(active);
      } else if (video && score(video)) await start(playerFor(video), [], video);
      if (message.requestId) post({ type: "activation-done", requestId: message.requestId, found: !!video });
    } else if (active && message.requestId === active.requestId) {
      const session = active;
      if (message.type === "started") {
        if (message.error) {
          if (!/extension context invalidated/i.test(message.error)) console.warn("Full-Screen Assistant:", message.error);
          finish(session);
        }
        else { session.sessionId = message.sessionId; session.moved = true; await enter(session); }
      } else if (message.type === "prepare-restore") {
        session.restoring = true;
        session.moved = false;
        leaveFallback(session);
        for (const cover of covers) if (cover !== session.cover) cover.remove();
        if (active !== session) return;
        try { if (nativeFullscreenElement()) await nativeExit.call(document); } catch { /* It may already have ended. */ }
        if (active === session) {
          restoreStyles(session);
          if (message.animate) session.cover ||= makeCover(session);
          session.cover?.position();
          if (session.cover) await painted(session.cover);
        }
        post({ type: "restore-prepared", requestId: message.requestId, prepareId: message.prepareId });
      } else if (message.type === "restored") finish(session, message.animate === true);
      else if (message.type === "restore-failed") {
        session.restoring = false;
        session.exiting = false;
        session.moved = false;
        leaveFallback(session);
        session.returnPending = true;
        session.cover?.remove();
        session.cover = null;
        session.resolveExit?.();
      }
    }
  });

  window.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !active || active.restoring) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void requestRestore(active);
  }, true);
  window.addEventListener("pagehide", () => {
    if (active) { post({ type: "stop", requestId: active.requestId }); finish(active); }
    if (expanded) restoreStyles(expanded);
    expanded = null;
    pendingFrames.clear();
    tabSession = null;
    for (const resolve of nativeChecks.values()) resolve({ known: false });
    for (const cover of covers) cover.remove();
  });
})();

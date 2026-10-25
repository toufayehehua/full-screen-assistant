"use strict";

const sessionId = location.hash.slice(1);
const exitButton = document.querySelector("#exit");
const previewImage = document.querySelector("#preview");
const faviconLink = document.querySelector("#favicon");
const validSession = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId);
let busy = false;
let validation = 0;

function sourceUrl(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

async function requestExit() {
  if (busy || !validSession) return;
  busy = true;
  exitButton.disabled = true;
  exitButton.classList.add("exiting");
  exitButton.setAttribute("aria-busy", "true");
  try {
    const result = await chrome.runtime.sendMessage({ type: "FSA_EXIT_REQUEST", sessionId });
    if (!result || result.error || result.ok === false) throw new Error("Exit request failed");
  } catch {
    busy = false;
    exitButton.disabled = false;
    exitButton.classList.remove("exiting");
    exitButton.removeAttribute("aria-busy");
  }
}

exitButton.addEventListener("click", requestExit);
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  void requestExit();
});

previewImage.addEventListener("load", () => {
  previewImage.hidden = false;
  previewImage.style.opacity = ".72";
});
previewImage.addEventListener("error", () => {
  previewImage.hidden = true;
  previewImage.style.opacity = "0";
  previewImage.removeAttribute("src");
});

function metadata(result) {
  if (!result || result.error) return;
  const url = sourceUrl(result.sourceUrl);
  if (url && history.state?.fsaSourceUrl !== url) {
    history.replaceState({ ...history.state, fsaSourceUrl: url }, "");
  }
  if (url && faviconLink) {
    const icon = new URL(chrome.runtime.getURL("_favicon/"));
    icon.searchParams.set("pageUrl", url);
    icon.searchParams.set("size", "32");
    faviconLink.href = icon.href;
  }
  if (typeof result.title === "string") document.title = result.title;
  if (typeof result.preview === "string" && result.preview.length <= 350000 &&
      /^data:image\/jpeg;base64,/.test(result.preview) && previewImage.src !== result.preview) previewImage.src = result.preview;
  exitButton.hidden = false;
}

async function prepare(result) {
  metadata(result);
  // The placeholder is intentionally created in the background. Its rAF and
  // timers may be suspended; metadata readiness must not wait for a paint.
  if (document.visibilityState === "hidden") return;
  if (previewImage.src && typeof previewImage.decode === "function") {
    let timer;
    try {
      await Promise.race([previewImage.decode().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 220); })]);
    } finally { clearTimeout(timer); }
  } else if (previewImage.src && !previewImage.complete) {
    await new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        previewImage.removeEventListener("load", finish);
        previewImage.removeEventListener("error", finish);
        resolve();
      };
      const timer = setTimeout(finish, 220);
      previewImage.addEventListener("load", finish);
      previewImage.addEventListener("error", finish);
    });
  }
  await new Promise(resolve => {
    let frame;
    const finish = () => { clearTimeout(timer); cancelAnimationFrame(frame); resolve(); };
    const timer = setTimeout(finish, 100);
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
  });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!validSession || sender.id !== chrome.runtime.id || message.type !== "FSA_PREPARE_PLACEHOLDER" || message.sessionId !== sessionId) return;
  void prepare(message).then(() => respond({ ok: true }), () => respond({ ok: false }));
  return true;
});

async function initialize(restored = false) {
  const current = ++validation;
  exitButton.hidden = true;
  if (restored) {
    busy = false;
    exitButton.classList.remove("exiting");
    exitButton.removeAttribute("aria-busy");
  }
  exitButton.disabled = !validSession;
  if (!validSession) return;
  try {
    const result = await chrome.runtime.sendMessage({ type: "FSA_PLACEHOLDER_READY", sessionId });
    if (current !== validation) return;
    if (result?.pending) return;
    if (result?.sessionEnded === true || result?.error === "Session is no longer available") {
      exitButton.disabled = true;
      const url = sourceUrl(history.state?.fsaSourceUrl);
      if (url) location.replace(url);
      return;
    }
    metadata(result);
  } catch {
    // A suspended worker is not proof that the video session ended.
  }
}

window.addEventListener("pagehide", () => { validation++; exitButton.hidden = true; });
window.addEventListener("pageshow", event => { if (event.persisted) void initialize(true); });
void initialize();

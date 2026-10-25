# Reviewer instructions — 0.2.1 (11)

Version **0.2.1 (11)** has been successfully submitted to the Chrome Web Store. The verified dashboard status is **pending review**; automatic publication after approval is enabled, and the product is **not yet publicly available**. The dashboard default language is English. The English and Chinese descriptions, English reviewer notes and privacy/permission justifications have been saved. The updated policy is deployed at https://fsa-privacy-zhangyi.toufayehehua.chatgpt.site ; anonymous access returns HTTP 200 and its visible text matches the current local `privacy-policy.html`.

The uploaded Web Store ZIP is immutable for this update and must not be rebuilt. This workspace document and README record changes made after upload; the uploaded archive retains its original documentation snapshot.

## Store language and shared assets

The dashboard default store language is English, and the zh-CN listing retains its Chinese description and two Chinese localized screenshots. The global/default assets are two English screenshots and two English promotional images. All of these images have been uploaded and saved. The primary reviewer notes are English, with Chinese notes retained below for the localized listing.

## Single purpose

Temporarily move the user's original video tab into a separate normal browser window and make that window fullscreen, keep a click-to-return placeholder tab in the original browser, then return the real tab on exit.

## Access and account requirements

No extension account, license, payment or API key is required. Use desktop Chrome 120 or later. Refresh existing web pages after installing or reloading the extension. Websites may independently require login or restrict media; the extension does not bypass these requirements.

## Reproduction

1. Open the publisher's public review demo: https://domicube.xyz/extensions/full-screen-assistant/demo/ . Wait for the `全屏播放` button to become enabled. The page generates an original unencrypted clip locally; no login or subscription is needed and the clip is intentionally silent. The demo is an ordinary test website, not remotely hosted executable extension code.
2. Keep a second browser tab open, then click the demo's fullscreen button. If a website's entry is not handled, pin the extension and click its toolbar icon to select a large visible video, including candidates in matching iframes.
3. Confirm the **same real source tab** moves into a separate normal browser window which enters fullscreen. The original browser remains open and a placeholder tab occupies the source tab's original position. A silent placeholder first preserves the original browser; only after the video has entered fullscreen are its original title, Chrome-cached website icon and blurred still or gradient revealed. It displays the exact text `点按以退出全屏幕`.
4. Return to the original browser and use its other tab. The source webpage and content around the video have moved with the real tab and are not simultaneously usable in the original browser. The placeholder does not contain a copy of the original website.
5. In the fullscreen window, use the website's original playback controls. With an appropriate website/video, also check its captions, live comments or quality menu. The original video element, media source and website playback implementation are retained; no extension receiver, replacement controls or real-time video stream is created. Website-specific restrictions still apply.
6. Press Esc, use the website's exit-fullscreen action, click the original-browser placeholder or click the extension icon again. The real source tab returns to the placeholder's browser and position, attempting to preserve pin/group/order. If the placeholder is selected, the returned source becomes selected; an independently selected other tab is preserved. Foreground exits first focus the destination browser. The actual video is revealed with an approximately 480ms transition from 64px blur to clear; reduced motion disables this transition.
7. Repeat with the placeholder moved to another compatible normal browser window: returning should follow its current position. Closing or navigating away from the placeholder closes the bound video tab and its sole-tab window; a newly navigated website and other user tabs are preserved. Navigating Back to an expired placeholder restores its saved original website as an ordinary page in the same tab.
8. Separately test the system close button or Cmd-W. **These close the real source video tab; they do not perform Esc-style return.** The placeholder and session are cleaned up after the source closes. Use a disposable test page for this step.
9. Check optional preview failure with a video whose pixels cannot be read because of CORS/DRM, or a not-yet-ready video. A gradient placeholder is expected. Preview failure must not become a capture gate for the original player's fullscreen session. Protected-media playback remains subject to the website and browser; it is not a DRM bypass.

Additional websites can be checked without assuming every login state or media item is compatible. The repository's local fixture and Node VM tests are not included in the runtime-only store ZIP.

## Observed real-Chrome checks and remaining scope

CUA checks in a loaded test snapshot observed:

- The same local-page DOM, video stream and original controls remained while switching from 1080p to 4K. The site's exit action returned the tab; the return cover existed for about 719ms including restoration.
- A cross-origin iframe entered native fullscreen and returned with Esc. Its return cover existed for about 648ms including restoration.
- On [YouTube sample aqz-KE-bpKQ, Big Buck Bunny](https://www.youtube.com/watch?v=aqz-KE-bpKQ), the site's fullscreen entry opened the independent fullscreen window using the page-layout fallback. The original settings menu offered 2160p60; the observed video dimensions were 3840×2160. The site's original exit button returned the tab. This does not measure sustained 60fps playback.

The local build 10 runtime passes 60 page/bridge/placeholder cases and 56 worker scenarios. The loaded build 10 snapshot was also checked with [the user-provided YouTube video Xtfl8kTze6g](https://www.youtube.com/watch?v=Xtfl8kTze6g): 3840×2160 playback, the original site exit control, Esc return and re-entry were observed. One old-page extension connection became invalid after reload; refreshing that website was followed by two effective entry/return cycles. The final normal-exit log cleanup was logic-tested after that observation. Version 0.2.1 (11) retains the current runtime implementation while updating its version and default English store metadata; it has not been separately reloaded or tested in Chrome. Full site coverage, DRM, macOS desktop IDs, actual occupied-tab Back interaction, icon appearance and frame-by-frame animation remain unverified. Tencent is not counted as passed because no player was reached.

## Local developer test commands

`npm test` runs `node --test tests/worker.mjs tests/page-bridge.mjs` with Node's built-in modules. The tests use a VM with simulated Chrome APIs, DOM and frames; no browser is launched or personal Chrome profile accessed. They do not establish actual website/DRM, fullscreen animation or desktop-space behavior.

`npm run test:browser` runs `node tests/serve.mjs`. It only serves `tests/fixture.html` on a temporary `127.0.0.1` port and prints its URL/PID. Load the extension and open that URL manually in Chrome. The fixture generates its own video locally. The command does not launch or automate Chrome. Stop its terminal process with Ctrl-C and close temporary test windows when finished.

## Expected limitations

- The original page is temporarily in the fullscreen window; only other browser tabs remain independently usable in the original window.
- System window close and Cmd-W close the real video tab. Esc, site exit, the placeholder and the extension icon are return paths.
- Preserving the original player retains website captions, controls and DRM playback paths, but website/browser restrictions, custom fullscreen implementations, advertisements and responses to resizing or moving a tab may affect operation.
- CORS/DRM can block the optional still preview without blocking the original video. No attempt is made to decrypt or bypass media protection.
- macOS manages fullscreen spaces and system animation. The extension focuses the destination browser and returns its real tab; it cannot select a desktop number. Exact desktop behavior still requires real-system verification.
- `chrome://`, Chrome Web Store and local `file://` pages are not content-script targets. Exit normally before reloading, disabling or removing the extension.

## Permissions and local data flow

- Content scripts match HTTP/HTTPS pages and related frames to identify the user-operated video, handle fullscreen, attempt a single-frame preview and restore layout/transition on return. No whole-page scraping or reading of forms, cookies or account credentials is implemented.
- Named manifest permissions are `storage` and `favicon`. `chrome.storage.session` temporarily holds current-page titles, the original HTTP(S) page address for recovery, source/placeholder tab/window/frame/document/session identifiers, restoration state, session timing/status and an optional JPEG still. Session records are removed on completion; retry metadata remains until recovery or cleanup. Separately, `history.replaceState` saves the original address in the placeholder’s existing native history-entry state for Back recovery. This state remains until Chrome removes the entry or the user clears browsing history; it is not deleted with the temporary session. There is no additional history log, preview library or `storage.sync`.
- `favicon` displays the original website icon using only the user’s current source-page address with Chrome’s internal favicon cache under the extension’s `_favicon/` URL. No third-party favicon service, direct website icon fetch, history scan or upload is implemented.
- The still is obtained from the selected video element using a local canvas when permitted. It is not an entire-tab or desktop screenshot. No camera, microphone, tab capture, desktop capture, history, cookies or debugger permission is requested.
- Trusted click/touch/key gestures validate local fullscreen requests. Only recent trusted-gesture/activation times stay in page memory until overwritten or the page refreshes/closes. No typed content, keystroke log or complete click/scroll history is retained.
- **Version 0.2 does not use `captureStream()`, WebRTC, SDP/ICE, STUN/TURN, live video transfer or re-encoding.** Its data categories are website content, web history (the current video page title and original page address, including the native history-entry state described above) and user activity. Location/address metadata was relevant only to the older 0.1.x local WebRTC channel.
- No developer upload endpoint, telemetry, advertising or continuous-video recording is present. Executable extension code and styles are bundled; ordinary website playback remains the website's own implementation.

## Policy and publication notes for the publisher

The Chrome Web Store requires disclosure of local processing, including the optional preview, title, original page address and native history-entry retention, favicon and user gestures. Do not claim that the extension handles no data merely because it works locally. For 0.2 choose `website_content`, `web_history` and `user_activity`; `location` describes only legacy 0.1.x SDP/ICE address metadata and is retained in the versioned privacy policy for those users.

The updated public policy is deployed at https://fsa-privacy-zhangyi.toufayehehua.chatgpt.site . Anonymous access returns HTTP 200, and its visible text matches the revised local `privacy-policy.html`, including original-address/native-history recovery and favicon handling. The store privacy/permission fields have been saved. Version 0.2.1 (11) is submitted and pending review, with automatic publication after approval enabled; it is not yet published. Global English assets and the two zh-CN screenshots are saved. Keep the already uploaded ZIP unchanged during review.

Official references:

- [User Data FAQ, including local processing and Limited Use](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Privacy practice fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Privacy-policy requirement](https://developer.chrome.com/docs/webstore/program-policies/privacy)

## Primary dashboard notes (en, 467 characters)

0.2.1(11), Chrome120+; refresh pages. Demo: https://domicube.xyz/extensions/full-screen-assistant/demo/ No extension login/payment. Same real tab/player; Esc/site exit/placeholder returns it, Close/Cmd-W closes it. Loaded build10: YouTube Xtfl8kTze6g, 3840x2160, site exit, Esc and re-entry checked. Build11 has not been separately Chrome-tested. Back/icon appearance, DRM and desktop IDs unverified. Local URL/history-state recovery; Chrome favicon cache; no upload.

## Localized dashboard notes (zh-CN, 392 characters)

0.2.1(11)，Chrome 120+，安装或重载后刷新网页。无需扩展账号或付费。
演示：https://domicube.xyz/extensions/full-screen-assistant/demo/ 等“全屏播放”启用后点击；短片静音。
原视频标签移入独立全屏窗口，保留网站控件；原浏览器留占位，其他标签可用。Esc、网站退出或占位用于返回；关闭/Cmd-W关闭真实视频。
已加载构建10快照实测用户指定YouTube视频Xtfl8kTze6g：3840×2160、原按钮及Esc返回、再次进入。11沿用该运行实现并更新版本及默认英文元数据，未另做Chrome实测。后退、图标外观、DRM及macOS桌面编号未实测。
storage会话临存标题、原网页地址及预览；原址另保留在占位原生历史条目用于后退。favicon仅用Chrome内部缓存，无第三方图标服务或数据上传。

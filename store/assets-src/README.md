# Store artwork source — 0.2

`generate_assets.py` exports all image assets as RGB PNG without alpha. It uses the existing extension icon and original geometric landscape artwork; no third-party video or website screenshot is used. The artwork describes the 0.2 architecture: the real website tab moves into an independent full-screen Chrome window, a blurred placeholder tab keeps its position in the original browser, and exiting restores the real tab.

Run with the bundled Python runtime:

```sh
/Users/zhangyi/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 store/assets-src/generate_assets.py
```

Generate only Chinese screenshots without touching global English PNGs:

```sh
/Users/zhangyi/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 store/assets-src/generate_assets.py --locale zh-CN
```

`--locale en` exports only global English assets; the default exports both sets.

All global screenshots and promotional images use English as the default for all regions. Chinese listing screenshots are retained separately in `assets/zh-CN/`, with the original Chinese headlines, captions and placeholder text. Global promotional images and both 1280×800 listing images are explicitly labelled **Feature illustration / Illustration**. The two Chinese 1280×800 listing images retain their **功能示意** labels. The browser tab strips, placeholder and website-player controls are original diagrams, not observed Chrome UI or claims of measured results. The player diagram represents the website's own player, not media forwarded to an extension player. The restored-browser diagram represents the same website tab returning to its original window. Static images do not claim to demonstrate the live 64px-to-0px transition.

No `chrome-extension:` page is captured. Current permitted HTTP-page captures can replace suitable diagrams after they are supplied and verified; the 0.1 captures have been removed and must not be used as evidence of 0.2 behavior. No release ZIP is produced by this artwork script.

`demo/index.html` is an original, local demonstration page. When served with the project root, it records a short, original canvas animation into an in-memory WebM and plays it in a normal HTML video. Its full-screen button calls the real Fullscreen API so the installed extension can handle it. Do not force or simulate the extension placeholder; capture its actual behavior.

Output sizes follow the Chrome Web Store's [listing guidance](https://developer.chrome.com/docs/webstore/cws-dashboard-listing) and [image guidance](https://developer.chrome.com/docs/webstore/images): 128×128 icon, 440×280 small promotional image, 1400×560 marquee and 1280×800 screenshots.

# EverRoom Browser Extension

This is the first local-only Manifest V3 extension slice.

For development, load this directory from `chrome://extensions` with Developer mode enabled. After loading it, click the EverRoom extension icon in the browser toolbar to open `popup.html`. Do not double-click `popup.html` in Finder or open it as a `file://` URL; browser extension APIs such as `chrome.runtime.sendMessage` are unavailable outside the extension context. The desktop app starts a loopback bridge on `127.0.0.1:47831`. Production builds should publish the extension to the browser store and set `NXCORE_BROWSER_EXTENSION_STORE_URL` to the published URL.

Pairing is one click from either side. The extension can connect directly from its popup, while EverRoom Settings > Extensions opens a local pairing page that the installed extension completes automatically. The bridge returns a bearer token immediately and keeps it in `chrome.storage.local`; there is no second confirmation step.

After pairing, use **Save page to EverRoom** in a page's context menu or **Save current page** in the toolbar popup. The content script extracts the current browser DOM (selection first, Mozilla Readability second, then article/main or the full page), converts it to Markdown, and sends it through the authenticated loopback bridge. EverRoom saves it as a `web-clipper` file with Room, Wiki, and Memory ingestion disabled by default.

Up to 20 page images are read from the active page and uploaded one at a time. The local bridge validates their signatures, limits each image to 2 MB and the capture total to 15 MB, then stores them in the shared content-addressed object store. Cross-origin images that the page cannot read are recorded as missing without failing the Markdown capture. The popup offers **Retry missing images** for the most recent partial capture.

Reload the unpacked extension from `chrome://extensions` after changing extension source files. Version 0.2.2 includes the EverRoom icon set, Readability extraction, automatic content-script injection, local image assets, capture status, image retry, and UI language synchronization with EverRoom.

# MemoFam MapleScouter Reader

This Chrome/Edge Manifest V3 extension reads the result page that MemoFam opens and sends the boss380 Hexa score and boss multipliers back to that app tab. A multiplier labeled `[파티]` is divided by three before it is saved so it matches the solo multiplier scale. It reads result content only from `https://maplescouter.com/ko/result*` and does not read or store login tokens.

## Install

1. Download the ZIP from MemoFam and extract it.
2. Open `chrome://extensions` (or `edge://extensions`) and enable Developer mode. The in-app **Chrome 확장 프로그램 열기** button copies this address and displays instructions.
3. Select **Load unpacked** and choose the extracted folder containing `manifest.json`.
4. Keep the extension enabled, sign in to MemoFam, and use the MapleScouter refresh button. The result page opens and is read automatically.

Browsers block websites and extensions from opening internal `chrome://` pages programmatically. Use the copied address in the browser address bar to open the extensions page.

The app must be opened in the same browser profile where this extension is installed. The app bridge supports `localhost`, `*.app.github.dev`, `*.vercel.app`, and `memofam.rlagmldnjs005.workers.dev`; add your custom app domain to the app bridge match list in `manifest.json` before reloading the unpacked extension. If the app does not detect the extension, reload the app tab after installing it and confirm the app domain is listed in the manifest. The extension sends only the extracted result to the app tab that opened MapleScouter.

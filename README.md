# Canary for Chrome

Canary as a Chrome extension. It has the desktop app's interface and features, and collects GDELT Events, GDELT GKG, Google News RSS and Media Cloud results in the background. No server or PHP relay: the extension's host permissions let it read Google News and the other sources directly. Everything is stored in this browser profile's IndexedDB.

## Build and install

```sh
cd canary-lite
npm install
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select `canary-lite/dist`. Click the Canary toolbar icon to open the app in a tab.

Checks: `npm run check`, `npm test`.

`npm run dev` serves the app at a local address for UI work. There it runs without extension APIs: collection runs only while the tab is open, Google News fails (no CORS), and archiving is unavailable.

## How it works

- **The app** (`index.html`) is desktop Canary's Svelte UI. `src/api.js` keeps the desktop HTTP client's interface but is implemented locally over IndexedDB (`src/backend/`).
- **Collection** runs in an offscreen document (`offscreen.html`), which the service worker (`public/background.js`) wakes on a one-minute alarm and for **Run now**. It keeps running with the Canary tab closed, as long as Chrome is open. Each lane follows the project's interval settings; GDELT lanes that are behind catch up eight 15-minute files per stream per run, English and translated.
- **Google News** searches use explicit `after:`/`before:` week windows, so time away is caught up. They are spaced 2.5 to 4 seconds apart, capped at 120 per run, and stop for an hour when Google answers 429/503. Searches come from your own IP address.
- **Archiving** opens a saved item in a background tab, saves it with `chrome.pageCapture` as MHTML and writes it to `Downloads/Canary/`. **View snapshot** opens that file. The page loads with your own cookies and logins. Desktop's WARC capture in an isolated profile is not available.
- **Event headlines** (Project Settings) optionally fetch each new GDELT event's article title. Turning this on asks Chrome for access to all sites; turning it off gives that access back.
- **On-device language analysis** (Project Settings) detects language automatically and optionally enriches new RSS and Media Cloud items with entities and sentiment. Download and enable either multilingual model once; the models run in a worker in the offscreen collector, using the same pinned ONNX weights as desktop. Text stays local. Disable a model to unload it, or remove it to delete its model cache. Inference uses single-threaded WASM so it works without GPU support. Model files are cached separately from backups; download them again after restoring in a new browser profile.
- **Google Sheets** and **Media Cloud** work as on desktop. The Media Cloud token is stored in this browser and left out of backups.
- **Media Cloud filtering** applies simple-mode required terms to headlines (or entity metadata when present). Failed or partially completed searches keep their collection cursor so the next run retries the same window.
- **Story grouping** retains probable duplicate scores and reasons, plus review decisions and not-duplicate constraints, in project metadata and backups. The review API records decisions; merge/split operations and a review interface are not implemented, matching desktop's current backend scope.
- **Deleting an item or project** also removes its archive files when Chrome can identify the matching download as created by this extension. Moved files, untracked downloads, and files restored from another browser profile must be managed separately.

## Differences from desktop

- Language detection uses `franc-min` rather than desktop's `whatlang`, so results on short or ambiguous headlines may differ. Entity and sentiment models match desktop, with a 256-token input limit. Fuzzy grouping detects headline language and uses source metadata when detection is inconclusive.
- No WARC archives (MHTML only, see above).
- Item IDs use a 64-bit hash instead of a SHA-256 prefix, so desktop and extension data are not interchangeable.
- GKG items record the countries they mention, so the country filter works on them.

## Your data

Data lives in one Chrome profile. **Removing the extension deletes it**, so use **Download backup** in the sidebar regularly. **Restore backup** loads that file into another profile or computer. Archive files stay in Downloads.

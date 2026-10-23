# Decktech desktop app (Tauri)

This folder wraps the Decktech web app in a native desktop window using [Tauri 2](https://v2.tauri.app/). The desktop app runs the **same Angular build** as the web version, shown in the operating system's own webview (WebView2 on Windows). No Angular code is specific to the desktop app. Everything desktop-only lives in this folder.

## What's in here

| Path | What it is |
| --- | --- |
| `tauri.conf.json` | Main config: app name, version, identifier, main window, build commands and installer (bundle) settings. |
| `src/lib.rs` | Startup logic: splash screen, main window, link and new-window handling. |
| `src/main.rs` | Entry point; only calls `decktech_lib::run()`. |
| `splash/index.html` | The startup splash page, built into the binary. |
| `icons/` | App and installer icons, generated with `npx tauri icon` (still Tauri's placeholders, see the checklist below). |
| `capabilities/default.json` | Permissions the frontend gets for Tauri's JS APIs. The app doesn't use any, so this is only `core:default`. |
| `Cargo.toml` / `Cargo.lock` | Rust package and pinned dependencies. Commit both. |
| `target/`, `gen/schemas/` | Build output and generated schemas. Git ignores them. |

## How it works

### Startup and splash screen
1. On launch, `lib.rs` opens a small frameless **splash** window. Its HTML (`splash/index.html`) is built into the binary and served over a private `splash:` protocol (`http://splash.localhost/` on Windows). It shows immediately and doesn't depend on the Angular build.
2. The **main** window is declared in `tauri.conf.json` with `"visible": false` and `"create": false`. `lib.rs` creates it from that config.
3. When the main window's page has finished loading, the splash closes and the main window is shown and focused.

### Links and new windows
By default a webview ignores `window.open(...)` and `target="_blank"` links. `with_link_handling` in `lib.rs` decides what happens instead:

- **App URLs** (the bundled frontend, or `ng serve` in dev) open in a **new Decktech window**. The presenter view uses this. New windows take their title from the page.
- **External `http`/`https`/`mailto` links** open in the system's default browser or mail app. Other schemes are ignored.
- **Plain navigations away from the app** (a link without `target="_blank"`) also go to the default browser, so a website can never replace the app inside the window.

### Where the frontend comes from
- **Dev** (`tauri dev`): runs `npm run start` (`ng serve`) and loads `http://localhost:4200`, with live reload as in the browser.
- **Build** (`tauri build`): runs `npm run build` and builds `../dist/decktech/browser` into the executable. It's served from `http://tauri.localhost`. Unknown paths fall back to `index.html`, so Angular routes work.

### Data storage
Decks are stored in IndexedDB, as on the web. That storage belongs to the app's own WebView2 profile (under `%LOCALAPPDATA%\io.github.gibby.decktech\` on Windows), so:
- decks made in a normal browser **don't** show up in the desktop app, and the other way round;
- dev (`localhost:4200`) and the built app (`tauri.localhost`) are different origins, so they **don't share decks** either.

Use the `.deck` export/import to move decks between them.

## Prerequisites (Windows)

- **Node.js** and `npm install` at the repo root. This installs `@tauri-apps/cli`.
- **Rust** via [rustup](https://rustup.rs/) (`winget install Rustlang.Rustup`), stable MSVC toolchain.
- **Microsoft C++ Build Tools** (the "Desktop development with C++" workload).
- **WebView2 runtime**: already installed on Windows 10/11.

Run `npm run tauri info` to check the environment.

For macOS and Linux prerequisites, see the [Tauri docs](https://v2.tauri.app/start/prerequisites/).

## Using it

Run these from the **repo root**:

| Command | What it does |
| --- | --- |
| `npm run desktop:dev` | Starts `ng serve` and opens the desktop app against it, with live reload. Stop any `ng serve` you already have running on port 4200 first. |
| `npm run desktop:build` | Production Angular build, then a release build of the app and its installers. |
| `npm run tauri -- <cmd>` | Any other Tauri CLI command, for example `npm run tauri -- icon logo.svg`. |

The first build compiles all Rust dependencies and takes a few minutes. Later builds are much faster.

### Build output
- Executable: `src-tauri/target/release/decktech.exe`. It runs directly, no install needed.
- Installers: `src-tauri/target/release/bundle/msi/*.msi` and `src-tauri/target/release/bundle/nsis/*-setup.exe`.
- A dev build (from `desktop:dev`) is at `src-tauri/target/debug/decktech.exe`. It needs `ng serve` running, because it loads from `localhost:4200`.

### Configuration cheat sheet
- **Name, version, identifier**: `productName`, `version` and `identifier` in `tauri.conf.json`.
- **Main window size, minimum size, title**: `app.windows[0]` in `tauri.conf.json`.
- **Splash look**: `splash/index.html`. Its size and frameless style are set in `lib.rs`.
- **Installer types**: `bundle.targets` (`"all"`, or for example `["nsis"]`).
- **Icons**: put a square master image (SVG, or a PNG of at least 1024 px) somewhere and run `npm run tauri -- icon path/to/logo.png`. This regenerates `icons/`.

---

## Review checklist

### A. One-time: before the first real release
These only need checking once, to finish the setup.

- [ ] **Spelling of the name.** The app's screens say **"DeckTech"**, while `src/index.html`, `productName`, window titles and the splash say **"Decktech"**. Pick one. Windows uses `productName` for the install folder and Start-menu entry, so changing it later leaves a second install behind.
- [ ] **Identifier.** `io.github.gibby.decktech`. Never change it after the first release: it identifies the app (data folder, upgrades). If you do change it, users "lose" their decks, because the data folder moves.
- [ ] **Single source for the version.** Set `"version": "../package.json"` in `tauri.conf.json`, so the version is only bumped in `package.json`. Move `package.json` off `0.0.0` to a real version (for example `0.1.0`).
- [ ] **Real icons.** `icons/` still has Tauri's placeholder logo, and the web app only has a 48 px `favicon.ico`. Make one master logo, run `tauri icon` with it, and ideally regenerate `public/favicon.ico` from the same image.
- [ ] **Splash logo.** The logo in `splash/index.html` is a stand-in. Replace it with the real logo (inline SVG keeps the splash self-contained).
- [ ] **`Cargo.toml` metadata.** Replace `authors = ["Decktech"]` with the real author(s), and `license = ""` with `"MIT"` (as in `LICENSE`). Fix `repository`: it says `Gibb-y/decktech`, but the git remote is `vhjan/decktech`.
- [ ] **Installer metadata** in `tauri.conf.json` under `bundle`: `publisher`, `copyright`, `shortDescription`, `longDescription`, `category`, `license`/`licenseFile`. Windows shows these in the installer and in "Apps".
- [ ] **Installer type.** `"targets": "all"` builds both `.msi` and NSIS `-setup.exe`. Most projects ship only one (NSIS is the usual choice).
- [ ] **Code signing.** Unsigned installers trigger a Windows SmartScreen warning. Only needed if you share the installer beyond your own machines.
- [ ] **Content Security Policy.** `app.security.csp` is `null`, the same as the web app. Consider a CSP once you know what code components need (they load from `esm.sh`).
- [ ] **Commit** `src-tauri/` including `Cargo.lock`.

### B. Every new Decktech version
Run through these whenever the web app changes and you ship a new desktop build.

- [ ] **Bump the version.** Bump it in `package.json`, if `tauri.conf.json` points to it (otherwise in both). Installers use it to upgrade instead of installing side by side.
- [ ] **Smoke test** with `npm run desktop:build` and the built `decktech.exe` (not only dev mode):
  - [ ] The splash shows, then the main window appears with the library.
  - [ ] Create, edit and reopen a deck. Decks survive a restart.
  - [ ] Present a deck, open the **presenter view** (new window) and check that it follows the slides.
  - [ ] An external link in slide text, and one from a code component, opens in the default browser.
  - [ ] **Export** a `.deck` file and **import** one (file dialogs and downloads).
  - [ ] Fullscreen presenting enters and exits properly.
- [ ] **New ways of leaving the page.** If the web app added `window.open`, `target="_blank"`, new download flows, popups or external URLs, check them in the desktop app. Anything that isn't an app URL or `http`/`https`/`mailto` is blocked on purpose. Extend `with_link_handling` in `lib.rs` if needed.
- [ ] **New browser APIs** (clipboard, notifications, camera, file system, service workers…). They usually work in WebView2, but some need a permission or behave differently. Test them.
- [ ] **Theme or brand changes.** The splash colours are copied from the tokens in `src/styles.css` (light and dark). Update `splash/index.html` if those change. Regenerate the icons if the logo changed.
- [ ] **Build output path.** If `angular.json` changes the output folder, update `build.frontendDist`. If the dev server port or the `start`/`build` scripts change, update `devUrl`, `beforeDevCommand` and `beforeBuildCommand`.
- [ ] **Tauri updates** (now and then). Run `cargo update` in `src-tauri/` and update `@tauri-apps/cli`. Keep the npm CLI and the Rust `tauri` crate on the same minor version.

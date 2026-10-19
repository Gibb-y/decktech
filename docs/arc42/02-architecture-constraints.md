# 2. Architecture Constraints

## 2.1 Technical constraints

| Constraint | Background |
|------------|------------|
| Angular (v22+), TypeScript strict mode | Project standard, see `CLAUDE.md`. Standalone components, signals, zoneless, `OnPush` default, signal forms, lazy-loaded feature routes. |
| Runs in modern evergreen browsers | Chromium, Firefox, Safari current versions. Requires iframe `sandbox`, `postMessage`, IndexedDB, `BroadcastChannel`. |
| No mandatory backend | Local-first: the app is static files. Optional sync/sharing is a later add-on. |
| Must work offline | Service worker caches the app shell and all libraries. Code components may not depend on a CDN unless the author accepts that (see [8.6](08-crosscutting-concepts.md#86-offline-and-dependencies)). |
| Untrusted code execution | Code components are arbitrary JavaScript, potentially from other people. They must be isolated from the host app. |

## 2.2 Organizational constraints

| Constraint | Background |
|------------|------------|
| Small team / single maintainer | Prefer well-maintained libraries over custom infrastructure; keep the number of moving parts low. |
| Documentation as arc42 in `docs/` | This documentation is versioned with the code. Significant decisions are recorded as ADRs in section 9. |

## 2.3 Conventions

| Convention | Detail |
|------------|--------|
| Accessibility | Editor UI must pass AXE and meet WCAG AA (focus management, contrast, ARIA). Presented slides should be accessible to the extent the author's content allows; built-in elements emit semantic HTML. |
| Code style | Signals for state, `computed`/`linkedSignal` for derived state, `inject()`, native control flow, `host` object instead of `@HostBinding`/`@HostListener`, `NgOptimizedImage` for static images. |
| Library licensing | Only permissively licensed (MIT/Apache/BSD) dependencies, so that decks and the app can be freely redistributed. |

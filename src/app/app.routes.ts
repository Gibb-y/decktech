import { Routes } from '@angular/router';

/** Every screen is a lazy chunk, so the initial bundle holds only the shell (arc42 §4.4). */
export const routes: Routes = [
  {
    path: '',
    title: 'Your decks – DeckTech',
    loadComponent: () => import('./library/library-page').then((m) => m.LibraryPage),
  },
  {
    path: 'deck/:id',
    title: 'Editor – DeckTech',
    loadComponent: () => import('./editor/editor-shell').then((m) => m.EditorShell),
  },
  {
    path: 'deck/:id/present',
    title: 'Presentation – DeckTech',
    loadComponent: () => import('./presenter/presenter-page').then((m) => m.PresenterPage),
  },
  {
    path: 'deck/:id/presenter-view',
    title: 'Presenter view – DeckTech',
    loadComponent: () => import('./presenter/presenter-view/presenter-view-page').then((m) => m.PresenterViewPage),
  },
  // Drawn from a script by the MCP server (ADR-013): a slide of a deck handed over in the page, nothing stored.
  {
    path: 'preview',
    title: 'Preview – DeckTech',
    loadComponent: () => import('./preview-page').then((m) => m.PreviewPage),
  },
  // Profiling aid for quality scenario Q9; not part of production builds.
  // `ngDevMode` is a build-time constant (false in production), so the bundler drops this whole
  // branch, including the lazy import and its chunk; `isDevMode()` would be a runtime call it cannot fold.
  ...(typeof ngDevMode !== 'undefined' && ngDevMode
    ? [
        {
          path: 'dev/stress',
          title: 'Stress deck – DeckTech',
          loadComponent: () => import('./dev-stress-page').then((m) => m.DevStressPage),
        },
      ]
    : []),
  { path: '**', redirectTo: '' },
];

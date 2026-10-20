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
    loadComponent: () => import('./presenter/presenter-view-page').then((m) => m.PresenterViewPage),
  },
  { path: '**', redirectTo: '' },
];

import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { provideCodeComponents } from './components/host/providers';
import { provideDeckPersistence } from './core/persistence';
import { provideDeckArchive } from './library/archive';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideDeckPersistence(),
    provideDeckArchive(),
    provideCodeComponents()
  ]
};

import { inject, makeEnvironmentProviders, provideAppInitializer, type EnvironmentProviders } from '@angular/core';
import { AutosaveService } from './autosave';
import { DeckRepository } from './deck-repository';
import { IndexedDbDeckRepository } from './indexeddb-deck-repository';

/** IndexedDB-backed persistence; asks the browser for persistent storage at startup. */
export function provideDeckPersistence(): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: DeckRepository, useFactory: () => new IndexedDbDeckRepository() },
    provideAppInitializer(() => {
      void inject(AutosaveService).requestPersistence();
    }),
  ]);
}

import { inject, makeEnvironmentProviders, type EnvironmentProviders } from '@angular/core';
import { DECK_EXPORT_HANDLER } from '../../core/persistence';
import { DeckArchive } from './deck-archive';

/** Plugs the `.deck` writer into the "Download .deck" button of the autosave failure banner. */
export function provideDeckArchive(): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: DECK_EXPORT_HANDLER,
      useFactory: () => {
        const archive = inject(DeckArchive);
        return (deck: Parameters<DeckArchive['exportOpenDeck']>[0]) => archive.exportOpenDeck(deck);
      },
    },
  ]);
}

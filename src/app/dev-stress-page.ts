import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AutosaveService } from './core/persistence';
import { createStressDeck } from './editor/canvas/stress-deck';

/** Number of elements on the stress deck's slide: the Q9 scenario (arc42 §10.2). */
export const STRESS_ELEMENTS = 100;

/**
 * Development-only route (`dev/stress`, registered only in dev mode): creates the 100-element
 * stress deck and opens it in the editor, so a drag can be profiled in the real app (Q9).
 */
@Component({
  selector: 'app-dev-stress-page',
  imports: [RouterLink],
  template: `
    <h1 tabindex="-1">Stress deck</h1>
    @if (error(); as message) {
      <p role="alert">The stress deck could not be created: {{ message }}</p>
      <p><a routerLink="/">Back to your decks</a></p>
    } @else {
      <p role="status">Creating a deck with {{ count }} elements…</p>
    }
  `,
})
export class DevStressPage {
  protected readonly count = STRESS_ELEMENTS;
  protected readonly error = signal<string | null>(null);

  constructor() {
    const autosave = inject(AutosaveService);
    const router = inject(Router);
    const deck = createStressDeck(STRESS_ELEMENTS);
    void autosave.create(deck).then(async (result) => {
      if (!result.ok) return this.error.set(result.error.message);
      await autosave.flush();
      await router.navigate(['/deck', deck.id], { replaceUrl: true });
    });
  }
}

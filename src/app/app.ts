import { Component, DestroyRef, Injector, afterNextRender, inject } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { PersistenceBanner } from './core/persistence';
import { LiveRegion, SkipLink } from './shared';

@Component({
  imports: [RouterOutlet, PersistenceBanner, SkipLink, LiveRegion],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  constructor() {
    const injector = inject(Injector);
    let first = true;
    const subscription = inject(Router).events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      // Not on the first load, where focus belongs at the top of the page for the skip link.
      if (first) return void (first = false);
      // A route change replaces the page the focus was on: move it to the new page's heading.
      afterNextRender(
        () => (document.querySelector<HTMLElement>('#main-content h1') ?? document.getElementById('main-content'))?.focus(),
        { injector },
      );
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }
}

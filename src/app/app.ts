import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PersistenceBanner } from './core/persistence';

@Component({
  imports: [RouterOutlet, PersistenceBanner],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('decktech');
}

import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PersistenceBanner } from './core/persistence';
import { LiveRegion, SkipLink } from './shared';

@Component({
  imports: [RouterOutlet, PersistenceBanner, SkipLink, LiveRegion],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {}

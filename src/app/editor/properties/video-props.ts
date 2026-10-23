import { Component, computed, inject, input } from '@angular/core';
import type { VideoEl } from '../../core/model';
import { DeckStore, SetProps } from '../../core/store';
import { InsertActions } from '../insert-actions';

/**
 * The properties panel's part for a video (arc42 §5.4): which video file and poster it uses, with
 * buttons to choose or replace them, and to remove the poster. Playback options (autoplay, loop,
 * muted) and the accessible name are plain schema fields in the panel's other sections.
 */
@Component({
  selector: 'app-video-props',
  templateUrl: './video-props.html',
  styleUrl: './element-props.css',
})
export class VideoProps {
  readonly element = input.required<VideoEl>();

  private readonly store = inject(DeckStore);
  private readonly insert = inject(InsertActions);

  protected readonly locked = computed(() => this.element().locked === true);
  protected readonly videoSize = computed(() => formatSize(this.store.deck().assets[this.element().assetId]?.size));
  protected readonly posterSize = computed(() => {
    const poster = this.element().poster;
    return poster ? formatSize(this.store.deck().assets[poster]?.size) : null;
  });

  protected choose(which: 'assetId' | 'poster'): void {
    this.insert.pickVideoFile(this.element().id, which);
  }

  protected removePoster(): void {
    this.store.execute(new SetProps([this.element().id], { poster: undefined }));
  }
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return 'not in the deck';
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

import { DestroyRef, Service, inject, signal, type WritableSignal } from '@angular/core';
import { DeckRepository } from '../core/persistence';

const ASSET_ID = /^[0-9a-f]{64}$/;

/**
 * Object URLs for stored assets. Assets are content-addressed (arc42 §8.5), so the asset id of an
 * element is the key to load; the URL is a signal-backed value that turns non-null once the blob
 * is read. Without a repository, or for an unknown id, the URL stays `null` and renderers show a
 * placeholder.
 */
@Service()
export class AssetUrls {
  private readonly repository = inject(DeckRepository, { optional: true });
  private readonly urls = new Map<string, WritableSignal<string | null>>();
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      for (const url of this.urls.values()) {
        const value = url();
        if (value) URL.revokeObjectURL(value);
      }
      this.urls.clear();
    });
  }

  /** Reactive read: `null` until the asset is available. Starts loading on first use. */
  url(assetId: string): string | null {
    let entry = this.urls.get(assetId);
    if (!entry) {
      entry = signal<string | null>(null);
      this.urls.set(assetId, entry);
      void this.load(assetId, entry);
    }
    return entry();
  }

  private async load(assetId: string, target: WritableSignal<string | null>): Promise<void> {
    if (!this.repository || !ASSET_ID.test(assetId)) return;
    const result = await this.repository.getAsset(assetId);
    if (!result.ok || this.destroyed) return;
    target.set(URL.createObjectURL(result.value));
  }
}

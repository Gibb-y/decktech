import { DestroyRef, Service, inject } from '@angular/core';
import type { FontFaceRef } from '../core/model';
import { AssetUrls } from './asset-urls';

/**
 * Loads the fonts a deck embeds as assets (`Theme.fontFaces`) with the `FontFace` API, so a deck
 * looks the same on a projector laptop that lacks them (risk R7). `register` reads the asset URL
 * signals, so calling it from an `effect` retries once a blob has been read. A font that fails to
 * load is forgotten and the stack falls back to the next family.
 */
@Service()
export class FontFaces {
  private readonly urls = inject(AssetUrls);
  private readonly faces = new Map<string, FontFace>();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (typeof document === 'undefined' || !document.fonts) return;
      for (const face of this.faces.values()) document.fonts.delete(face);
      this.faces.clear();
    });
  }

  register(refs: readonly FontFaceRef[] | undefined): void {
    if (!refs || typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return;
    for (const ref of refs) {
      const url = this.urls.url(ref.assetId);
      const key = `${ref.family}|${ref.assetId}`;
      if (!url || this.faces.has(key)) continue;
      const face = new FontFace(ref.family, `url(${JSON.stringify(url)})`);
      this.faces.set(key, face);
      document.fonts.add(face);
      face.load().catch(() => {
        document.fonts.delete(face);
        if (this.faces.get(key) === face) this.faces.delete(key);
      });
    }
  }
}

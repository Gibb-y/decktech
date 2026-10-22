import { InjectionToken, type Type } from '@angular/core';
import type { ComponentDef } from '../core/model';

/**
 * Loads the component that draws a code element. The renderer may not import the component host
 * (`components` depends on `renderer`, arc42 §4.4), so the app provides it here, and as a loader so
 * that the sandbox code stays out of the initial bundle until a slide has a code element. The
 * component must accept the inputs of `ElementView` plus `mode`, `components`, `deckId` and `ghost`.
 * Without a provider code elements are not drawn.
 */
export type CodeViewLoader = () => Promise<Type<unknown>>;

export const CODE_ELEMENT_VIEW = new InjectionToken<CodeViewLoader>('Code element view');

/**
 * Loads the dialogs for code components (code editor, component library). The editor may not import
 * the component feature (4.4) and the dialogs bring CodeMirror, so the app provides a loader and the
 * editor shell draws the result with `NgComponentOutlet`. The component must have the inputs
 * `view` (`'edit'` or `'library'`) and `elementId` (the code element being edited, or `null`) and an
 * output `closed`. Without a provider the editor offers no code tools.
 */
export type ComponentToolsLoader = () => Promise<Type<unknown>>;

export const COMPONENT_TOOLS = new InjectionToken<ComponentToolsLoader>('Component tools');

/**
 * What the editor and presenter need to know about the user's trust decisions for a deck's code
 * (arc42 §6.4), provided by the app because the owner of the decisions is the component feature.
 * `refresh` re-reads the decision of a deck that is being opened, before anything is drawn.
 * `needsReview` is reactive: true while the deck has code the user has not decided on. Without a
 * provider the editor never asks.
 */
export interface CodeTrust {
  refresh(deckId: string): Promise<void>;
  needsReview(deckId: string, components: readonly ComponentDef[]): boolean;
}

export const CODE_TRUST = new InjectionToken<CodeTrust>('Code trust');

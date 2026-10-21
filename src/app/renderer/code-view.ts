import { InjectionToken, type Type } from '@angular/core';

/**
 * Loads the component that draws a code element. The renderer may not import the component host
 * (`components` depends on `renderer`, arc42 §4.4), so the app provides it here, and as a loader so
 * that the sandbox code stays out of the initial bundle until a slide has a code element. The
 * component must accept the inputs of `ElementView` plus `mode`, `components`, `deckId` and `ghost`.
 * Without a provider code elements are not drawn.
 */
export type CodeViewLoader = () => Promise<Type<unknown>>;

export const CODE_ELEMENT_VIEW = new InjectionToken<CodeViewLoader>('Code element view');

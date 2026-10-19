export type IdKind = 'deck' | 'slide' | 'element' | 'component' | 'layout' | 'placeholder';

const PREFIX: Record<IdKind, string> = {
  deck: 'dk',
  slide: 'sl',
  element: 'el',
  component: 'cp',
  layout: 'ly',
  placeholder: 'ph',
};

/** Shape accepted for any id, shared by the generator and the validator. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Generates a unique id such as `sl_3f2b...`; random, so safe to create offline and to merge. */
export function generateId(kind: IdKind): string {
  return `${PREFIX[kind]}_${crypto.randomUUID()}`;
}

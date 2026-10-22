import type { ComponentDef } from '../model';
import { sha256Hex } from './assets';

/**
 * What the user decided about the code of one deck (arc42 §6.4, ADR-008). A deck with no record is
 * trusted: it was made here. A deck imported from a file gets a `pending` record and stays without
 * running code until the user decides. Trust is bound to content: each decision names the hash of
 * the component definition it was made for, so a changed component is undecided again.
 */
export interface TrustRecord {
  deckId: string;
  /** The deck id inside the file; differs from `deckId` when the library already had that id. */
  sourceId: string;
  status: 'pending' | 'decided';
  /** SHA-256 of `deck.json` of the import (arc42 §8.5). */
  archiveHash: string;
  /** Epoch milliseconds of the last decision, `null` while pending. */
  decidedAt: number | null;
  /** One entry per component the user has decided on, bound to the hash they saw. */
  decisions: ComponentDecision[];
  /** Sources of the components the user chose to run, as they were then: the base of the diff. */
  snapshots: ComponentSnapshot[];
  /** An earlier trusted version of the same source deck, if one was known at import: the base of the diff until a decision is made. */
  previous: ComponentSnapshot[] | null;
}

export interface ComponentDecision {
  componentId: string;
  /** `componentHash` of the definition the decision is about. */
  hash: string;
  run: boolean;
}

/** A component's reviewable sources: what the inspector shows and the diff compares. */
export interface ComponentSnapshot {
  componentId: string;
  name: string;
  html: string;
  css: string;
  js: string;
  /** The property schema as formatted JSON text. */
  props: string;
  permissions: string[];
  /** Library asset ids (SHA-256 digests of the library files). */
  libs: string[];
  files: string[];
}

/** JSON with object keys in sorted order, so equal definitions give equal text whatever the key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 of a component definition (all of it: code, schema, permissions, library and file lists). */
export function componentHash(def: ComponentDef): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(def)));
}

export function snapshotOf(def: ComponentDef): ComponentSnapshot {
  return {
    componentId: def.id,
    name: def.name,
    html: def.html,
    css: def.css,
    js: def.js,
    props: JSON.stringify(def.propSchema, null, 2),
    permissions: [...def.permissions],
    libs: [...def.libs],
    files: [...def.files],
  };
}

/** The record of a freshly imported deck: nothing is decided yet. */
export function pendingRecord(deckId: string, sourceId: string, archiveHash: string, previous: ComponentSnapshot[] | null): TrustRecord {
  return { deckId, sourceId, status: 'pending', archiveHash, decidedAt: null, decisions: [], snapshots: [], previous };
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

function isSnapshot(value: unknown): value is ComponentSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s['componentId'] === 'string' &&
    typeof s['name'] === 'string' &&
    typeof s['html'] === 'string' &&
    typeof s['css'] === 'string' &&
    typeof s['js'] === 'string' &&
    typeof s['props'] === 'string' &&
    isStrings(s['permissions']) &&
    isStrings(s['libs']) &&
    isStrings(s['files'])
  );
}

/**
 * Stored records are read back through this check. A record that does not have the shape is
 * `null`, which callers treat as "pending", never as "trusted": damage must not switch code on.
 */
export function readTrustRecord(value: unknown): TrustRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const decisions = r['decisions'];
  const snapshots = r['snapshots'];
  const previous = r['previous'];
  const valid =
    typeof r['deckId'] === 'string' &&
    typeof r['sourceId'] === 'string' &&
    (r['status'] === 'pending' || r['status'] === 'decided') &&
    typeof r['archiveHash'] === 'string' &&
    (r['decidedAt'] === null || typeof r['decidedAt'] === 'number') &&
    Array.isArray(decisions) &&
    decisions.every((d: unknown) => {
      const x = d as Record<string, unknown> | null;
      return typeof x?.['componentId'] === 'string' && typeof x['hash'] === 'string' && typeof x['run'] === 'boolean';
    }) &&
    Array.isArray(snapshots) &&
    snapshots.every(isSnapshot) &&
    (previous === null || (Array.isArray(previous) && previous.every(isSnapshot)));
  return valid ? structuredClone(value as TrustRecord) : null;
}

/** What a stored value stands for: its record, or, when it is damaged, a pending one (never "no record", which means trusted). */
export function trustOrPending(deckId: string, stored: unknown): TrustRecord {
  return readTrustRecord(stored) ?? pendingRecord(deckId, deckId, '', null);
}

/** The earlier trusted version to compare a new import of `sourceId` against: the latest decision that ran something. */
export function previousSnapshots(records: readonly TrustRecord[], sourceId: string): ComponentSnapshot[] | null {
  const best = records
    .filter((r) => r.sourceId === sourceId && r.status === 'decided' && r.snapshots.length > 0)
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))[0];
  return best ? structuredClone(best.snapshots) : null;
}

import type { z } from 'zod';
import type { Workspace } from './workspace';

/** A problem the agent can act on: bad input, a refused command, a missing deck. Reported as a tool error, never fixed silently. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** A tool result with pictures next to the data (PNG, base64 in the MCP reply). */
export class ToolImages {
  constructor(
    readonly data: unknown,
    readonly images: readonly Uint8Array[],
  ) {}
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** The tool changes nothing (no deck, no file). */
  readOnly?: boolean;
  /** Returns plain JSON data for the agent; throws `ToolError` or `CommandError` for a refusal. */
  run(workspace: Workspace, input: z.infer<S>): unknown | Promise<unknown>;
}

/** Keeps the type of `input` for `run` while letting a list hold tools of different shapes. */
export const defineTool = <S extends z.ZodObject>(tool: ToolDef<S>): ToolDef =>
  tool as unknown as ToolDef;

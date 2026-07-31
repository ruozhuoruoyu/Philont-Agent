/**
 * writeFile tool - write to a file
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool } from '@agent/policy';

export const writeFileTool: Tool = {
  name: 'writeFile',
  description: 'Write contents to a file',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'File contents' },
    },
    required: ['path', 'content'],
  },
  capability: 'write',
  domain: 'local',
  async execute(params) {
    const path = params.path as string;
    const content = params.content as string;
    try {
      // Create the parent directory. Writing the first file of a NEW project is the ordinary case —
      // `mkdir -p` is what every editor, every scaffolder and every `>` redirect in a shell does — and
      // without it the agent gets ENOENT on a path it has every right to write.
      //
      // The cost of not doing it, production 2026-07-31 13:30:06: four writeFile calls laying out a Lean
      // project under output/lrc-formal/ failed ENOENT inside 30 milliseconds. That tripped
      // writeFile:enoent ×4 → in-turn-tool-block disabled writeFile for the rest of the turn →
      // research-before-retry blocked shell as well → auto-revise-on-fail flipped the session to slow and
      // minted a placeholder plan → the reply claimed "已完成" over four failed writes and the honesty gate
      // fired. Every one of those mechanisms behaved correctly. The whole cascade came from a missing
      // directory, and the strategic machinery has no way to tell "your approach is wrong" from
      // "mkdir first".
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf-8');
      return { success: true, output: `Wrote ${content.length} bytes to ${path}` };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: `Failed to write file: ${error}`,
      };
    }
  },
};

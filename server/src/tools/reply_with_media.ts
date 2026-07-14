/**
 * Tool · `replyWithMedia`
 *
 * Sends a local file as media back to the peer in the current session (in WeChat, that is
 * the current conversation user; in a group, it replies to the group).
 *
 * Design points:
 *   - Does not accept an explicit `to` parameter — the peer is automatically resolved from
 *     the sessionId via the channel registry. The LLM does not need to know (and should not
 *     see) the user's user_id.
 *   - If the current session does not belong to any channel that has registered media
 *     capability (typical case: web-ui direct connection) → return a clear error, **not a
 *     silent success**. The LLM knows it should switch to `writeFile` to save locally and
 *     tell the user the path in the response text.
 *   - The file must actually exist + be non-empty + not exceed the hard size limit —
 *     the channel performs its own size check.
 *   - capability=write, domain=network → PolicyGate will ask for authorization the first
 *     time (same as other network write operations).
 */

import type { Tool } from '@agent/policy';
import { findMediaChannel, type MediaKind } from '../channels/registry.js';
import { currentSessionId } from '../channels/turn_context.js';

const VALID_KINDS: MediaKind[] = ['image', 'file', 'voice', 'video'];

export const replyWithMediaTool: Tool = {
  name: 'replyWithMedia',
  description:
    'Send a local file back to the peer of the current session\'s channel as media (on WeChat = the person you are talking to; in a group = the group).\n' +
    'kind is one of image/file/voice/video; path is an absolute local path.\n' +
    'Only works when the current session came from a media-capable channel (e.g. WeChat). On web-ui and ' +
    'similar it returns an explicit error — in that case use writeFile and tell the user the path in your reply.',
  schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: VALID_KINDS,
        description: 'image = picture (jpg/png/gif), video = mp4, voice = silk audio, file = any file',
      },
      path: { type: 'string', description: 'absolute path to the local file' },
      fileName: {
        type: 'string',
        description: 'optional: the filename the recipient sees; defaults to the basename of path',
      },
    },
    required: ['kind', 'path'],
  },
  capability: 'write',
  domain: 'network',

  async execute(params: Record<string, unknown>) {
    const kind = params.kind as MediaKind;
    const path = params.path as string;
    const fileName = params.fileName as string | undefined;

    if (!VALID_KINDS.includes(kind)) {
      return {
        success: false,
        output: '',
        error: `invalid kind: ${JSON.stringify(kind)}; must be one of ${VALID_KINDS.join('/')}`,
      };
    }
    if (typeof path !== 'string' || path.length === 0) {
      return { success: false, output: '', error: 'path must be a non-empty string' };
    }

    const sid = currentSessionId();
    if (!sid) {
      // Not in a turn context (called externally? should not happen)
      return {
        success: false,
        output: '',
        error: 'no active turn context — replyWithMedia must be called during a chat turn',
      };
    }

    const channel = findMediaChannel(sid);
    if (!channel) {
      return {
        success: false,
        output: '',
        error:
          `The current session (${sid}) is not on a media-capable channel (web-ui, typically). ` +
          `To get the file to the user, write it with writeFile and tell them the path in your reply.`,
      };
    }

    try {
      const r = await channel.send(sid, { kind, path, fileName });
      return {
        success: true,
        output: `✓ Sent ${kind} via ${channel.name} (path=${path}${r.messageId ? `, messageId=${r.messageId}` : ''})`,
      };
    } catch (e) {
      return {
        success: false,
        output: '',
        error: `${channel.name} send failed: ${(e as Error)?.message ?? String(e)}`,
      };
    }
  },
};

/**
 * http tool - HTTP requests
 */

import type { Tool } from '@agent/policy';
import { coerceHeadersParam } from './securedHttp.js';

export const httpTool: Tool = {
  name: 'http',
  description:
    'Send an HTTP request and return the response **text** into context. ' +
    'Only suitable for APIs / small JSON / text pages. To download binaries (PDF/image/zip) or large files, use the downloadFile tool (it streams bytes to disk without using context).',
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL' },
      method: { type: 'string', description: 'HTTP method', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
      headers: {
        type: 'object',
        description: 'Request headers as an OBJECT, e.g. {"Authorization": "Bearer {my-key}"} — not a JSON string',
      },
      body: { type: 'string', description: 'Request body (JSON string)' },
    },
    required: ['url'],
  },
  capability: 'read',
  domain: 'network',
  /** Dynamic classification: POST/PUT/DELETE/PATCH → write, others → read */
  classify(params) {
    const method = String(params.method ?? 'GET').toUpperCase();
    const isWrite = /^(POST|PUT|DELETE|PATCH)$/.test(method);
    return { capability: isWrite ? 'write' : 'read', domain: 'network' };
  },
  async execute(params) {
    const url = params.url as string;
    const method = (params.method as string) || 'GET';
    // Same coercion as the secured tool: a JSON-string headers value would otherwise be spread by
    // Object.entries into index→character pairs and the real headers silently dropped.
    const coerced = coerceHeadersParam(params.headers);
    if ('error' in coerced) return { success: false, output: '', error: coerced.error };
    const headers = Object.fromEntries(
      Object.entries(coerced.headers).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]),
    );
    const body = params.body as string | undefined;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
      });

      const text = await response.text();
      return {
        success: response.ok,
        output: text,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: String(error),
      };
    }
  },
};

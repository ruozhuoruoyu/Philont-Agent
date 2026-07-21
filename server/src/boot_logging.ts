/**
 * Side-effect module: install the file tee at IMPORT time.
 *
 * Why this exists rather than a plain `initFileLogging()` call at the top of an entry point:
 * ES import declarations are hoisted and evaluated before ANY statement in the importing module. So
 *
 *     import { initFileLogging } from './file_logger.js';
 *     initFileLogging();                    // ← a statement
 *     import { handleChatSend } from './chat-handler.js';
 *
 * evaluates chat-handler's entire module body — and everything it logs — BEFORE the tee is installed.
 * Anything a module logs while being imported therefore went to the console only and never reached the
 * file, which is the record that survives a paused or scrolled-away terminal.
 *
 * That silently cost us the compass diagnostics. Loading compass.md is synchronous module-level code in
 * chat-handler, and it logs exactly one of `[compass] loaded … N focus area(s)` / `[compass] none at …` /
 * `[compass] failed to load` — the ONLY signal that the owner's own authored direction was picked up and
 * parsed. Prod 2026-07-21: a 65-minute log contained none of the three, so there was no way to tell
 * whether the compass was in effect, absent, or silently parsed to null (in which case it contributes an
 * empty block to the system prompt and changes nothing). By contrast `[skills] startup loaded total 62
 * skills` was present — because it is emitted from a `.then()` callback, i.e. after the import phase.
 *
 * Importing this module for its side effect makes the tee part of the import phase itself, so it is in
 * place before any module that logs while loading. Import it as early as possible in every entry point.
 * initFileLogging is idempotent, so an entry point that also calls it explicitly stays correct.
 */
import { initFileLogging } from './file_logger.js';

initFileLogging();

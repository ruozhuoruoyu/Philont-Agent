/**
 * skill-reflex (2026-06-17).
 *
 * The agent reaches for `shell` to hand-roll a common document-parsing task (PDF text extraction, OCR,
 * Word/Excel parsing) instead of first checking whether an installed skill already does it — observed in
 * prod: it `downloadFile`d an arXiv PDF then ran `python -c "import pdfplumber ..."` (which wasn't even
 * installed → traceback), never calling search_skills. This pure detector flags such a hand-rolled parse so
 * chat-handler can nudge the agent to `search_skills` / `use_skill('clawhub')` first (once per session).
 *
 * Scope is deliberately narrow: only well-known doc-parsing libraries that ClawHub skills typically cover.
 * General computation (numpy, sympy, PARI/GP, z3) is NOT flagged — that is legitimate first-party work.
 */

interface ParserPattern {
  /** Human label for the task category, used in the nudge message. */
  label: string;
  re: RegExp;
}

const PARSER_PATTERNS: ParserPattern[] = [
  { label: 'PDF text extraction', re: /pdfplumber|PyPDF2|\bpypdf\b|\bfitz\b|PyMuPDF|pdfminer|pdf2image|\bcamelot\b|\btabula\b/i },
  { label: 'OCR / image-to-text', re: /pytesseract|easyocr|\btesseract\b/i },
  { label: 'Word/DOCX parsing', re: /python-docx|docx2txt|\bmammoth\b|import\s+docx\b|from\s+docx\b/i },
  { label: 'Excel/XLSX parsing', re: /openpyxl|\bxlrd\b|read_excel/i },
];

/**
 * If the tool call is a `shell` command that hand-rolls a well-known document-parsing task, return a label
 * for that task category; otherwise null. Pure and side-effect free (the once-per-session guard and the
 * "did the agent already search skills this turn" check live in the caller).
 */
export function detectHandRolledParser(toolName: string, input: unknown): string | null {
  if (toolName !== 'shell') return null;
  const cmd =
    input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string'
      ? ((input as { command: string }).command)
      : '';
  if (!cmd) return null;
  for (const p of PARSER_PATTERNS) {
    if (p.re.test(cmd)) return p.label;
  }
  return null;
}

/** The advisory returned as the tool_result when a hand-rolled parse is intercepted. */
export function buildSkillReflexNudge(label: string): string {
  return (
    `[skill-reflex] You're about to hand-roll ${label} with a raw shell script. Before that, call ` +
    `search_skills('${label}') — there may already be an installed skill that does this reliably (the prod ` +
    `pdfplumber attempt failed because the library wasn't even installed). If no installed skill matches, ` +
    `use_skill('clawhub') to install one from the public skill library. Only fall back to a raw script if no ` +
    `skill fits. This check fires once per session — if you've already decided no skill helps, just re-issue ` +
    `the same shell command and it will run as-is.`
  );
}

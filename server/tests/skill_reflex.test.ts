/**
 * detectHandRolledParser — flag a shell command that hand-rolls a common doc-parsing task (PDF/OCR/
 * Word/Excel) so the agent is nudged to search_skills first; never flag legitimate first-party
 * computation (numpy/sympy/PARI-GP) or non-shell tools (2026-06-17).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHandRolledParser } from '../src/skill_reflex.js';

test('shell pdfplumber → PDF label (the prod case)', () => {
  const cmd = `python -c "import pdfplumber; pdf=pdfplumber.open('x.pdf'); print(pdf.pages[0].extract_text())"`;
  assert.equal(detectHandRolledParser('shell', { command: cmd }), 'PDF text extraction');
});

test('shell PyMuPDF/fitz → PDF label', () => {
  assert.equal(detectHandRolledParser('shell', { command: 'python -c "import fitz; doc=fitz.open(p)"' }), 'PDF text extraction');
});

test('shell pytesseract → OCR label', () => {
  assert.equal(detectHandRolledParser('shell', { command: 'python ocr.py  # uses pytesseract' }), 'OCR / image-to-text');
});

test('shell openpyxl / read_excel → Excel label', () => {
  assert.equal(detectHandRolledParser('shell', { command: 'python -c "import pandas as pd; pd.read_excel(f)"' }), 'Excel/XLSX parsing');
  assert.equal(detectHandRolledParser('shell', { command: 'python -c "import openpyxl"' }), 'Excel/XLSX parsing');
});

test('shell python-docx → Word label', () => {
  assert.equal(detectHandRolledParser('shell', { command: 'python -c "from docx import Document"' }), 'Word/DOCX parsing');
});

test('legitimate computation (numpy/sympy/PARI-GP) → null (not flagged)', () => {
  assert.equal(detectHandRolledParser('shell', { command: 'python -c "import numpy; import sympy"' }), null);
  assert.equal(detectHandRolledParser('shell', { command: 'gp -q search.gp' }), null);
});

test('non-shell tools are never flagged', () => {
  assert.equal(detectHandRolledParser('pariGp', { command: 'import pdfplumber' }), null);
  assert.equal(detectHandRolledParser('readFile', { path: 'x.pdf' }), null);
});

test('missing/empty command → null', () => {
  assert.equal(detectHandRolledParser('shell', {}), null);
  assert.equal(detectHandRolledParser('shell', { command: '' }), null);
  assert.equal(detectHandRolledParser('shell', null), null);
});

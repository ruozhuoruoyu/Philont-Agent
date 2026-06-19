---
name: document-extract
description: Extract text and tables from PDF / Word / Excel / PowerPoint files using philont's pre-installed Python libraries. Covers PDF text extraction, OCR-free parsing, and reading .docx/.xlsx/.pptx. Never pip-install at runtime — the deps are already provisioned.
when_to_use: A PDF / .docx / .xlsx / .pptx was downloaded or provided and its text/tables are needed; "PDF text extraction"; "read this paper / document / spreadsheet / deck"; the agent is about to hand-roll parsing with pypdf / pdfplumber / python-docx / openpyxl / python-pptx.
version: 1.0.0
---

# Document Extraction

Extract text and tables from documents with philont's **pre-installed** Python libraries.

## Critical rules

- **Do NOT `pip install` anything.** The libraries below are already installed in philont's
  managed Python environment, which is on PATH — bare `python` resolves to it. Runtime installs
  flood the log, evict context, and on Windows may land in a different interpreter.
- **Use the bare `python` command** in `shell` (it points at the managed venv). Do not invent a
  path to some other interpreter.
- **Always use ABSOLUTE file paths** (e.g. `C:\Users\...\.philont\downloads\paper.pdf`). The shell
  runs from philont's process directory, not where files were downloaded — a relative path will fail
  with `python: can't open file`.
- **Correct library names** (a frequent mistake): the PDF library is **`pypdf`** (NOT the old
  `PyPDF2`). `pdftotext` (poppler) is NOT available on Windows — use the Python libraries below.

## Pre-installed libraries

| Format | Library (import name) | Use |
|---|---|---|
| PDF | `pypdf` | page text, merge/split, form fields |
| PDF | `pdfplumber` | better text + **table** extraction, multi-column layouts |
| Word `.docx` | `docx` (python-docx) | paragraphs, tables, styles |
| Excel `.xlsx` | `openpyxl` | cells, formulas, sheets |
| PowerPoint `.pptx` | `pptx` (python-pptx) | slides, shapes, text frames |

## Canonical extraction

**PDF → text file** (write the text next to the PDF so later steps can read it):

```bash
python -c "import pdfplumber,sys; p=r'C:\ABSOLUTE\PATH\paper.pdf'; t='\n'.join((pg.extract_text() or '') for pg in pdfplumber.open(p).pages); open(p[:-4]+'.txt','w',encoding='utf-8').write(t); print('wrote',p[:-4]+'.txt',len(t),'chars')"
```

If `pdfplumber` text is empty/garbled, fall back to `pypdf`:

```bash
python -c "import pypdf; p=r'C:\ABSOLUTE\PATH\paper.pdf'; r=pypdf.PdfReader(p); t='\n'.join((pg.extract_text() or '') for pg in r.pages); open(p[:-4]+'.txt','w',encoding='utf-8').write(t); print(len(t),'chars')"
```

**Word:** `python -c "import docx; print('\n'.join(p.text for p in docx.Document(r'C:\...\file.docx').paragraphs))"`

**Excel:** `python -c "import openpyxl; wb=openpyxl.load_workbook(r'C:\...\file.xlsx'); [print(r) for r in wb.active.iter_rows(values_only=True)]"`

## Workflow

1. Confirm the file exists (`glob` / `inspectPath`) and note its **absolute path**.
2. Run the extraction snippet for the format, writing a `.txt` beside the source.
3. **Verify**: check the printed char count is non-zero and read back the `.txt`. Do NOT claim
   extraction succeeded without seeing the actual text — empty output means a scanned/image PDF
   (no text layer) and needs OCR, which is out of scope here.
4. Use the extracted text for summary/analysis.

If the managed Python is missing (`import pypdf` raises ModuleNotFoundError), the venv was not
provisioned — tell the user to run `scripts/setup-python-env.(ps1|sh)`; do NOT pip-install.

# Philont website

Zero-dependency static landing page. The runtime diagram is explicitly an architecture illustration,
not a product recording or benchmark.

Preview locally:

```bash
cd website
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

The repository's `pages.yml` publishes this directory with GitHub Actions. No build command is required.
The production domain is `https://philont.ai` and must be configured in **Settings → Pages → Custom
domain**. GitHub ignores repository `CNAME` files when Pages uses a custom Actions workflow, so this
directory deliberately does not contain one.

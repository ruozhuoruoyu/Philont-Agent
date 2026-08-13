# Philont website

Zero-dependency static landing page. The runtime diagram is explicitly an architecture illustration,
not a product recording or benchmark.

Preview locally:

```bash
cd website
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

Deploy the directory as-is to Cloudflare Pages, GitHub Pages, Vercel, Netlify, or any static host. No
build command is required; the output directory is `website`. Add the production domain only after DNS
and hosting are chosen (for GitHub Pages, add it as `website/CNAME`).

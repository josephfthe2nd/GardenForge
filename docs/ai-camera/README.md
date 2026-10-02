# Files behind `docs/AI-CAMERA.md`

Design-time artifacts only. Nothing here is loaded by the app or the server; `.vercelignore` keeps `docs/`
out of the deployed site.

| File | What it backs | Run |
| --- | --- | --- |
| `assessment.schema.json` | Section 7.1, the `gf-assessment-1` schema passed in `output_config.format` (5,154 bytes minified, claim C52). | `python3 -c "import json;print(len(json.dumps(json.load(open('assessment.schema.json')),separators=(',',':'))))"` |
| `sanitizer-prototype.js` | Section 5.13, the output sanitizer (`gf-sanitize-1`) that removes sentences that look like a product or dose recommendation. A prototype: the server version must keep its 15 regression cases. | `node sanitizer-prototype.js` prints a sample run |
| `sanitizer-prototype.test.js` | Claim C51, the 15 keep/remove cases. | `node sanitizer-prototype.test.js` |
| `size-worst-case.py` | Section 7.3 and claim C53, the worst-case assessment size and the size-fit steps. | `python3 size-worst-case.py` |
| `cost-estimate.py` | Section 8, image tokens per photo and the cost per check and per month. Every text and output token count in it is an estimate until measured (section 8.6). | `python3 cost-estimate.py` |

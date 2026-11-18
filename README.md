# Kmart SKU Checker

Check whether specific SKUs are online in **AU** and **NZ** via Kmart’s public Constructor search API.

## Web UI

Live (GitHub Pages):

https://arthurmellors.github.io/kmart-sku-checker/

Locally:

```bash
python3 serve.py
# → http://127.0.0.1:8787
```

Or any static server from `web/`:

```bash
cd web && python3 -m http.server 8787
```

## CLI

```bash
python3 check_skus.py 43172382 41026267
python3 check_skus.py -f skus.txt --watch --csv results.csv
```

No third-party Python packages required.

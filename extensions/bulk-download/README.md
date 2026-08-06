# Opptra, Bulk SO Document Download (Chrome extension)

Paste Unicommerce SO numbers → downloads each one's invoice/label PDF to **Downloads/opptra-so**, named by SO number.

## Load it (one time)
1. Chrome → `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → select this `bulk-download-extension` folder.
3. Pin the extension. **Log into Unicommerce** in a normal tab (the extension uses that session).

## Use
1. Click the extension icon.
2. Confirm the **base URL** (`https://oppdoor.unicommerce.co.in`).
3. Choose **document type** (All / Invoice / Shipping label).
4. Paste **SO numbers** (comma or newline separated) → **Download**.
5. PDFs land in **Downloads/opptra-so/** as `<SO>.pdf`. Progress shows per SO.

## How it works (decoded from production)
- `POST /data/document/auth/details/get {identifier:"SO-<so>"}` → `{token, checksum, url, identifier}` (uses your logged-in session).
- `GET docs.unicommerce.com/documents/list?identifier=..&token=..&checksum=..` → the SO's documents.
- Each document PDF is downloaded via the token-authenticated URL.

## ⚠ One thing to finalize on the first real run
The HAR we captured was for an SO with **no generated documents**, so the exact **document-list item shape** (which field holds the PDF URL) isn't 100% locked. The worker tries the common fields and **logs the raw list item to the console** if it can't resolve the URL. On the first run against a **real invoiced SO**:
- If PDFs download → done.
- If it says "PDF URL not resolved, see console": open the extension's **service-worker console** (`chrome://extensions` → this extension → *Inspect views: service worker*), copy the logged `raw list:` object, and send it to me, I'll lock the field in one line.

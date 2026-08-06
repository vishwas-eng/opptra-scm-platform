# Getting the Unicommerce session into the backend, the real options

**Your question:** "Why an extension? Can't the admin just log in from our web app → it goes
to Unicommerce → I do the CAPTCHA → and it comes back to our app with the session token?"

**Short answer:** the *pure* version of that (a redirect/popup + our own page reading the
token) is **impossible in a browser**, but there is a way to do exactly what you're picturing,
all inside our web app with no extension: a **server-side browser you drive from our Admin
page.** Details below.

---

## Why our web page can't just read the token

Two hard browser rules block it, and your own code proves the second one:

1. **Same-origin policy.** JavaScript on `scm.opptra.com` cannot read cookies (or responses)
   from `oppdoor.unicommerce.co.in`. A redirect or popup to UC and "back" cannot hand our page
   the UC cookie, the browser deliberately isolates them.
2. **The JSESSIONID is `httpOnly`.** Your existing `bulk-download-extension` never reads the
   cookie, it calls UC with `fetch(..., { credentials: 'include' })` and lets the browser
   attach the session automatically (`background.js:16,98`). That's the tell: an httpOnly cookie
   **cannot be read by any page JavaScript at all** (not ours, not a bookmarklet). Only two
   things can get its value: a **browser extension** (`chrome.cookies` bypasses httpOnly), or a
   **browser automation runtime** reading its own browser's cookie jar (Playwright/Puppeteer).

So "log in on UC, come back to our app with the token" via plain web tech = **not possible.**
It's not a limitation of our app; it's the browser security model.

---

## The three real options

| Option | Matches your vision? | Install for user | Server cost | Build effort |
|---|---|---|---|---|
| **A. Server-side browser, driven from our Admin page** | ✅ **Yes, exactly** | none | Chromium on the VM (~1–2 GB RAM) | moderate (streaming layer) |
| **B. Session Helper extension** (built) | partly | one-time extension load | none | done |
| **C. Manual paste** (built, fallback) | no | none | none | done |

### Option A, the one you're describing (recommended)

The backend runs a real Chromium (via Playwright) **on our GCP box**. Flow:

1. Admin clicks **"Re-login to Unicommerce"** in our Admin tab.
2. Backend launches a Chromium page at the UC login and **streams the live view into our web
   app** (screencast frames over a WebSocket into a canvas; the admin's clicks/keystrokes are
   forwarded back to that browser).
3. The admin **types the password and solves the CAPTCHA right there inside our web app.**
4. On success, Playwright reads the JSESSIONID **from its own browser context** (works despite
   httpOnly, because Playwright *is* the browser), stores it, and closes the view.
5. Keep-alive keeps it warm. When it eventually dies, the admin repeats, all in our app, no
   extension, ever.

This is a legitimate, standard pattern ("remote browser" / Kasm/browserless style). **No login
automation, no CAPTCHA bypass**, the human does the CAPTCHA; we just host the browser.

**Cost of Option A:** Chromium must run on the VM. Our planned **e2-medium (4 GB)** can do it;
for headroom during a login I'd bump to **e2-standard-2 (2 vCPU / 8 GB, ~₹4,500/mo)**. Build
adds a small streaming subsystem (screencast + input forwarding) to the platform. Everything
stays on **Google Cloud**, no other services.

### Option B, extension (already built, kept as a no-server fallback)

Cheapest (no Chromium on the server). The admin installs the helper once; after logging into UC
they click "Capture session." Good if we ever want to avoid running a browser on the box.

### Option C, manual paste (already built, always works)

The DevTools → paste path. Zero infrastructure, most manual. Stays as the ultimate fallback.

---

## Recommendation

Build **Option A**, it's precisely the flow you described (log in inside our app, do the
CAPTCHA, done), needs nothing installed by the team, and keeps 100% on Google Cloud. Keep B/C
as fallbacks so a session can always be restored even if the server browser has an issue.
The only tradeoff is running Chromium on the VM (a slightly larger instance).

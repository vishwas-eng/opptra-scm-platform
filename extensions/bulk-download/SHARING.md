# Sharing the Bulk SO Download extension with your team

The extension is a folder of files. Three ways to give it to the team, pick by how polished you want it.

## Option A, Zip & load unpacked (free, 2 min, recommended for ~4 people)
You already have **`opptra-bulk-download-extension.zip`** (in the project root).

**Send each person the zip, then they:**
1. **Unzip** it somewhere permanent (e.g. `Documents/opptra-extension`), *don't delete this folder later, the extension runs from it.*
2. Chrome → `chrome://extensions`
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** → select the unzipped **`bulk-download-extension`** folder.
5. Pin it (puzzle icon → pin). Done.

**Updates:** when I change the extension, send the new zip; they replace the folder contents and click **↻ reload** on the extension. (No auto-update with this method.)

## Option B, Chrome Web Store, **Unlisted** (cleanest, auto-updates)
Best if you want one-click install + automatic updates for everyone.
1. One-time: create a **Chrome Web Store developer account** ($5 one-off) at https://chrome.google.com/webstore/devconsole
2. Upload **`opptra-bulk-download-extension.zip`**, set visibility to **Unlisted** (only people with the link can install).
3. After Google's review (usually a day or two), share the store link, team clicks **Add to Chrome**. Updates push automatically when you upload a new version.

## Option C, Google Workspace force-install (if you have admin)
If Opptra uses Google Workspace and you're an admin, you can **force-install** it to everyone via Admin console → Chrome → Apps & extensions (needs the extension hosted, i.e. Option B first). Overkill for 4 people.

## My recommendation
For 4 users: **Option A** (zip + load unpacked), free, instant, no review. Move to **Option B** only if re-sending zips for updates becomes annoying.

## Important notes for users
- They must be **logged into Unicommerce** when they use it.
- PDFs save to **Downloads/opptra-so/** named by SO number.
- It works across **all facilities** automatically (it finds the right one per SO).

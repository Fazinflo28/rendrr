Rendrr for Mac. The app opens the Rendrr editor in its own window, so every Rendrr update shows up without a new download.

**Which file**
- **Rendrr-Mac-AppleSilicon.dmg** for Macs with an Apple chip (M1, M2, M3, M4). Apple menu > About This Mac says "Chip: Apple M…".
- **Rendrr-Mac-Intel.dmg** for older Macs. About This Mac says "Processor: … Intel".

**Install**
1. Open the .dmg and drag **Rendrr** onto **Applications**.
2. Open Rendrr from Applications. The first time, macOS says it cannot check the app (it is not from the App Store yet). Click **Done**.
3. Open **System Settings > Privacy & Security**, scroll down, click **Open Anyway** next to Rendrr, then **Open**. You only do this once.
   (Or in Terminal: `xattr -cr /Applications/Rendrr.app`, then open it.)
4. Click **Log in with your browser**. Your browser opens Rendrr (log in there if you are not already) and asks to allow the app: click **Allow**, then **Open Rendrr** if your browser asks. The app logs in by itself.

Updating from an older Rendrr app: drag the new one into Applications and choose Replace.

**Renders on your Mac**
While the app is open, previews and finals are made on this Mac with its own FFmpeg; graphics, the person's cut-out and
the checks still use Rendrr's cloud. Finals made here go straight to Downloads (and Rendrr keeps a copy to share). If
this Mac cannot take a render, or you close the app, Rendrr's cloud makes it. Turn it off in Rendrr > Settings >
Where renders run. Footage this Mac fetches is kept in ~/Library/Caches/Rendrr (up to 20 GB).

Finals you save go straight to your Downloads folder. Links to other sites open in your browser.

Rendrr for Mac includes FFmpeg (GPL, ffmpeg.org).

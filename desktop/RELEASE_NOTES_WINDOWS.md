Rendrr for Windows. The app opens the Rendrr editor in its own window, so every Rendrr update shows up without a new download.

**Which file**
- **Rendrr-Windows-x64.exe** for most PCs (Intel or AMD). Settings > System > About says "System type: 64-bit operating system, x64-based processor".
- **Rendrr-Windows-Arm.exe** for Windows on Arm (Snapdragon laptops). About says "ARM-based processor".

**Install**
1. Open the downloaded file. Rendrr installs for you (no admin needed), adds itself to the Start menu and the desktop, and opens.
2. The first time, Windows may say **Windows protected your PC** (the app is not signed with a certificate yet). Click **More info**, then **Run anyway**. You only do this once.
3. Click **Log in with your browser**. Your browser opens Rendrr (log in there if you are not already) and asks to allow the app: click **Allow**, then **Open Rendrr** if your browser asks. The app logs in by itself.

Updating: run the new installer; it replaces the old app and keeps your login.

**Renders on your PC**
While the app is open, previews and finals are made on this PC with its own FFmpeg; graphics, the person's cut-out and
the checks still use Rendrr's cloud. Finals made here go straight to Downloads (and Rendrr keeps a copy to share). If
this PC cannot take a render, or you close the app, Rendrr's cloud makes it. Turn it off in Rendrr > Settings > Where
renders run. Footage this PC fetches is kept in %LOCALAPPDATA%\Rendrr\Cache (up to 20 GB). Footage you add in the app
keeps its original on this PC: it is never uploaded, and finals made here read it from where it is. If an export runs
out of memory, this PC makes it again in pieces before Rendrr's cloud takes over. While it makes a render, the app
keeps the PC from going to sleep (the screen can still turn off).

Finals you save go straight to your Downloads folder. Links to other sites open in your browser.

Rendrr for Windows includes FFmpeg (GPL, ffmpeg.org; the build from github.com/BtbN/FFmpeg-Builds).

**Footage on your PC**
While the app is open, footage from Google Drive is downloaded straight to this PC and its preview copy is made here, and transcripts are made here too with a speech model (whisper.cpp). The speech model downloads once, the first time it is needed (about 190 MB); the taskbar shows its progress. If the PC cannot do it, Rendrr's cloud does it as before.

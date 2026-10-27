// A 20 s 9:16 reference video with a known style, for analyze_reference's tests: captions two words at a time at 70%
// down (white, black outline, the second word yellow) changing every 0.6 s; a white "4200 LEADS" card on a pink box
// sliding in from the left at 3 s; "GUARANTEED" popping in at 14 s; a white flash at the 6 s cut and a dip to black at
// 12 s; a voice-like sound with a 60 Hz bed that drops 12 dB under it, and a hit at 6 s. The portrait is NASA's
// public-domain photo (fixtures/astronaut.jpg).
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FONT = join(here, "../../../web/public/fonts/Montserrat-800.ttf");
const WORDS = "stop guessing what works and start measuring every single cut you make so the edit feels fast clean and on purpose every time you post a video online today".split(" ");
/** Where the voice is (speech regions, seconds): 2.5 s on, 1.5 s off. */
export const REFERENCE_SPEECH: [number, number][] = [[0, 2.5], [4, 6.5], [8, 10.5], [12, 14.5], [16, 18.5]];
export const REFERENCE_CUTS = [6, 12, 16];

export function makeReferenceVideo(out: string, ffmpeg = "ffmpeg") {
  const caps: string[] = [];
  for (let t = 0.5, i = 0; t < 19.4; t += 0.6, i += 2) {
    const a = WORDS[i % WORDS.length].toUpperCase(), b = WORDS[(i + 1) % WORDS.length].toUpperCase(), en = `enable='between(t,${t.toFixed(2)},${(t + 0.6).toFixed(2)})'`;
    caps.push(`drawtext=fontfile=${FONT}:text='${a}':fontsize=46:fontcolor=white:borderw=4:bordercolor=black:x=w/2-text_w-8:y=h*0.70:${en}`);
    caps.push(`drawtext=fontfile=${FONT}:text='${b}':fontsize=46:fontcolor=0xFFD400:borderw=4:bordercolor=black:x=w/2+8:y=h*0.70:${en}`);
  }
  const card = `drawbox=x=70:y=200:w=300:h=70:color=0xFF66AA@1:t=fill:enable='between(t,3,5)',drawtext=fontfile=${FONT}:text='4200 LEADS':fontsize=38:fontcolor=white:x='if(lt(t,3.3),-280+(t-3)/0.3*370,90)':y=215:enable='between(t,3,5)'`;
  const pop = `drawtext=fontfile=${FONT}:text='GUARANTEED':fontsize='if(lt(t,14.3),20+(t-14)/0.3*44,64)':fontcolor=white:x=(w-text_w)/2:y=560-text_h/2:enable='between(t,14,16)'`;
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "gradients=s=540x960:c0=0x334455:c1=0x556677:x0=0:y0=0:x1=540:y1=960:d=20:speed=0.02:r=30", "-loop", "1", "-i", join(here, "astronaut.jpg"),
    "-f", "lavfi", "-i", "anoisesrc=d=20:c=pink:a=0.25:r=48000", "-f", "lavfi", "-i", "sine=f=60:d=20:sample_rate=48000", "-f", "lavfi", "-i", "anoisesrc=d=20:c=white:a=0.9:r=48000",
    "-filter_complex", `[1:v]scale=360:-2[face];[0:v][face]overlay=(W-w)/2:120:shortest=1,${caps.join(",")},${card},${pop},` +
      `drawbox=x=0:y=0:w=iw:h=ih:color=white@1:t=fill:enable='between(t,6.0,6.1)',drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='between(t,11.9,12.15)',` +
      `hue=s='if(lt(t,6),1,if(lt(t,12),1.4,0.6))',format=yuv420p[v];` +
      `[2:a]volume='if(lt(mod(t,4),2.5),1,0)':eval=frame,lowpass=f=3000,highpass=f=150[voice];[3:a]volume='if(lt(mod(t,4),2.5),0.5,2)':eval=frame[bed];` +
      `[4:a]volume='if(between(t,6.0,6.08),1,0)':eval=frame[hit];[voice][bed][hit]amix=inputs=3:normalize=0[a]`,
    "-map", "[v]", "-map", "[a]", "-t", "20", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-c:a", "aac", "-b:a", "128k", "-r", "30", out]);
}

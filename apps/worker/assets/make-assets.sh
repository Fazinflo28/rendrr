#!/usr/bin/env bash
# Generates Rendrr's built-in media with FFmpeg only (royalty free by construction):
#   samples/sample-talking-head.mp4  45s 1280x720 with synthetic speech (for testing without your own footage)
#   samples/sample-portrait.mp4      the same speech in 720x1280
#   samples/sample-broll.mp4         12s abstract b-roll, no speech
#   music/<id>.m4a                   8 x 64s music beds tagged by mood
#   sfx/<id>.m4a                     whoosh, pop, hit
# Usage: make-assets.sh <out-dir>
set -euo pipefail
OUT="${1:-./assets-out}"
mkdir -p "$OUT/samples" "$OUT/music" "$OUT/sfx"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FF="ffmpeg -hide_banner -loglevel error -nostdin -y"

# ---------- speech ----------
LINES=(
"So the thing nobody tells you about starting an agency"
"um is that the first ten clients are the hardest"
"like you are basically selling a promise"
"and the promise is that you will make them look good"
"once we figured out cold outreach everything changed"
"we went from two clients to fourteen in ninety days"
"and um the trick was not volume it was the follow up"
"most people stop after one message"
"we send five and every one of them is personal"
"like we actually watch their content before we write"
"that is the whole playbook honestly"
"and now the AI does the first draft for us"
)
GAPS=(0.4 0.35 1.4 0.3 0.6 0.35 0.5 1.4 0.3 0.45 0.6 0.4)
: > "$T/list.txt"
for i in "${!LINES[@]}"; do
  $FF -f lavfi -i "anullsrc=r=48000:cl=mono" -t "${GAPS[$i]}" -c:a pcm_s16le "$T/gap$i.wav"
  if ffmpeg -hide_banner -filters 2>/dev/null | grep -q " flite "; then
    $FF -f lavfi -i "flite=text='${LINES[$i]}':voice=slt" -af "aresample=48000,atempo=1.08,volume=1.6" -ac 1 -c:a pcm_s16le "$T/l$i.wav"
  else
    espeak-ng -s 165 -w "$T/raw$i.wav" "${LINES[$i]}" && $FF -i "$T/raw$i.wav" -af "aresample=48000,volume=1.4" -ac 1 -c:a pcm_s16le "$T/l$i.wav"
  fi
  echo "file '$T/gap$i.wav'" >> "$T/list.txt"; echo "file '$T/l$i.wav'" >> "$T/list.txt"
done
$FF -f lavfi -i "anullsrc=r=48000:cl=mono" -t 1.2 -c:a pcm_s16le "$T/tail.wav"; echo "file '$T/tail.wav'" >> "$T/list.txt"
$FF -f concat -safe 0 -i "$T/list.txt" -c:a pcm_s16le "$T/speech.wav"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$T/speech.wav")

# ---------- picture: a simple presenter silhouette on two backdrops (gives scene cuts) ----------
mkpic() { # $1 out $2 w $3 h $4 bg-r $5 bg-g $6 bg-b
  $FF -f lavfi -i "color=c=black:s=${2}x${3}:d=1" -frames:v 1 -vf "geq=r='clip($4+40*(1-hypot(X-W*0.5,Y-H*0.35)/hypot(W,H))+if(lt(hypot(X-W*0.5,Y-H*0.33),min(W,H)*0.11),150,0)+if(lt(abs(X-W*0.5),W*0.18)*gt(Y,H*0.52),110,0),0,255)':g='clip($5+40*(1-hypot(X-W*0.5,Y-H*0.35)/hypot(W,H))+if(lt(hypot(X-W*0.5,Y-H*0.33),min(W,H)*0.11),130,0)+if(lt(abs(X-W*0.5),W*0.18)*gt(Y,H*0.52),100,0),0,255)':b='clip($6+40*(1-hypot(X-W*0.5,Y-H*0.35)/hypot(W,H))+if(lt(hypot(X-W*0.5,Y-H*0.33),min(W,H)*0.11),120,0)+if(lt(abs(X-W*0.5),W*0.18)*gt(Y,H*0.52),95,0),0,255)'" "$1"
}
mkpic "$T/a.png" 1280 720 30 32 48;  mkpic "$T/b.png" 1280 720 48 30 32
mkpic "$T/pa.png" 720 1280 30 32 48; mkpic "$T/pb.png" 720 1280 48 30 32
mkvideo() { # $1 out $2 picA $3 picB $4 w $5 h
  $FF -loop 1 -framerate 30 -i "$2" -loop 1 -framerate 30 -i "$3" -i "$T/speech.wav" -filter_complex \
    "[0:v][1:v]overlay=enable='between(t,15,28)'[bg];[bg]crop=w=iw-40:h=ih-24:x='20+18*sin(t*1.3)':y='12+6*sin(t*0.7)',scale=$4:$5,setsar=1,format=yuv420p[v]" \
    -map "[v]" -map 2:a -t "$DUR" -c:v libx264 -preset veryfast -crf 23 -r 30 -c:a aac -b:a 128k -ac 2 -movflags +faststart "$1"
}
mkvideo "$OUT/samples/sample-talking-head.mp4" "$T/a.png" "$T/b.png" 1280 720
mkvideo "$OUT/samples/sample-portrait.mp4" "$T/pa.png" "$T/pb.png" 720 1280
$FF -f lavfi -i "gradients=s=1280x720:c0=0x1d3557:c1=0xe63946:c2=0xf1faee:n=3:speed=0.02:d=12" -f lavfi -i "anullsrc=r=48000:cl=stereo" -t 12 \
  -c:v libx264 -preset veryfast -crf 23 -r 30 -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart "$OUT/samples/sample-broll.mp4"

# ---------- music: chords + kick + hats, per mood ----------
mkmusic() { # $1 id $2 bpm $3 f1 $4 f2 $5 f3 $6 f4 $7 kick $8 hat $9 brightness
  local B; B=$(awk "BEGIN{print 60/$2}")
  local CH="if(lt(mod(t,8*$B),2*$B),$3,if(lt(mod(t,8*$B),4*$B),$4,if(lt(mod(t,8*$B),6*$B),$5,$6)))"
  local PAD="0.16*(sin(2*PI*($CH)*t)+0.6*sin(2*PI*($CH)*1.25*t)+0.5*sin(2*PI*($CH)*1.5*t)+$9*0.3*sin(2*PI*($CH)*2*t))*(0.75+0.25*sin(2*PI*t/($B*4)))"
  local KICK="$7*0.9*sin(2*PI*(45+120*exp(-25*mod(t,$B)))*mod(t,$B))*exp(-9*mod(t,$B))"
  local HAT="$8*0.12*(random(0)*2-1)*exp(-70*mod(t+$B/2,$B))"
  $FF -f lavfi -i "aevalsrc=exprs='$PAD+$KICK+$HAT|$PAD+$KICK+$HAT':s=44100:d=64" -af "afade=t=in:d=1,afade=t=out:st=61:d=3,alimiter=limit=0.9,volume=0.9" -c:a aac -b:a 128k "$OUT/music/$1.m4a"
}
mkmusic m_lofi 80 220 174.6 196 164.8 0.6 0.5 0.2
mkmusic m_upbeat 118 261.6 196 220 174.6 0.9 0.8 0.8
mkmusic m_cinematic 70 110 87.3 130.8 98 0.2 0 0.4
mkmusic m_ambient 60 130.8 146.8 110 123.5 0 0 0.1
mkmusic m_trending 128 220 220 174.6 196 1 1 1
mkmusic m_news 100 146.8 164.8 196 174.6 0.4 0.6 0.6
mkmusic m_suspense 90 98 103.8 98 92.5 0.5 0.2 0.1
mkmusic m_gameshow 136 293.7 349.2 392 329.6 0.9 0.9 1

# ---------- sound effects ----------
$FF -f lavfi -i "aevalsrc=exprs='0.6*(random(0)*2-1)*sin(PI*t/0.8)*sin(PI*t/0.8)':s=44100:d=0.8" -af "highpass=f=600,lowpass=f=6000" -c:a aac -b:a 128k "$OUT/sfx/sfx_whoosh.m4a"
$FF -f lavfi -i "aevalsrc=exprs='0.8*sin(2*PI*(900-1800*t)*t)*exp(-25*t)':s=44100:d=0.3" -c:a aac -b:a 128k "$OUT/sfx/sfx_pop.m4a"
$FF -f lavfi -i "aevalsrc=exprs='0.9*sin(2*PI*(60+200*exp(-30*t))*t)*exp(-6*t)+0.3*(random(0)*2-1)*exp(-20*t)':s=44100:d=0.6" -c:a aac -b:a 128k "$OUT/sfx/sfx_hit.m4a"
echo "assets ready in $OUT"

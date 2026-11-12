#!/usr/bin/env bash
# Generates the video test fixtures in test/fixtures/video from FFmpeg's
# synthetic sources: a test pattern with a running frame counter, and a sine
# tone. Never a recording (CONTRIBUTING.md, "Test videos"). The output is
# committed; rerun this only to change the fixtures, with FFmpeg 6 or later
# built with libx264, libx265, libvpx, libaom and libopus. Every encoder runs
# single-threaded with deterministic settings, so the output is identical on
# every run.
set -euo pipefail

out="$(dirname "$0")/../test/fixtures/video"
mkdir -p "$out"
cd "$out"

exact=(-fflags +bitexact -flags:v +bitexact -flags:a +bitexact -map_metadata -1 -map_chapters -1)
pattern() { echo "testsrc2=size=$1:rate=30:duration=$2"; }
tone() { echo "sine=frequency=440:sample_rate=48000:duration=$1"; }
h264=(-c:v libx264 -preset fast -crf 45 -pix_fmt yuv420p -threads 1 -g 30)
aac=(-c:a aac -b:a 32k -ac 2)
opus=(-c:a libopus -b:a 24k -ac 2)

# 1280 × 720 at 30 fps, 2 seconds, 48 kHz stereo, in each container.
ffmpeg -y -v error -f lavfi -i "$(pattern 1280x720 2)" -f lavfi -i "$(tone 2)" \
  "${h264[@]}" "${aac[@]}" "${exact[@]}" -shortest landscape.mp4
ffmpeg -y -v error -f lavfi -i "$(pattern 1280x720 2)" -f lavfi -i "$(tone 2)" \
  -c:v libvpx-vp9 -deadline good -cpu-used 5 -crf 60 -b:v 0 -threads 1 -row-mt 0 -g 30 \
  "${opus[@]}" "${exact[@]}" -shortest landscape.webm
ffmpeg -y -v error -i landscape.mp4 -c copy "${exact[@]}" landscape.mkv
ffmpeg -y -v error -i landscape.mp4 -c copy -movflags frag_keyframe+empty_moov+default_base_moof \
  "${exact[@]}" fragmented.mp4
ffmpeg -y -v error -f lavfi -i "$(pattern 1280x720 2)" "${h264[@]}" "${exact[@]}" silent.mp4
# Stored 1280 × 720 and turned a quarter clockwise by the container.
ffmpeg -y -v error -display_rotation:v:0 -90 -i landscape.mp4 -c copy "${exact[@]}" -f mov rotated.mov

# VP8 and Opus, which every browser engine decodes, including Playwright's
# WebKit on Linux with few GStreamer plugins (docs/capabilities.md).
ffmpeg -y -v error -f lavfi -i "$(pattern 1280x720 2)" -f lavfi -i "$(tone 2)" \
  -c:v libvpx -deadline good -cpu-used 5 -crf 60 -b:v 500k -threads 1 -g 30 \
  "${opus[@]}" "${exact[@]}" -shortest landscape-vp8.webm
# The same picture without audio, in VP8, for the engine contract.
ffmpeg -y -v error -f lavfi -i "$(pattern 1280x720 2)" \
  -c:v libvpx -deadline good -cpu-used 5 -crf 60 -b:v 500k -threads 1 -g 30 \
  "${exact[@]}" silent-vp8.webm
# Frame-numbered VP8 for playback: 256 × 32 at 30 fps, 4 seconds, no audio.
# Eight 32-pixel blocks show each frame's number in binary, most significant
# bit first, white for 1, so a test can read back which frame was drawn.
numbered="geq=lum='if(mod(trunc(N/pow(2\\,7-trunc(X/32)))\\,2)\\,235\\,16)':cb=128:cr=128"
ffmpeg -y -v error -f lavfi -i "color=black:size=256x32:rate=30:duration=4,format=yuv420p,$numbered" \
  -c:v libvpx -deadline good -cpu-used 5 -crf 10 -b:v 200k -threads 1 -g 30 \
  "${exact[@]}" numbered-vp8.webm
# The same numbered picture with Opus beeps, for the sync test: 50 ms of
# 1 kHz at 0.5, 1.5, 2.5 and 3.5 s, which are frames 15, 45, 75 and 105,
# and silence otherwise.
beeps="aevalsrc='if(gte(t\\,0.5)*lt(mod(t-0.5\\,1)\\,0.05)\\,0.5*sin(2*PI*1000*t)\\,0)|if(gte(t\\,0.5)*lt(mod(t-0.5\\,1)\\,0.05)\\,0.5*sin(2*PI*1000*t)\\,0)':s=48000:d=4"
ffmpeg -y -v error -f lavfi -i "color=black:size=256x32:rate=30:duration=4,format=yuv420p,$numbered" \
  -f lavfi -i "$beeps" \
  -c:v libvpx -deadline good -cpu-used 5 -crf 10 -b:v 200k -threads 1 -g 30 \
  "${opus[@]}" "${exact[@]}" -shortest numbered-beeps.webm
# HEVC, which Chromium and Firefox don't decode: for UNSUPPORTED_CODEC.
ffmpeg -y -v error -f lavfi -i "$(pattern 320x180 0.5)" -f lavfi -i "$(tone 0.5)" \
  -c:v libx265 -preset ultrafast -crf 45 -pix_fmt yuv420p -tag:v hvc1 \
  -x265-params log-level=error:pools=none:frame-threads=1 \
  "${aac[@]}" "${exact[@]}" -shortest hevc.mp4

# AV1 and Opus, so that every video codec in the capability matrix has a
# file to decode (docs/capabilities.md).
ffmpeg -y -v error -f lavfi -i "$(pattern 320x180 0.5)" -f lavfi -i "$(tone 0.5)" \
  -c:v libaom-av1 -cpu-used 8 -crf 50 -threads 1 -row-mt 0 -g 30 \
  "${opus[@]}" "${exact[@]}" -shortest av1.mp4

# Tiny files, 64 × 36 and 6 frames, for truncation at every byte offset.
ffmpeg -y -v error -f lavfi -i "$(pattern 64x36 0.2)" -f lavfi -i "$(tone 0.2)" \
  "${h264[@]}" "${aac[@]}" "${exact[@]}" -shortest tiny.mp4
ffmpeg -y -v error -f lavfi -i "$(pattern 64x36 0.2)" -f lavfi -i "$(tone 0.2)" \
  -c:v libvpx-vp9 -deadline good -cpu-used 5 -crf 60 -b:v 0 -threads 1 -row-mt 0 \
  "${opus[@]}" "${exact[@]}" -shortest tiny.webm

# Tiny VP8 and Opus whose timestamps start at 1 s, for sources whose time
# doesn't begin at 0.
ffmpeg -y -v error -f lavfi -i "$(pattern 64x36 0.2)" -f lavfi -i "$(tone 0.2)" \
  -c:v libvpx -deadline good -cpu-used 5 -crf 60 -b:v 100k -threads 1 \
  "${opus[@]}" "${exact[@]}" -shortest -output_ts_offset 1 offset.webm

ls -l

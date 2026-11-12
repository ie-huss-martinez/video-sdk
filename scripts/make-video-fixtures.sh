#!/usr/bin/env bash
# Generates the video test fixtures in test/fixtures/video from FFmpeg's
# synthetic sources: a test pattern with a running frame counter, and a sine
# tone. Never a recording (CONTRIBUTING.md, "Test videos"). The output is
# committed; rerun this only to change the fixtures, with FFmpeg 6 or later
# built with libx264, libvpx and libopus.
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
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -crf 60 -b:v 0 -threads 1 -g 30 \
  "${opus[@]}" "${exact[@]}" -shortest landscape.webm
ffmpeg -y -v error -i landscape.mp4 -c copy "${exact[@]}" landscape.mkv
ffmpeg -y -v error -i landscape.mp4 -c copy -movflags frag_keyframe+empty_moov+default_base_moof \
  "${exact[@]}" fragmented.mp4
ffmpeg -y -v error -f lavfi -i "$(pattern 1280x720 2)" "${h264[@]}" "${exact[@]}" silent.mp4
# Stored 1280 × 720 and turned a quarter clockwise by the container.
ffmpeg -y -v error -display_rotation:v:0 -90 -i landscape.mp4 -c copy "${exact[@]}" -f mov rotated.mov

# Tiny files, 64 × 36 and 6 frames, for truncation at every byte offset.
ffmpeg -y -v error -f lavfi -i "$(pattern 64x36 0.2)" -f lavfi -i "$(tone 0.2)" \
  "${h264[@]}" "${aac[@]}" "${exact[@]}" -shortest tiny.mp4
ffmpeg -y -v error -f lavfi -i "$(pattern 64x36 0.2)" -f lavfi -i "$(tone 0.2)" \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -crf 60 -b:v 0 -threads 1 \
  "${opus[@]}" "${exact[@]}" -shortest tiny.webm

ls -l

#!/usr/bin/env bash
# Revised download script - verbose, no ignore-errors

# Define ABSOLUTE paths explicitly
script_dir="$(cd "$(dirname "$0")" && pwd)"
output_dir="$script_dir/transcripts" # Absolute path
archive_file="$script_dir/archive.txt" # Absolute path

echo ">> Running script from: $script_dir"
echo ">> Attempting to write transcripts to: $output_dir"
echo ">> Using archive file: $archive_file"

# Ensure output directory exists
mkdir -p "$output_dir"
touch "$archive_file" # Ensure archive file exists

# Keep Mac awake
caffeinate -dims &
caffeinate_pid=$!
echo ">> Caffeinate running (PID: $caffeinate_pid)."

# Run yt-dlp - REMOVED --ignore-errors, ADDED -v (verbose)
echo ">> Starting yt-dlp (verbose mode, errors will halt)..."
yt-dlp \
  --write-auto-sub \
  --sub-lang en \
  --skip-download \
  --output "$output_dir/TheMoneyGPS_%(upload_date)s_%(title).80s.%(ext)s" \
  --no-post-overwrites \
  --no-write-info-json \
  --no-call-home \
  --no-check-certificate \
  --no-mtime \
  --download-archive "$archive_file" \
  --min-sleep-interval 5 \
  --max-sleep-interval 10 \
  --sleep-requests 2 \
  --throttled-rate 300K \
  --retries 15 \
  --force-ipv4 \
  -v \
  "https://www.youtube.com/playlist?list=UUngq92xrmmsfEgGdfAJ6giQ" # Uploads Playlist URL

# Check exit code of yt-dlp
yt_dlp_exit_code=$?
echo ">> yt-dlp finished with exit code: $yt_dlp_exit_code"

# Stop caffeinate
echo ">> Killing caffeinate (PID: $caffeinate_pid)..."
kill "$caffeinate_pid"

echo ">> Script finished."
exit $yt_dlp_exit_code # Exit script with yt-dlp's exit code
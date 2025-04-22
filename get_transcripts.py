import os
import requests
import xml.etree.ElementTree as ET
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import TranscriptsDisabled

# Set channel ID
channel_id = "UCngq92xrmmsfEgGdfAJ6giQ"

# Create folder
os.makedirs("transcripts", exist_ok=True)

# YouTube RSS feed (lists latest videos)
rss_url = f"https://www.youtube.com/feeds/videos.xml?channel_id=UCngq92xrmmsfEgGdfAJ6giQ"

# Fetch RSS feed
response = requests.get(rss_url)
root = ET.fromstring(response.content)

# Parse all video IDs
video_ids = [entry.find('{http://www.youtube.com/xml/schemas/2015}videoId').text for entry in root.findall('{http://www.w3.org/2005/Atom}entry')]

print(f"Found {len(video_ids)} videos.")

saved_count = 0

for vid in video_ids:
    try:
        transcript = YouTubeTranscriptApi.get_transcript(vid, languages=["en"])
        transcript_text = "\n".join([item["text"] for item in transcript])
        with open(f"transcripts/{vid}.txt", "w", encoding="utf-8") as f:
            f.write(transcript_text)
        print(f"[✓] Saved transcript for: {vid}")
        saved_count += 1
    except TranscriptsDisabled:
        print(f"[x] No transcript for: {vid}")
    except Exception as e:
        print(f"[!] Error with {vid}: {e}")

print(f"\n🎉 Done! Transcripts saved for {saved_count} videos.")

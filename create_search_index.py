# Filename: create_search_index.py
import os
import json
import sys
import re

def extract_info_from_filename(filename):
    """Extracts date and title from the standard filename format."""
    # Format: TheMoneyGPS_YYYYMMDD_Actual Title Here.txt
    match = re.match(r"TheMoneyGPS_(\d{8})_(.*)\.txt", filename)
    if match:
        date_str = match.group(1)
        title = match.group(2).replace('_', ' ') # Replace underscores used in filename
        # Format date nicely (optional)
        try:
            formatted_date = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:]}"
        except IndexError:
            formatted_date = date_str # Fallback if date isn't 8 digits
        return formatted_date, title
    return "Unknown Date", os.path.splitext(filename)[0] # Fallback

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    input_dir = os.path.join(script_dir, "clean_txt")
    output_json_file = os.path.join(script_dir, "search_data.json")

    print(">> Creating search index...")
    print(f">> Reading from: {input_dir}")

    if not os.path.isdir(input_dir):
        print(f"[ERROR] Clean text directory not found: {input_dir}")
        print(">> Please run 'convert_vtt_to_txt.py' first.")
        sys.exit(1)

    search_data = []
    file_count = 0

    for filename in os.listdir(input_dir):
        if filename.lower().endswith(".txt"):
            file_path = os.path.join(input_dir, filename)
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    text_content = f.read()

                if text_content: # Only add if there's content
                     file_date, file_title = extract_info_from_filename(filename)
                     search_data.append({
                         "filename": filename,
                         "date": file_date,
                         "title": file_title,
                         "text": text_content
                     })
                     file_count += 1
            except Exception as e:
                print(f"   [!] Error reading file {filename}: {e}")

    # Write the data to a JSON file
    try:
        with open(output_json_file, "w", encoding="utf-8") as f:
            json.dump(search_data, f, indent=2) # indent for readability (optional)
        print(f">> Successfully created search index: {output_json_file}")
        print(f">> Indexed {file_count} transcript files.")
    except Exception as e:
        print(f"[ERROR] Failed to write JSON index file: {e}")

if __name__ == "__main__":
    main()
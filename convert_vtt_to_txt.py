# Filename: convert_vtt_to_txt.py
import os
import re
import sys

def clean_vtt_to_txt(input_vtt_path):
    """Reads a VTT file, cleans it, de-duplicates consecutive identical segments, and returns the text content."""
    lines = []
    try:
        with open(input_vtt_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception as e:
        print(f"   [!] Error reading file {os.path.basename(input_vtt_path)}: {e}")
        return None # Indicate failure

    cleaned_segments = []
    in_style_block = False # Flag to skip STYLE blocks
    last_added_segment = None # Keep track of the last segment added

    for line in lines:
        line = line.strip()

        # Skip known header/metadata/empty lines
        if not line or line == "WEBVTT" or line.lower().startswith("kind:") or line.lower().startswith("language:"):
            continue
        # Skip NOTE comments
        if line.startswith("NOTE"):
            continue
        # Skip STYLE blocks
        if line.startswith("STYLE"):
            in_style_block = True
            continue
        if in_style_block and line == "": # End of STYLE block
             in_style_block = False
             continue
        if in_style_block: # Skip lines within STYLE block
            continue
        # Skip timestamp lines (e.g., 00:00:00.000 --> 00:00:05.000 align:start position:0%)
        if re.match(r"^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}", line):
            continue
        # Skip sequence number lines (lines containing only digits)
        if re.match(r"^\d+$", line):
            continue

        # If we reach here, it's likely a subtitle text line
        # Remove inline tags (like <c>, </c>, <v Name>, etc.)
        current_segment = re.sub(r"<[^>]+>", "", line).strip()

        # Only add the segment if it's not empty AND different from the last one added
        if current_segment and current_segment != last_added_segment:
             cleaned_segments.append(current_segment)
             last_added_segment = current_segment # Update the last added segment


    # Join all unique, consecutive segments with a single space and consolidate whitespace
    full_text = " ".join(cleaned_segments)
    full_text = re.sub(r"\s+", " ", full_text).strip()

    return full_text

def get_base_filename_without_known_extensions(filename):
    """
    Removes known extensions (.vtt) and common language codes (.en, .es, etc.)
    from the end of a filename, preserving dots in the main title.
    """
    base_name = filename
    known_extensions = ['.vtt']
    # Add more language codes here if needed
    known_lang_codes = ['.en', '.es', '.fr', '.de', '.it', '.pt', '.ru', '.ja', '.ko', '.zh']

    # Remove known extensions first
    for ext in known_extensions:
        if base_name.lower().endswith(ext):
            base_name = base_name[:-len(ext)]
            break # Only remove one extension typically

    # Then remove known language codes if they appear at the end
    for lang_code in known_lang_codes:
         if base_name.lower().endswith(lang_code):
             base_name = base_name[:-len(lang_code)]
             break # Only remove one language code typically

    return base_name


def main():
    # Get the absolute directory where this script lives
    script_dir = os.path.dirname(os.path.abspath(__file__))
    input_dir = os.path.join(script_dir, "transcripts") # Assumes 'transcripts' is in the same dir
    output_dir = os.path.join(script_dir, "clean_txt") # Assumes 'clean_txt' will be in the same dir

    print(f">> VTT Converter Script Started")
    print(f">> Input VTT folder: {input_dir}")
    print(f">> Output TXT folder: {output_dir}")

    if not os.path.isdir(input_dir):
        print(f"[ERROR] Input directory not found: {input_dir}")
        sys.exit(1)

    os.makedirs(output_dir, exist_ok=True)

    total_files = 0
    converted_files = 0
    skipped_files = 0

    # Iterate through files in the input directory
    for filename in os.listdir(input_dir):
        # Process only .vtt files
        if filename.lower().endswith(".vtt"):
            total_files += 1
            input_vtt_path = os.path.join(input_dir, filename)

            # Clean the VTT content
            cleaned_text = clean_vtt_to_txt(input_vtt_path)

            if cleaned_text is not None:
                # *** USE CORRECTED LOGIC FOR GETTING BASE FILENAME ***
                base_name = get_base_filename_without_known_extensions(filename)
                output_filename = f"{base_name}.txt"
                output_txt_path = os.path.join(output_dir, output_filename)

                # Write the cleaned text to the output file
                try:
                    with open(output_txt_path, "w", encoding="utf-8") as f:
                        f.write(cleaned_text)
                    converted_files += 1
                except Exception as e:
                    print(f"   [!] Error writing file {output_filename}: {e}")
                    skipped_files += 1
            else:
                # File reading failed or produced no text
                skipped_files += 1
                print(f"   [!] Skipped processing for {filename} due to read error or empty content.")


    print(f"\n>> Script Finished.")
    print(f"------------------------------------")
    print(f">> Total VTT files found: {total_files}")
    print(f">> Successfully converted: {converted_files}")
    print(f">> Skipped/Failed:       {skipped_files}")
    print(f"------------------------------------")
    print(f">> Clean TXT files saved in: {output_dir}")

# Make sure this runs only when the script is executed directly
if __name__ == "__main__":
    main()
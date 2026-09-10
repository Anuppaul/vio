TANPURA AUDIO

Run from the project folder (or from anywhere):
    python3 download_tanpura_mp3.py

The script scans the current Spardha Tanpura page and its JavaScript bundles, downloads literal audio assets into this folder, and generates tanpura_manifest.js.

tanpura.html automatically reads tanpura_manifest.js. If an exact local mapping is unavailable, the page uses a browser-generated fallback drone so the tool still works.

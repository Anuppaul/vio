#!/usr/bin/env python3
# Get-Tuned violin MP3 downloader for Ubuntu.
# No third-party packages required.

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import re
import ssl
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urljoin, urlparse
from urllib.request import Request, urlopen

PAGE_URL = "https://www.get-tuned.com/online_violin_tuner.php"
SOUND_BASE = "https://www.get-tuned.com/sounds/violin/"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/140.0 Safari/537.36"
)

PITCH_CLASSES = [
    ("C", None), ("C", "sharp"),
    ("D", None), ("D", "sharp"),
    ("E", None),
    ("F", None), ("F", "sharp"),
    ("G", None), ("G", "sharp"),
    ("A", None), ("A", "sharp"),
    ("B", None),
]

ENHARMONIC_FLAT = {"C": "D", "D": "E", "F": "G", "G": "A", "A": "B"}


def parse_args():
    p = argparse.ArgumentParser(
        description="Download Get-Tuned violin tuner MP3 files locally."
    )
    p.add_argument("--output", default="assets/violin")
    p.add_argument("--page-url", default=PAGE_URL)
    p.add_argument("--sound-base", default=SOUND_BASE)
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--timeout", type=int, default=20)
    p.add_argument("--retries", type=int, default=2)
    p.add_argument("--force", action="store_true")
    p.add_argument("--keep-debug", action="store_true")
    return p.parse_args()


def http_get(url, timeout, retries):
    ctx = ssl.create_default_context()
    last = None
    for attempt in range(retries + 1):
        try:
            req = Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "*/*",
                    "Referer": PAGE_URL,
                },
            )
            with urlopen(req, timeout=timeout, context=ctx) as resp:
                return resp.read(), resp.headers.get("Content-Type", ""), resp.geturl()
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last = exc
            if attempt < retries:
                time.sleep(0.6 * (attempt + 1))
    raise last


def looks_like_mp3(data, content_type):
    ct = (content_type or "").lower()
    if any(x in ct for x in ("audio/mpeg", "audio/mp3", "audio/x-mpeg")):
        return len(data) > 128
    if data.startswith(b"ID3"):
        return len(data) > 128
    return len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def safe_name_from_url(url):
    name = unquote(Path(urlparse(url).path).name)
    name = re.sub(r"[^A-Za-z0-9_.#-]+", "_", name)
    return name or "unknown.mp3"


def quoted_child_url(base, filename):
    # '#' must be encoded or browsers treat it as a fragment.
    return urljoin(base.rstrip("/") + "/", quote(filename, safe="._-"))


def canonical_name(letter, accidental, octave):
    return f"{letter}{'s' if accidental else ''}{octave}.mp3"


def filename_variants(letter, accidental, octave):
    if accidental is None:
        return [
            f"{letter}{octave}.mp3",
            f"{letter.lower()}{octave}.mp3",
            f"violin_{letter}{octave}.mp3",
            f"violin-{letter}{octave}.mp3",
        ]

    flat = ENHARMONIC_FLAT[letter]
    return [
        f"{letter}s{octave}.mp3",
        f"{letter}S{octave}.mp3",
        f"{letter}#{octave}.mp3",
        f"{letter}sharp{octave}.mp3",
        f"{letter}Sharp{octave}.mp3",
        f"{letter}-sharp{octave}.mp3",
        f"{letter}_sharp{octave}.mp3",
        f"{letter.lower()}s{octave}.mp3",
        f"{flat}b{octave}.mp3",
        f"{flat}B{octave}.mp3",
        f"{flat}flat{octave}.mp3",
        f"{flat}Flat{octave}.mp3",
        f"{flat}-flat{octave}.mp3",
        f"{flat}_flat{octave}.mp3",
        f"{flat.lower()}b{octave}.mp3",
    ]


def discover_literal_mp3_urls(page_url, timeout, retries, debug_dir):
    print(f"[1/4] Reading tuner page:\n      {page_url}")
    page_bytes, _, final_page = http_get(page_url, timeout, retries)
    page_text = page_bytes.decode("utf-8", "ignore")

    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        (debug_dir / "page.html").write_bytes(page_bytes)

    script_refs = re.findall(
        r"<script[^>]+src\s*=\s*[\"']([^\"']+)[\"']",
        page_text,
        flags=re.I,
    )

    corpora = [(final_page, page_text)]

    for i, ref in enumerate(script_refs, 1):
        js_url = urljoin(final_page, html.unescape(ref))
        try:
            data, ct, final_url = http_get(js_url, timeout, retries)
        except Exception:
            continue

        if "javascript" not in ct.lower() and not urlparse(final_url).path.lower().endswith(".js"):
            continue

        text = data.decode("utf-8", "ignore")
        corpora.append((final_url, text))

        if debug_dir:
            filename = re.sub(
                r"[^A-Za-z0-9_.-]+",
                "_",
                urlparse(final_url).path.strip("/"),
            ) or f"script_{i}.js"
            (debug_dir / filename).write_bytes(data)

    found = []
    seen = set()

    # Deliberately broad: catches absolute and relative literal *.mp3 references.
    mp3_re = re.compile(
        r"((?:https?:)?//[^\s\"'<>\\]+?\.mp3(?:\?[^\s\"'<>\\]*)?|"
        r"[A-Za-z0-9_./%#?&=+\-]+\.mp3(?:\?[^\s\"'<>\\]*)?)",
        flags=re.I,
    )

    for source_url, text in corpora:
        for match in mp3_re.findall(text):
            ref = html.unescape(match)
            if ref.startswith("//"):
                ref = "https:" + ref
            url = urljoin(source_url, ref)
            if url not in seen:
                seen.add(url)
                found.append(url)

    print(f"      JavaScript files inspected: {len(corpora)-1}")
    print(f"      Literal MP3 URLs found: {len(found)}")
    return found


def download_literal(url, output, timeout, retries, force):
    try:
        data, ct, final_url = http_get(url, timeout, retries)
    except Exception:
        return None

    if not looks_like_mp3(data, ct):
        return None

    filename = safe_name_from_url(final_url)
    if not filename.lower().endswith(".mp3"):
        filename += ".mp3"

    target = output / filename
    if force or not target.exists():
        target.write_bytes(data)

    return {
        "local_file": filename,
        "canonical_note": "",
        "source_url": url,
        "final_url": final_url,
        "remote_filename": safe_name_from_url(final_url),
        "content_type": ct,
        "size_bytes": len(data),
        "sha256": sha256_bytes(data),
        "method": "literal-reference",
    }


def probe_note(letter, accidental, octave, sound_base, output, timeout, retries, force):
    canon = canonical_name(letter, accidental, octave)
    target = output / canon

    if target.exists() and not force:
        data = target.read_bytes()
        return {
            "local_file": canon,
            "canonical_note": canon[:-4],
            "source_url": "",
            "final_url": "",
            "remote_filename": "",
            "content_type": "existing/local",
            "size_bytes": len(data),
            "sha256": sha256_bytes(data),
            "method": "existing",
        }, []

    errors = []
    for filename in filename_variants(letter, accidental, octave):
        url = quoted_child_url(sound_base, filename)
        try:
            data, ct, final_url = http_get(url, timeout, retries)
        except HTTPError as exc:
            errors.append(f"{filename}: HTTP {exc.code}")
            continue
        except Exception as exc:
            errors.append(f"{filename}: {type(exc).__name__}")
            continue

        if not looks_like_mp3(data, ct):
            errors.append(f"{filename}: not MP3 ({ct or 'unknown'}, {len(data)} bytes)")
            continue

        # Save ORIGINAL remote bytes. No conversion, resampling or re-encoding.
        target.write_bytes(data)

        return {
            "local_file": canon,
            "canonical_note": canon[:-4],
            "source_url": url,
            "final_url": final_url,
            "remote_filename": safe_name_from_url(final_url),
            "content_type": ct,
            "size_bytes": len(data),
            "sha256": sha256_bytes(data),
            "method": "note-probe",
        }, errors

    return None, errors


def write_manifests(output, records, missing, page_url, sound_base):
    records = sorted(records, key=lambda r: r["local_file"].lower())

    manifest = {
        "source_page": page_url,
        "sound_base": sound_base,
        "downloaded_count": len(records),
        "missing_count": len(missing),
        "files": records,
        "missing": missing,
    }

    (output / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    fields = [
        "local_file", "canonical_note", "source_url", "final_url",
        "remote_filename", "content_type", "size_bytes", "sha256", "method",
    ]
    with (output / "manifest.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)


def main():
    args = parse_args()
    output = Path(args.output).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    debug_dir = output / "_debug" if args.keep_debug else None

    print("=" * 70)
    print("Get-Tuned Violin MP3 Downloader")
    print("=" * 70)
    print(f"Output: {output}")
    print("Original HTTP bytes only; no audio transcoding.")
    print()

    try:
        literal_urls = discover_literal_mp3_urls(
            args.page_url, args.timeout, args.retries, debug_dir
        )
    except Exception as exc:
        print(f"WARNING: page/JS inspection failed: {exc}", file=sys.stderr)
        print("Continuing with direct note probing.", file=sys.stderr)
        literal_urls = []

    records = []

    print("\n[2/4] Downloading literal MP3 references...")
    for url in literal_urls:
        rec = download_literal(url, output, args.timeout, args.retries, args.force)
        if rec:
            records = [r for r in records if r["local_file"] != rec["local_file"]]
            records.append(rec)
            print(f"      OK  {rec['local_file']} ({rec['size_bytes']:,} bytes)")

    print("\n[3/4] Probing chromatic C3..B5 range...")
    jobs = [
        (letter, accidental, octave)
        for octave in (3, 4, 5)
        for letter, accidental in PITCH_CLASSES
    ]

    missing = []
    workers = max(1, min(args.workers, 16))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {
            pool.submit(
                probe_note,
                letter, accidental, octave,
                args.sound_base, output,
                args.timeout, args.retries, args.force,
            ): (letter, accidental, octave)
            for letter, accidental, octave in jobs
        }

        for future in as_completed(future_map):
            letter, accidental, octave = future_map[future]
            note = f"{letter}{'#' if accidental else ''}{octave}"

            try:
                rec, errors = future.result()
            except Exception as exc:
                rec, errors = None, [repr(exc)]

            if rec:
                records = [r for r in records if r["local_file"] != rec["local_file"]]
                records.append(rec)
                print(
                    f"      OK  {note:<4} -> {rec['local_file']:<8} "
                    f"({rec['size_bytes']:,} bytes)"
                )
            else:
                missing.append({
                    "note": note,
                    "canonical_file": canonical_name(letter, accidental, octave),
                    "attempts": errors,
                })
                print(f"      --  {note:<4} not found")

    print("\n[4/4] Writing manifests...")
    write_manifests(output, records, missing, args.page_url, args.sound_base)

    if missing:
        lines = []
        for item in sorted(missing, key=lambda x: x["note"]):
            lines.append(f"{item['note']} -> {item['canonical_file']}")
            for err in item["attempts"]:
                lines.append(f"    {err}")
        (output / "missing.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    else:
        try:
            (output / "missing.txt").unlink()
        except FileNotFoundError:
            pass

    mp3_count = len(list(output.glob("*.mp3")))

    print("\n" + "=" * 70)
    print(f"Finished: {output}")
    print(f"MP3 files present: {mp3_count}")
    print(f"Missing chromatic notes: {len(missing)}")
    print(f"Manifest: {output / 'manifest.json'}")
    if missing:
        print(f"Missing report: {output / 'missing.txt'}")
    print("=" * 70)

    if mp3_count == 0:
        print("ERROR: No MP3 files were downloaded.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""
Spardha Tanpura downloader / recorder v3
========================================

Goal
----
Capture ALL 24 Tanpura combinations:
    12 keys (C ... B) x 2 patterns (SA-PA / SA-MA)

Why v4?
-------
The Spardha Tanpura does not expose literal .mp3 URLs in its HTML/JS.
This script therefore uses a real Chromium browser and:

1. watches ALL runtime network responses for audio files;
2. clicks the real Tanpura controls;
3. captures the ACTUAL browser audio output for every key/pattern;
4. converts each captured output to MP3 with ffmpeg;
5. creates assets/tanpura/tanpura_manifest.js for the standalone tuner.

If the website fetches original audio files, those raw response bytes are
also preserved under assets/tanpura/original_network_audio/.

If the website synthesizes its Tanpura with Web Audio, there is no original
MP3 to "download". In that case this script records the site's real rendered
audio and writes the 24 MP3 files.

Ubuntu:
    python3 download_tanpura_all.py

Useful options:
    python3 download_tanpura_all.py --seconds 8
    python3 download_tanpura_all.py --headed
    python3 download_tanpura_all.py --output assets/tanpura
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
import venv
from pathlib import Path
from urllib.parse import urlparse


PRIMARY_URL = "https://www.spardhaschoolofmusic.com/tools/tanpura"
FALLBACK_URL = "https://music-tools.spardhaschoolofmusic.com/tanpura"

KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
PATTERNS = [
    ("sa-pa", re.compile(r"SA\s*PA", re.I)),
    ("sa-ma", re.compile(r"SA\s*MA", re.I)),
]

AUDIO_EXTS = {".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".webm", ".flac"}

INIT_CAPTURE_SCRIPT = r"""
(() => {
  if (window.__SPARDHA_CAPTURE_INSTALLED__) return;
  window.__SPARDHA_CAPTURE_INSTALLED__ = true;

  const contexts = [];
  const mediaStreams = [];
  const contextCaps = new WeakMap();
  const mediaSeen = new WeakSet();

  function ensureContextCapture(ctx) {
    if (!ctx || contextCaps.has(ctx)) return contextCaps.get(ctx);
    try {
      const d = ctx.createMediaStreamDestination();
      contextCaps.set(ctx, d);
      contexts.push({ctx, dest: d});
      return d;
    } catch (_) {
      return null;
    }
  }

  // Duplicate any WebAudio node that connects to speakers into our capture stream.
  try {
    const proto = window.AudioNode && window.AudioNode.prototype;
    if (proto && proto.connect && !proto.connect.__spardhaPatched) {
      const originalConnect = proto.connect;
      function patchedConnect(destination, ...rest) {
        const result = originalConnect.call(this, destination, ...rest);
        try {
          const isOutput =
            destination &&
            (
              (window.AudioDestinationNode && destination instanceof window.AudioDestinationNode) ||
              destination.constructor?.name === "AudioDestinationNode"
            );
          if (isOutput && this.context) {
            const cap = ensureContextCapture(this.context);
            if (cap && destination !== cap) {
              try { originalConnect.call(this, cap); } catch (_) {}
            }
          }
        } catch (_) {}
        return result;
      }
      patchedConnect.__spardhaPatched = true;
      proto.connect = patchedConnect;
    }
  } catch (_) {}

  function patchAudioContext(name) {
    try {
      const Original = window[name];
      if (!Original || Original.__spardhaPatched) return;
      function WrappedAudioContext(...args) {
        const ctx = new Original(...args);
        ensureContextCapture(ctx);
        return ctx;
      }
      Object.setPrototypeOf(WrappedAudioContext, Original);
      WrappedAudioContext.prototype = Original.prototype;
      WrappedAudioContext.__spardhaPatched = true;
      window[name] = WrappedAudioContext;
    } catch (_) {}
  }

  patchAudioContext("AudioContext");
  patchAudioContext("webkitAudioContext");

  // Capture <audio>/<video> playback too, if the site uses media elements.
  try {
    const originalPlay = HTMLMediaElement.prototype.play;
    if (originalPlay && !originalPlay.__spardhaPatched) {
      function patchedPlay(...args) {
        try {
          if (!mediaSeen.has(this)) {
            mediaSeen.add(this);
            const fn = this.captureStream || this.mozCaptureStream;
            if (fn) {
              const s = fn.call(this);
              if (s) mediaStreams.push(s);
            }
          }
        } catch (_) {}
        return originalPlay.apply(this, args);
      }
      patchedPlay.__spardhaPatched = true;
      HTMLMediaElement.prototype.play = patchedPlay;
    }
  } catch (_) {}

  function availableStreams() {
    const arr = [];
    for (const c of contexts) {
      try {
        if (c.dest?.stream?.getAudioTracks().length) arr.push(c.dest.stream);
      } catch (_) {}
    }
    for (const s of mediaStreams) {
      try {
        if (s?.getAudioTracks().length) arr.push(s);
      } catch (_) {}
    }
    return arr;
  }

  window.__spardhaCaptureInfo = () => ({
    contexts: contexts.length,
    mediaStreams: mediaStreams.length,
    streams: availableStreams().length
  });

  window.__spardhaStartCapture = async () => {
    if (window.__spardhaRecorder?.state === "recording") {
      throw new Error("Recorder already running");
    }

    const streams = availableStreams();
    if (!streams.length) {
      throw new Error(
        "No capturable browser audio stream exists yet. " +
        "Start the Tanpura first, then retry."
      );
    }

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error("AudioContext unavailable");

    const mixCtx = new AC();
    if (mixCtx.state === "suspended") {
      try { await mixCtx.resume(); } catch (_) {}
    }

    const mixDest = mixCtx.createMediaStreamDestination();
    const sources = [];

    for (const s of streams) {
      try {
        const source = mixCtx.createMediaStreamSource(s);
        // Use original connect semantics where possible.
        source.connect(mixDest);
        sources.push(source);
      } catch (_) {}
    }

    if (!sources.length) {
      try { await mixCtx.close(); } catch (_) {}
      throw new Error("Audio streams were found but could not be mixed");
    }

    const choices = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg"
    ];
    let mime = "";
    for (const m of choices) {
      try {
        if (MediaRecorder.isTypeSupported(m)) { mime = m; break; }
      } catch (_) {}
    }

    const chunks = [];
    const recorder = mime
      ? new MediaRecorder(mixDest.stream, {mimeType: mime})
      : new MediaRecorder(mixDest.stream);

    recorder.addEventListener("dataavailable", e => {
      if (e.data && e.data.size) chunks.push(e.data);
    });

    window.__spardhaRecorder = recorder;
    window.__spardhaRecorderMeta = {chunks, mixCtx, sources, mime: recorder.mimeType || mime};
    recorder.start(250);

    return {
      mime: recorder.mimeType || mime,
      streams: streams.length,
      sources: sources.length
    };
  };

  window.__spardhaStopCapture = async () => {
    const recorder = window.__spardhaRecorder;
    const meta = window.__spardhaRecorderMeta;
    if (!recorder || !meta) throw new Error("Recorder is not running");

    return await new Promise((resolve, reject) => {
      recorder.addEventListener("error", e => reject(e.error || new Error("MediaRecorder error")), {once: true});
      recorder.addEventListener("stop", async () => {
        try {
          const blob = new Blob(meta.chunks, {type: recorder.mimeType || meta.mime || "audio/webm"});
          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);

          // Convert to base64 in chunks so large recordings do not overflow apply().
          let binary = "";
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
            binary += String.fromCharCode(...sub);
          }
          const b64 = btoa(binary);

          try { meta.sources.forEach(s => s.disconnect()); } catch (_) {}
          try { await meta.mixCtx.close(); } catch (_) {}
          window.__spardhaRecorder = null;
          window.__spardhaRecorderMeta = null;

          resolve({
            mime: blob.type || recorder.mimeType || meta.mime,
            size: bytes.length,
            base64: b64
          });
        } catch (err) {
          reject(err);
        }
      }, {once: true});

      try { recorder.stop(); } catch (err) { reject(err); }
    });
  };
})();
"""


def parse_args():
    p = argparse.ArgumentParser(
        description="Capture all 24 Spardha Tanpura key/pattern combinations."
    )
    p.add_argument("--output", default="assets/tanpura")
    p.add_argument("--seconds", type=float, default=7.0,
                   help="Seconds to record each combination (default: 7)")
    p.add_argument("--settle", type=float, default=1.6,
                   help="Wait after changing each key before recording (default: 1.6)")
    p.add_argument("--pattern-settle", type=float, default=3.0,
                   help="Wait after switching SA-PA/SA-MA before touching the first key (default: 3.0)")
    p.add_argument("--first-key-settle", type=float, default=2.0,
                   help="Extra wait after the first key in each pattern (default: 2.0)")
    p.add_argument("--only-pattern", choices=["sa-pa", "sa-ma"], default="",
                   help="Capture only one pattern; useful for repairing a missing file")
    p.add_argument("--only-key", choices=["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"], default="",
                   help="Capture only one key; combine with --only-pattern for a single file")
    p.add_argument("--headed", action="store_true",
                   help="Show the Chromium window while capturing")
    p.add_argument("--url", default="",
                   help="Override the Tanpura URL")
    p.add_argument("--force", action="store_true",
                   help="Overwrite existing 24 MP3 files")
    p.add_argument("--skip-bootstrap", action="store_true",
                   help="Do not auto-create a Playwright venv")
    p.add_argument("--no-record", action="store_true",
                   help="Only sniff/download runtime network audio; do not record")
    return p.parse_args()


def run(cmd, check=True, **kwargs):
    print("+", " ".join(map(str, cmd)))
    return subprocess.run(cmd, check=check, **kwargs)


def bootstrap_playwright_if_needed(args):
    if importlib.util.find_spec("playwright") is not None:
        return

    if args.skip_bootstrap:
        print(
            "ERROR: playwright is not installed.\n"
            "Install with:\n"
            "  python3 -m venv .tanpura-venv\n"
            "  .tanpura-venv/bin/pip install playwright\n"
            "  .tanpura-venv/bin/python -m playwright install chromium",
            file=sys.stderr,
        )
        raise SystemExit(2)

    script = Path(__file__).resolve()
    venv_dir = script.parent / ".tanpura-playwright-venv"
    py = venv_dir / "bin" / "python"

    if not py.exists():
        print("[bootstrap] Creating isolated Python environment...")
        try:
            venv.EnvBuilder(with_pip=True, clear=False).create(venv_dir)
        except Exception as exc:
            print(f"Could not create venv: {exc}", file=sys.stderr)
            print(
                "Run once:\n"
                "  sudo apt update && sudo apt install -y python3-venv",
                file=sys.stderr,
            )
            raise SystemExit(2)

    print("[bootstrap] Installing Playwright...")
    run([str(py), "-m", "pip", "install", "-U", "pip", "playwright"])

    print("[bootstrap] Installing Chromium for Playwright...")
    run([str(py), "-m", "playwright", "install", "chromium"])

    env = os.environ.copy()
    env["SPARDHA_BOOTSTRAPPED"] = "1"
    print("[bootstrap] Restarting downloader inside its venv...")
    os.execve(str(py), [str(py), str(script), *sys.argv[1:], "--skip-bootstrap"], env)


def ensure_ffmpeg():
    if shutil.which("ffmpeg"):
        return True

    print(
        "\nffmpeg is required to turn the captured browser audio into .mp3.\n"
        "Trying to install it with apt (Ubuntu may ask for your sudo password)...\n"
    )
    try:
        run(["sudo", "apt-get", "update"])
        run(["sudo", "apt-get", "install", "-y", "ffmpeg"])
    except Exception:
        print(
            "Automatic ffmpeg installation failed.\n"
            "Run:\n"
            "  sudo apt update && sudo apt install -y ffmpeg\n"
            "then run this script again.",
            file=sys.stderr,
        )
        return False
    return shutil.which("ffmpeg") is not None


def key_slug(key):
    return key.replace("#", "s")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def extension_for(mime, url=""):
    path_ext = Path(urlparse(url).path).suffix.lower()
    if path_ext in AUDIO_EXTS:
        return path_ext

    m = (mime or "").lower().split(";")[0].strip()
    return {
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/ogg": ".ogg",
        "audio/webm": ".webm",
        "audio/mp4": ".m4a",
        "audio/aac": ".aac",
        "audio/flac": ".flac",
    }.get(m, ".bin")


def is_audio_response(response):
    try:
        ct = (response.headers.get("content-type") or "").lower()
        ext = Path(urlparse(response.url).path).suffix.lower()
        return ct.startswith("audio/") or ext in AUDIO_EXTS
    except Exception:
        return False


def choose_chromium_executable():
    candidates = [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
    ]
    for p in candidates:
        if Path(p).exists():
            return p
    return None


def all_frames(page):
    # Snapshot because Playwright's frame list can mutate.
    return list(page.frames)


def find_button_frame(page, regex, exact_key=False):
    for frame in all_frames(page):
        try:
            if exact_key:
                loc = frame.get_by_role("button", name=regex)
            else:
                loc = frame.get_by_role("button", name=regex)
            if loc.count() > 0:
                for i in range(loc.count()):
                    item = loc.nth(i)
                    if item.is_visible():
                        return frame, item
        except Exception:
            continue
    return None, None


def _pattern_target(pattern_regex):
    p = pattern_regex.pattern.upper()
    return "SA MA" if "MA" in p else "SA PA"


def _click_pattern_with_dom(frame, target):
    """
    Click radio/label/div style pattern controls even when the visible text is
    Devanagari + English, e.g. "सा पा SA PA". Returns a diagnostic dict.
    """
    return frame.evaluate(
        r"""
        (target) => {
          const ascii = (s) => String(s || "")
            .normalize("NFKD")
            .replace(/[^\x00-\x7F]/g, " ")
            .replace(/[–—_-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .toUpperCase();

          const wanted = ascii(target);
          const other = wanted === "SA PA" ? "SA MA" : "SA PA";
          const nodes = [...document.querySelectorAll(
            'input[type=radio], button, label, [role=button], [role=radio], [tabindex], div, span, p'
          )];
          const candidates = [];

          for (const el of nodes) {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const visible = rect.width > 0 && rect.height > 0 &&
              style.display !== 'none' && style.visibility !== 'hidden';
            if (!visible) continue;

            const raw = el.matches('input')
              ? [el.value, el.name, el.id, el.getAttribute('aria-label')].filter(Boolean).join(' ')
              : (el.innerText || el.textContent || el.getAttribute('aria-label') || '');
            const text = ascii(raw);
            if (!text.includes(wanted)) continue;

            let score = text === wanted ? 0 : text.length;
            if (text.includes(other)) score += 10000;
            if (el.matches('input[type=radio]')) score -= 500;
            if (el.matches('button,label,[role=button],[role=radio]')) score -= 250;
            candidates.push({el, text, score});
          }

          candidates.sort((a,b) => a.score - b.score);
          if (!candidates.length) {
            return {ok:false, reason:'no-candidate', wanted};
          }

          let el = candidates[0].el;
          const original = el;

          if (el.matches('input[type=radio]')) {
            el.checked = true;
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
            try { el.click(); } catch (_) {}
          } else {
            const clickable = el.closest('button,label,[role=button],[role=radio]');
            if (clickable) el = clickable;
            else {
              let cur = el;
              for (let i=0; i<4 && cur; i++, cur=cur.parentElement) {
                const cs = getComputedStyle(cur);
                if (cur.onclick || cs.cursor === 'pointer' || cur.tabIndex >= 0) { el = cur; break; }
              }
            }
            try { el.scrollIntoView({block:'center', inline:'center'}); } catch (_) {}
            try { el.click(); } catch (_) {
              for (const type of ['pointerdown','mousedown','mouseup','click']) {
                el.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, view:window}));
              }
            }
          }

          return {
            ok:true,
            wanted,
            matched:candidates[0].text,
            tag:el.tagName,
            originalTag:original.tagName,
            className:String(el.className || '').slice(0,300)
          };
        }
        """,
        target,
    )


def click_pattern(page, pattern_regex):
    target = _pattern_target(pattern_regex)

    # 1) Semantic button/radio/label locators.
    semantic_rx = re.compile(rf"SA\s*[-–—]?\s*{target.split()[1]}", re.I)
    for frame in all_frames(page):
        for role in ("radio", "button"):
            try:
                loc = frame.get_by_role(role, name=semantic_rx)
                for i in range(loc.count()):
                    item = loc.nth(i)
                    if item.is_visible():
                        item.click(timeout=5000)
                        print(f"      pattern {target}: clicked role={role}")
                        return frame
            except Exception:
                pass

        # Labels are especially common for radio inputs.
        try:
            loc = frame.locator('label').filter(has_text=semantic_rx)
            for i in range(loc.count()):
                item = loc.nth(i)
                if item.is_visible():
                    item.click(timeout=5000)
                    print(f"      pattern {target}: clicked label")
                    return frame
        except Exception:
            pass

    # 2) DOM scoring fallback handles combined Devanagari + English labels and
    #    non-semantic React containers.
    diagnostics = []
    for frame in all_frames(page):
        try:
            result = _click_pattern_with_dom(frame, target)
            diagnostics.append(result)
            if result and result.get("ok"):
                print(
                    f"      pattern {target}: DOM click -> "
                    f"{result.get('tag')} text={result.get('matched')!r}"
                )
                return frame
        except Exception as exc:
            diagnostics.append({"ok": False, "error": str(exc)})

    # 3) If SA-PA cannot be clicked, it is commonly the default selected
    #    pattern on the public page. Continue instead of crashing. SA-MA must
    #    be positively selected, so failure there remains fatal.
    if target == "SA PA":
        print(
            "      WARNING: SA PA control was not separately clickable; "
            "continuing because SA-PA is the page's default pattern."
        )
        return find_tanpura_frame(page)

    raise RuntimeError(
        f"Could not select pattern {target}. DOM diagnostics: {diagnostics}"
    )


def click_key(page, key):
    rx = re.compile(rf"^\s*{re.escape(key)}\s*$", re.I)
    frame, btn = find_button_frame(page, rx, exact_key=True)
    if btn is None:
        raise RuntimeError(f"Could not find key button: {key}")
    btn.click(timeout=5000)
    return frame


def find_tanpura_frame(page):
    for frame in all_frames(page):
        try:
            c = frame.get_by_role("button", name=re.compile(r"^\s*C\s*$", re.I))
            b = frame.get_by_role("button", name=re.compile(r"^\s*B\s*$", re.I))
            if c.count() and b.count():
                return frame
        except Exception:
            pass
    return page.main_frame


def click_play_if_needed(frame):
    # Try the most specific phrases first.
    regexes = [
        re.compile(r"Click\s+Here\s+To\s+Play", re.I),
        re.compile(r"^\s*Play\s*!?\s*$", re.I),
        re.compile(r"\bPlay\b", re.I),
        re.compile(r"▶", re.I),
    ]
    for rx in regexes:
        try:
            loc = frame.get_by_role("button", name=rx)
            for i in range(loc.count()):
                b = loc.nth(i)
                if b.is_visible():
                    text = (b.inner_text() or "").strip()
                    # If it visibly says Stop/Pause already, leave playback alone.
                    if re.search(r"stop|pause", text, re.I):
                        return False
                    b.click(timeout=5000)
                    return True
        except Exception:
            pass

    # Fallback to visible text if it's not a semantic button.
    for rx in regexes:
        try:
            loc = frame.get_by_text(rx)
            for i in range(loc.count()):
                el = loc.nth(i)
                if el.is_visible():
                    el.click(timeout=5000)
                    return True
        except Exception:
            pass

    raise RuntimeError("Could not find the Tanpura Play control")


def print_button_inventory(page):
    print("\nVisible button inventory:")
    seen = []
    for frame in all_frames(page):
        try:
            items = frame.locator("button")
            for i in range(min(items.count(), 80)):
                b = items.nth(i)
                if b.is_visible():
                    t = re.sub(r"\s+", " ", (b.inner_text() or "").strip())
                    if t and t not in seen:
                        seen.append(t)
        except Exception:
            pass
    print("  " + " | ".join(seen[:80]))


def start_browser_audio_capture(frame):
    info = frame.evaluate("() => window.__spardhaCaptureInfo && window.__spardhaCaptureInfo()")
    if not info:
        raise RuntimeError("Audio capture hook was not installed in Tanpura frame")
    if int(info.get("streams", 0)) < 1:
        raise RuntimeError(
            f"No browser audio stream detected after playback started: {info}"
        )
    return frame.evaluate("() => window.__spardhaStartCapture()")


def stop_browser_audio_capture(frame):
    return frame.evaluate("() => window.__spardhaStopCapture()")


def convert_to_mp3(src, dst):
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src),
        "-vn",
        "-codec:a", "libmp3lame",
        "-q:a", "2",
        str(dst),
    ]
    run(cmd)


def write_manifest(output, mappings, raw_network, records):
    manifest_js = output / "tanpura_manifest.js"
    payload = {
        "sa-pa": mappings.get("sa-pa", {}),
        "sa-ma": mappings.get("sa-ma", {}),
    }
    raw_js = [
        item["relative_path"]
        for item in raw_network
        if item.get("relative_path")
    ]
    manifest_js.write_text(
        "// Generated by download_tanpura_all.py\n"
        f"window.TANPURA_ASSETS = {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))};\n"
        f"window.TANPURA_RAW_ASSETS = {json.dumps(raw_js, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )

    data = {
        "source": "Spardha Tanpura browser runtime capture",
        "patterns": payload,
        "network_audio": raw_network,
        "captures": records,
    }
    (output / "manifest.json").write_text(
        json.dumps(data, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    fields = [
        "pattern", "key", "file", "seconds", "source_kind",
        "size_bytes", "sha256",
    ]
    with (output / "manifest.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in records:
            w.writerow({k: row.get(k, "") for k in fields})


def main():
    args = parse_args()
    bootstrap_playwright_if_needed(args)

    if not args.no_record and not ensure_ffmpeg():
        return 2

    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

    output = Path(args.output).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    raw_dir = output / "original_network_audio"
    raw_dir.mkdir(parents=True, exist_ok=True)
    temp_dir = output / "_capture_tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 78)
    print("Spardha Tanpura Downloader / Runtime Recorder v3")
    print("=" * 78)
    print(f"Output : {output}")
    print(f"Record : {'OFF' if args.no_record else f'{args.seconds:g}s per combination'}")
    print("Target : 24 combinations = 12 keys × SA-PA / SA-MA")
    print()

    raw_network = []
    seen_network_sha = set()
    current_state = {"pattern": "", "key": ""}

    def save_audio_response(response):
        if not is_audio_response(response):
            return
        try:
            body = response.body()
            if not body:
                return
            digest = sha256(body)
            if digest in seen_network_sha:
                return
            seen_network_sha.add(digest)

            ct = response.headers.get("content-type") or ""
            ext = extension_for(ct, response.url)
            idx = len(raw_network) + 1
            name = f"{idx:03d}_{current_state['pattern'] or 'unknown'}_{key_slug(current_state['key'] or 'unknown')}{ext}"
            target = raw_dir / name
            target.write_bytes(body)

            rec = {
                "url": response.url,
                "content_type": ct,
                "status": response.status,
                "pattern_when_seen": current_state["pattern"],
                "key_when_seen": current_state["key"],
                "size_bytes": len(body),
                "sha256": digest,
                "relative_path": f"assets/tanpura/original_network_audio/{name}",
            }
            raw_network.append(rec)
            print(f"      [network audio] {name} ({len(body):,} bytes)")
        except Exception as exc:
            print(f"      [network audio read failed] {response.url}: {exc}")

    with sync_playwright() as p:
        executable = choose_chromium_executable()
        launch_kwargs = {
            "headless": not args.headed,
            "args": [
                "--autoplay-policy=no-user-gesture-required",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows",
            ],
        }
        if executable:
            launch_kwargs["executable_path"] = executable
            print(f"Browser: using installed Chromium/Chrome: {executable}")
        else:
            print("Browser: using Playwright Chromium")

        browser = p.chromium.launch(**launch_kwargs)
        context = browser.new_context(
            viewport={"width": 1280, "height": 900},
            java_script_enabled=True,
        )
        context.add_init_script(INIT_CAPTURE_SCRIPT)

        page = context.new_page()
        page.on("response", save_audio_response)

        candidate_urls = [args.url] if args.url else [PRIMARY_URL, FALLBACK_URL]
        loaded_url = None
        last_exc = None

        for url in candidate_urls:
            if not url:
                continue
            try:
                print(f"[1/5] Opening: {url}")
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(2500)
                # A usable page should expose C and B key buttons somewhere.
                frame = find_tanpura_frame(page)
                c = frame.get_by_role("button", name=re.compile(r"^\s*C\s*$", re.I))
                b = frame.get_by_role("button", name=re.compile(r"^\s*B\s*$", re.I))
                if c.count() and b.count():
                    loaded_url = url
                    break
                raise RuntimeError("Tanpura key controls not found")
            except Exception as exc:
                last_exc = exc
                print(f"      Not usable: {exc}")

        if not loaded_url:
            browser.close()
            raise RuntimeError(f"Could not open a usable Spardha Tanpura page: {last_exc}")

        print(f"      Loaded successfully: {loaded_url}")
        print_button_inventory(page)

        tan_frame = find_tanpura_frame(page)

        print("\n[2/5] Starting the real Tanpura...")
        # Select a known initial state first.
        current_state.update(pattern="sa-pa", key="C")
        click_pattern(page, PATTERNS[0][1])
        click_key(page, "C")
        page.wait_for_timeout(300)
        click_play_if_needed(tan_frame)
        page.wait_for_timeout(2200)

        try:
            cap_info = tan_frame.evaluate(
                "() => window.__spardhaCaptureInfo && window.__spardhaCaptureInfo()"
            )
        except Exception:
            cap_info = None
        print(f"      Browser audio hook: {cap_info}")
        print(f"      Runtime network audio files seen so far: {len(raw_network)}")

        # Preserve mappings from previous successful runs. This is important when
        # repairing only one combination (for example --only-pattern sa-ma --only-key C).
        mappings = {"sa-pa": {}, "sa-ma": {}}
        records = []
        existing_manifest = output / "manifest.json"
        if existing_manifest.exists():
            try:
                old_manifest = json.loads(existing_manifest.read_text(encoding="utf-8"))
                old_patterns = old_manifest.get("patterns") or {}
                for pname in ("sa-pa", "sa-ma"):
                    if isinstance(old_patterns.get(pname), dict):
                        mappings[pname].update(old_patterns[pname])
                old_records = old_manifest.get("captures") or []
                if isinstance(old_records, list):
                    records.extend(r for r in old_records if isinstance(r, dict))
                print("      Existing Tanpura manifest loaded; repair run will merge into it.")
            except Exception as exc:
                print(f"      Existing manifest could not be read; rebuilding mappings from MP3 filenames: {exc}")

        # Also rebuild obvious mappings from files already on disk, so a missing/old manifest
        # cannot cause good MP3 files to disappear from tanpura_manifest.js.
        for pname in ("sa-pa", "sa-ma"):
            for k in KEYS:
                candidate = output / f"{pname}_{key_slug(k)}.mp3"
                if candidate.exists() and candidate.stat().st_size > 2048:
                    mappings[pname][k] = f"assets/tanpura/{candidate.name}"

        selected_patterns = [p for p in PATTERNS if not args.only_pattern or p[0] == args.only_pattern]
        selected_keys = [k for k in KEYS if not args.only_key or k == args.only_key]
        total = len(selected_patterns) * len(selected_keys)
        print(f"\n[3/5] Cycling {total} requested combination(s)...")
        index = 0

        for pattern_name, pattern_rx in selected_patterns:
            current_state["pattern"] = pattern_name
            print(f"\n  Switching pattern -> {pattern_name.upper()}")
            click_pattern(page, pattern_rx)

            # Critical: React/UI state and the audio graph do not switch atomically.
            # Give the pattern change time to fully propagate before selecting C/first key.
            print(f"      waiting {args.pattern_settle:.1f}s for pattern/audio state to settle...")
            page.wait_for_timeout(int(args.pattern_settle * 1000))

            first_key = True
            for key in selected_keys:
                index += 1
                current_state["key"] = key
                slug = key_slug(key)
                outfile = output / f"{pattern_name}_{slug}.mp3"

                print(f"\n  [{index:02d}/{total}] {pattern_name.upper()} · {key}")

                # Re-click the key after a tab/pattern change even if it already looks selected.
                # This forces the site's handlers to rebuild the correct note/drone state.
                click_key(page, key)
                wait_s = args.settle + (args.first_key_settle if first_key else 0.0)
                if first_key:
                    print(f"      first key after pattern switch: extra {args.first_key_settle:.1f}s settle")
                page.wait_for_timeout(int(wait_s * 1000))
                first_key = False

                # If changing a setting stopped playback, try Play again.
                try:
                    info = tan_frame.evaluate(
                        "() => window.__spardhaCaptureInfo && window.__spardhaCaptureInfo()"
                    )
                except Exception:
                    info = None

                if not info or int(info.get("streams", 0)) < 1:
                    try:
                        click_play_if_needed(tan_frame)
                        page.wait_for_timeout(1500)
                    except Exception:
                        pass

                if args.no_record:
                    page.wait_for_timeout(900)
                    continue

                if outfile.exists() and not args.force and outfile.stat().st_size > 2048:
                    data = outfile.read_bytes()
                    print(f"      exists -> {outfile.name}")
                    mappings[pattern_name][key] = f"assets/tanpura/{outfile.name}"
                    records.append({
                        "pattern": pattern_name,
                        "key": key,
                        "file": outfile.name,
                        "seconds": args.seconds,
                        "source_kind": "existing",
                        "size_bytes": len(data),
                        "sha256": sha256(data),
                    })
                    continue

                # Start recording the page's actual audio graph.
                try:
                    started = start_browser_audio_capture(tan_frame)
                    print(
                        f"      recording browser audio "
                        f"({started.get('sources', '?')} source stream(s))..."
                    )
                except Exception as exc:
                    # One more Play attempt after a capture failure.
                    print(f"      capture not ready: {exc}")
                    try:
                        click_play_if_needed(tan_frame)
                        page.wait_for_timeout(1600)
                        started = start_browser_audio_capture(tan_frame)
                    except Exception as exc2:
                        print(f"      ERROR: cannot capture {pattern_name} {key}: {exc2}")
                        continue

                page.wait_for_timeout(int(args.seconds * 1000))
                result = stop_browser_audio_capture(tan_frame)
                raw = base64.b64decode(result["base64"])

                ext = extension_for(result.get("mime", "audio/webm"))
                if ext == ".bin":
                    ext = ".webm"

                temp = temp_dir / f"{pattern_name}_{slug}{ext}"
                temp.write_bytes(raw)

                if len(raw) < 1000:
                    print(f"      WARNING: capture is unusually small ({len(raw)} bytes)")

                try:
                    convert_to_mp3(temp, outfile)
                except Exception as exc:
                    print(f"      ERROR converting capture to MP3: {exc}")
                    continue

                data = outfile.read_bytes()
                mappings[pattern_name][key] = f"assets/tanpura/{outfile.name}"
                records.append({
                    "pattern": pattern_name,
                    "key": key,
                    "file": outfile.name,
                    "seconds": args.seconds,
                    "source_kind": "browser-runtime-recording",
                    "size_bytes": len(data),
                    "sha256": sha256(data),
                })
                print(f"      saved -> {outfile.name} ({len(data):,} bytes)")

        # Give late network responses a moment to finish.
        page.wait_for_timeout(1200)

        print("\n[4/5] Writing standalone manifest...")
        # Keep only the latest record for each pattern/key pair.
        latest_records = {}
        passthrough_records = []
        for rec in records:
            pair = (rec.get("pattern"), rec.get("key"))
            if all(pair):
                latest_records[pair] = rec
            else:
                passthrough_records.append(rec)
        records = passthrough_records + list(latest_records.values())
        write_manifest(output, mappings, raw_network, records)

        browser.close()

    # Keep raw fetched assets, remove intermediate recorder containers.
    shutil.rmtree(temp_dir, ignore_errors=True)

    requested_total = len([p for p in PATTERNS if not args.only_pattern or p[0] == args.only_pattern]) * len([k for k in KEYS if not args.only_key or k == args.only_key])
    expected = 0 if args.no_record else requested_total
    mp3s = [p for p in output.glob("*.mp3") if p.is_file()]

    print("\n[5/5] Done")
    print("=" * 78)
    print(f"Runtime network audio preserved : {len(raw_network)}")
    print(f"Final Tanpura MP3 files present : {len(mp3s)}")
    print(f"Requested this run              : {expected if expected else 'recording disabled'}")
    print(f"Manifest                        : {output / 'tanpura_manifest.js'}")
    print(f"JSON details                    : {output / 'manifest.json'}")

    if raw_network:
        print(f"Original runtime audio responses: {raw_dir}")
    else:
        print(
            "Original runtime MP3/audio responses: NONE.\n"
            "That means this version of the Spardha tool is likely synthesizing/"
            "rendering its drone in the browser rather than fetching literal MP3 files."
        )

    if not args.no_record:
        requested_files = [
            output / f"{pattern}_{key_slug(key)}.mp3"
            for pattern, _ in selected_patterns
            for key in selected_keys
        ]
        missing_requested = [p.name for p in requested_files if not p.exists() or p.stat().st_size <= 2048]
        if missing_requested:
            print(
                "\nWARNING: requested capture(s) missing or too small: " + ", ".join(missing_requested) + "\n"
                "Re-run with --headed --force so you can see the browser UI while it captures.",
                file=sys.stderr,
            )
            return 3

    print("\nSUCCESS.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# Audio asset licensing and provenance

> **Blocking issue for redistributable APKs and fully MIT-covered source archives.**
>
> The root [MIT LICENSE](../LICENSE) licenses **original VIO code, documentation and new SVG artwork contributed by Anuppaul**. It is **not** a representation that Anuppaul owns or can sublicense every included audio recording. Public availability, downloading, browser recording, transcoding, trimming, or resampling do **not** grant copyright permission.

## Current asset audit (source-derived)

| Location | What the repository records | Licensing conclusion |
| --- | --- | --- |
| `public/assets/tanpura/*.mp3` | `capture-manifest.json` documents 24 approximately 60-second **browser-runtime recordings** from an external source; precise original-source metadata remains recoverable from repository history for provenance verification. | **NOT CLEARED**. The MIT LICENSE **does not cover these audio recordings**. Obtain a documented redistribution/sublicensing grant or replace them with independently created or suitably licensed recordings. |
| `public/assets/ear/*.mp3` | The folder README says they were downloaded by `download_violin_mp3.py`, but does not identify a verified recording license. | **NOT CLEARED**. Confirm and document chain of title/permissions or replace them. |
| `public/assets/metronome/*.wav` | The folder README describes locally generated clicks, tabla and drum sounds. | Origin appears local, but confirm generator, underlying samples (if any), and authorship before a blanket MIT claim. |
| `public/assets/exercise/*.wav` | The folder README describes generating WAV note samples locally. | Confirm they are algorithmically synthesized and not derived from a third-party sample pack before licensing. |
| `app/icon.png`, `public/icons/` | Icons are bundled. Author/creation source is not documented in this audit. | Confirm artwork rights before asserting MIT applies. |
| `docs/assets/*.svg` (new README illustrations) | Authored specifically for VIO's open-source identity. | Intended for distribution under the project's MIT LICENSE. |

The assets remain in the repository **for compatibility with current installations**, but their presence is not an authorization to copy, reupload, mirror, modify, or distribute the uncleared recordings in another product.

## Why this matters

The repo's existing `release/*.apk` archives and new Android builds can contain the bundled Tanpura and Ear Tuner recordings. **Putting an MIT LICENSE beside those APKs does not make their embedded third-party audio reusable.** The repository may already be public; adding a notice now does not change earlier distribution or erase repository history.

Do not represent the source archive, binary, sound library, or all repository contents as wholly MIT-licensed until each included asset has its own documented provenance and grant.

## Clearance checklist

1. **Tanpura:** obtain permission from the actual rightsholder allowing source + binary redistribution (preferably under an explicit compatible open license), with written proof; or create 24 *independent*, self-recorded/synthesized Sa–Pa / Sa–Ma assets and verify their musical quality, loop boundaries and device performance.
2. **Ear reference MP3:** find and document original creators and permitted uses; otherwise synthesize or record independent violin notes.
3. **Metronome/exercise WAV:** audit the generation scripts, raw sources and any dependencies/sample libraries. Keep the generator committed if authored and source-ready.
4. **App icons:** record the original SVG/vector creation or proof of permission from the artist.
5. Add a per-directory `LICENSE` or `NOTICE` only when the corresponding rightsholder and full license terms are known. **Do not invent license grants.**
6. Remove/rebuild any uncleared media from public branches, future APKs and release assets. If files were previously committed, **history cleanup** may be needed; a deletion commit alone cannot remove older Git objects/forks/downloads. Coordinate such a rewrite carefully.
7. Rebuild the APK, test offline operation, ensure Tanpura and Ear Tuner retain a functional fallback, and document the audio's new independent provenance.
8. Only then mark an official binary/source release as redistribution-cleared.

## Contributor policy

Music samples, artwork, screenshots and recordings in pull requests must be original contributions or carry an explicit, independently verifiable redistribution license. Please identify creator, source URL (where applicable), license text and any attribution requirements. A contributor's statement that a sound was "free on the internet" is not sufficient.

**Status at documentation date:** Source-code MIT license prepared. Full asset rights verification **open**. This is a release blocker, not a claim of infringement adjudication.

# Third-party notices

VIO is an independent project created and maintained by **[Anuppaul](https://github.com/Anuppaul)**.

The project includes upstream dependencies, each governed by its **own** copyright and license terms. A project-level MIT LICENSE does not replace, modify, or supersede those terms.

## Main runtime and build dependencies

| Component | Role | Upstream |
| --- | --- | --- |
| Next.js / React / React DOM | Web UI, rendering and build framework | https://nextjs.org / https://react.dev |
| Capacitor | Android hybrid runtime and plugin bridge | https://capacitorjs.com |
| Pitchy | Browser fundamental-frequency estimation | https://github.com/ianprime0509/pitchy |
| Oboe | Native low-latency Android audio capture | https://github.com/google/oboe |
| Playwright | Browser smoke and regression testing | https://playwright.dev |
| Sharp | Image processing for Android launcher icons | https://sharp.pixelplumbing.com |

This is **not** a complete dependency-by-dependency license inventory. Check `package-lock.json`, Android Gradle/Maven dependency graphs and each corresponding `LICENSE`/`NOTICE` file before distributing a production build. Transitive dependency licenses and Android system components may have additional terms.

### Audio-specific third parties

Some bundled Tanpura recordings were captured from an external audio source. Exact historical source references remain available in repository history for rights verification. The sound recordings are **not covered by Anuppaul's MIT grant** unless appropriate authorization is documented. See [Audio asset licensing and provenance](docs/ASSET_LICENSING.md).

VIO is not represented as affiliated with or endorsed by any upstream project or source of third-party recordings.

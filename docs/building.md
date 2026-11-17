# Building Stremio NX

Requires Node.js 22, npm and Docker with Linux container support.

```sh
npm ci
npm ci --prefix runtime/nxjs
npm run build:nro
```

The build compiles the vendored nx.js runtime, bundles the app, packages
`stremio-nx.nro`, and verifies its native image, app, icon, author and licenses.
Checksums and build metadata are written to `artifacts/`.

Native compilation uses the Docker image pinned in `scripts/build-runtime.sh`.

**Native changes need the full build.** Changes under `runtime/nxjs/source`
(such as the two-core video conversion in `frame-convert.cc`) only reach the
NRO through `npm run build:nro`, which rebuilds the runtime in the toolchain
container. The repository's GitHub Actions workflow does this on every push:
the NRO is in the run's `stremio-nx-<commit>` artifact. `npm run native-check`
compiles the conversion path and the decoder against the host's FFmpeg and
benchmarks them (it needs FFmpeg development packages; see
`host-test/native/run.sh`).

**App-only changes without Docker:** if `src/` is all you changed, you can
reuse the native runtime from a release NRO. The packager keeps its native
code and replaces only the app RomFS (the verifier checks the native part is
unchanged):

```sh
curl -L -o runtime/nxjs.nro https://github.com/jrgf/stremio-nx/releases/latest/download/stremio-nx.nro
npm run build:app && npm run nro && node scripts/verify-nro.mjs
```
It contains the Switch toolchain, V8, Skia, FFmpeg and the other native libraries.
No sibling checkout or prebuilt local NRO is required. For an incremental app
change, run `npm run build:app` followed by `npm run nro`.

## Checks

```sh
npm run typecheck
npm run host-test:unit
node host-test/player-check.mjs
node host-test/video-render-check.mjs
npm run core-progressive   # progressive loading against the real core, local mock add-ons
```

The networking tests need permission to bind local sockets. Device playback
still needs testing on a Switch.

## GitHub Actions

The Build NRO workflow runs on pushes, pull requests, manual dispatch and published releases. It
installs both lockfiles, runs the checks, cross-compiles and verifies the NRO.
After a successful run, download `stremio-nx-<commit>` from the run's Artifacts
section. The archive contains the NRO, checksum, build log, notices and project
source. Artifacts expire after 14 days.

To put the NRO on the GitHub Releases page, publish a release with a tag pointing
to a commit that includes this workflow. Once the build succeeds, the NRO,
checksum, build metadata, licenses and project source appear under Assets.
Re-running that release build replaces attachments with the same names.
Regular pushes and manual builds only produce Actions artifacts.

Include `runtime/nxjs` source when committing. Its generated files and dependency
directories are ignored. See its `README.stremio.md` for provenance.

## Distribution

The project source archive covers this repository, including the patched runtime.
It does not include all native library sources supplied by the Docker image.
Complete corresponding dependency sources and remaining third-party notices
before a public binary release. See [the license review](../LICENSE_REVIEW.md).

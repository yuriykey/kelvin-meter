# KelvinMeter

An offline, install-to-home-screen web app that measures the correlated colour
temperature (CCT) of ambient light in Kelvin, accurately enough to set white
balance for interior photography.

Everything runs on the device. There is no backend, no analytics, no CDN, and
no network request of any kind after the first load. Files you pick never leave
the phone.

---

## The constraint everything else follows from

**iOS Safari exposes no camera control constraints.** No white balance lock, no
exposure lock, no ISO, no focus, no RAW. `getCapabilities()` on a video track
returns essentially nothing, and Chrome and Firefox on iOS are the same WebKit
engine, so there is no escape hatch.

Every frame from `getUserMedia` has already been auto-white-balanced and tone
mapped into sRGB. The camera has actively **removed the colour cast we are
trying to measure**. Pointing it at a grey card and reading the card's colour
is meaningless by construction: making grey cards grey is exactly what auto
white balance does.

This app therefore has two modes, and only one of them is a measurement.

| | Mode 1: Import RAW | Mode 2: Live |
|---|---|---|
| Source | DNG metadata | Camera frames |
| What it reads | The camera's own illuminant estimate, in unprocessed camera space | Residual inter-patch ratios that survive auto white balance |
| Realistic accuracy | ±150 K typical once calibrated | ±400 K at best |
| Needs a reference card | No | Yes, and calibration bound to that exact card |
| Trust it for a final white balance | Yes | No |

The app never asks for `whiteBalanceMode`, `colorTemperature` or
`exposureMode`. Requesting them would be silently ignored and would imply the
frames are unprocessed. Instead their absence is detected and reported — see
[Reporting what your device actually exposes](#reporting-what-your-device-actually-exposes).

---

## Mode 1 — Import RAW (the accurate one)

A DNG's `AsShotNeutral` tag records the camera's own estimate of the scene
neutral in native camera RGB, before any white balancing. Combined with the
camera's `ColorMatrix1`/`ColorMatrix2` calibration matrices it gives the
illuminant's chromaticity — which is precisely what `getUserMedia` throws away.

### How to shoot the file

- **iPhone Pro** — Settings → Camera → Formats → Apple ProRAW on, then tap
  **RAW** in the Camera app.
- **Any iPhone** — Adobe Lightroom mobile's built-in camera shoots DNG for
  free. Halide works too.
- **Nikon NEF** — also TIFF-based and carries the same white balance metadata.
  It is a stretch goal, not supported in this version, and untested.

Fill a good part of the frame with the light you are measuring and keep other
sources out of shot. The camera estimates *one* illuminant for the whole scene,
so a mixed frame gives you an average of the mixture, not either light.

A HEIC or a JPEG cannot work no matter how it was shot. The processing that
produced it has already removed the thing being measured. The app detects this
and says so rather than producing a confident wrong number.

### What it does with the file

1. Parses the TIFF/DNG IFD structure directly — no third-party library. Both
   byte orders, plus BigTIFF, walking IFD0 and its SubIFDs.
2. Extracts `AsShotNeutral` (50728), `AsShotWhiteXY` (50729),
   `ColorMatrix1`/`2` (50721/50722), `CameraCalibration1`/`2` (50723/50724),
   `AnalogBalance` (50727), `ForwardMatrix1`/`2` (50964/50965) and
   `CalibrationIlluminant1`/`2` (50778/50779).
3. If `AsShotWhiteXY` is present, uses it directly — that writer has already
   done the work and its answer is authoritative.
4. Otherwise solves for the illuminant by the DNG spec's fixed-point iteration:
   seed at D50, interpolate the colour matrices between the two calibration
   illuminants **in mired space**, compute `XYZ = inv(XYZtoCamera) · AsShotNeutral`,
   derive the CCT, re-interpolate, and repeat until the estimate moves less
   than 5 K. It converges in three passes.
5. Converts xy to CCT by **Robertson's method**.
6. Computes **Duv** against a Planckian locus derived from Planck's law, and an
   **Adobe-compatible temperature/tint** pair.

Every reading shows its source tag, the matrix blend used, the number of solve
passes, Duv, xy and the uncorrected value, so it can be audited rather than
taken on faith.

### Why Robertson and not McCamy

McCamy's cubic approximation is fitted around daylight and degrades below
2500 K and above 7000 K — which is exactly the span this app lives in
(2700 K bulbs at one end, 6500 K window light at the other). Robertson's
isotemperature line method holds up across the whole range and is what the
tests verify.

---

## Mode 2 — Live (approximate)

For a quick on-site reading without the RAW round trip. Labelled
**LIVE (approx)** everywhere, for good reason.

Auto white balance applies approximately global per-channel gains. For two
patches *p* and *q* in the same frame:

```
V(p,c) = gain(c) · S(p,c)          so     V(p,c) / V(q,c) = S(p,c) / S(q,c)
```

The gain divides out. What remains still depends on the illuminant's spectrum,
because *S* is an integral of illuminant × patch reflectance × channel
sensitivity. That residual is the signal.

The warmth feature contrasts how red and blue each see a warm patch relative to
a cool one:

```
F = ln( V(warm,R) / V(cool,R) ) − ln( V(warm,B) / V(cool,B) )
```

`F` rises monotonically with colour temperature, but its scale is a property of
your sensor and your card, so it must be calibrated and cannot ship with a
factory curve. There is a unit test that proves the premise directly: the same
simulated scene under three very different AWB gain sets produces the same
feature value to twelve decimal places.

### Using it

1. Pick your card in a live-mode calibration profile — ColorChecker Passport,
   ColorChecker Classic/Mini, or SpyderCheckr 24.
2. Line the four guide boxes up with the named patches. Alignment is manual by
   design; automatic chart detection is not in this version.
3. Patch samples are linearised out of sRGB before any arithmetic, and a patch
   that is clipping or below 10% of range is rejected by name.
4. HOLD freezes a reading.

### The caveat that does not go away

**iOS applies spatially varying tone mapping, and the ratio method does not
cancel it.** The gains only divide out cleanly if they are the same for both
patches, and local tone mapping means they are not. Keep the patches adjacent
and similar in brightness, and keep very bright or very dark areas out of the
frame. Even then, treat live mode as the difference between "warm" and "cool",
not as a number to type into a raw converter.

---

## Calibration

This is the part that makes the app worth having.

**Everything is fitted in mired** (reciprocal megakelvin, `1e6 / K`), never in
Kelvin. Mired is roughly perceptually even for colour temperature: 2700 K →
2800 K is a visible change and 9000 K → 9100 K is not, but in mired those are
13.2 and 1.2 respectively. A straight line fitted in mired behaves across the
whole range; the same line fitted in Kelvin is dominated by the daylight end
and is badly wrong at the tungsten end.

- **Multi-point.** Take a reading, type the reference source's known CCT, store
  the pair. The fit is monotonic piecewise-linear via isotonic regression, so a
  self-contradicting calibration set is pooled to a monotonic curve with
  visible residuals rather than folding back and reporting two temperatures for
  one reading.
- **No polynomials, ever.** Past the outermost points the raw-mode correction
  is held flat — it keeps applying the last known correction rather than
  running off the end. Live mode continues the end segment's slope instead
  (flat would collapse every out-of-range reading onto one temperature) and
  flags the reading as extrapolated.
- **Single-point field trim.** "This light is actually ____ K" applies an
  offset, expressed in mired so it behaves the same at both ends.
- **Independent tint offset.**
- **Profiles never mix.** A profile is bound to one mode, one capture app and
  one reference card. A ProRAW profile and a Lightroom-DNG profile are
  different instruments; a calibration fitted against a Passport says nothing
  about a SpyderCheckr.
- The calibration screen plots the stored points **in mired**, shows each
  point's residual in Kelvin, and lets you delete points individually.

### What to calibrate against

A **bi-colour LED panel with calibrated presets** is the practical reference.
Set a preset, fill the frame, store the point.

A household bulb's box rating is **±150 K at best**, and cheap ones are worse.
Usable as a rough anchor, not as truth. If bulbs are all you have, store
several across the range rather than trusting any one.

Two points at opposite ends beat five bunched together — the fit interpolates
between what you give it and holds flat outside, so span matters more than
count.

### Storage, and why export is not optional

Data lives in IndexedDB. **iOS evicts web app storage from origins it has not
seen in a while, and adding the app to the home screen does not exempt it.** A
calibration set that took a panel and half an hour to build is worth more than
the app itself, so the app prompts you to export after every calibration
change. Import merges by id with newest-wins, so importing the same backup
twice is a no-op and an old backup cannot undo newer work.

---

## Reporting what your device actually exposes

The **Guide** screen dumps `navigator.mediaDevices.getSupportedConstraints()`
and the live track's `getCapabilities()` and `getSettings()`, with a copy
button.

This is deliberately a runtime report rather than a claim in this file. What
live mode can do depends entirely on the device, and the honest answer to "why
can't it just lock white balance" is the list of constraints your browser does
not implement. Open live mode once, then read the Guide screen.

> **Note on this section.** The capability report has not been captured on a
> physical iPhone by the author of this commit — the app was developed and
> verified in desktop Chromium. Desktop Chromium *does* report
> `whiteBalanceMode` and `exposureMode` as supported constraints, which is why
> the app reads them at runtime and reports what it finds rather than assuming
> WebKit's behaviour. If you run this on an iPhone, paste the report here:
>
> ```
> (paste the Guide screen's capability report for iOS Safari here)
> ```

---

## Accuracy, stated honestly

| Quantity | Displayed to | Why |
|---|---|---|
| Kelvin, RAW mode | nearest 10 K | Repeatable to better than that, absolute accuracy is not |
| Kelvin, live mode | nearest 50 K | The underlying signal does not support more |
| Tint, RAW mode | nearest 1 | Matches the Adobe slider's own granularity |
| Tint, live mode | nearest 5 | ditto |
| Duv | 4 decimals | The precision every standard that defines Duv uses |

Reported uncertainties are **±150 K typical for RAW** and **±400 K typical for
live**. Those are honest working figures, not error bars from a calibrated
instrument.

Things that will make a reading wrong regardless of the maths:

- **Mixed lighting in one frame.** You get the mixture, not either source. Shoot
  each light separately.
- **A large `|Duv|`.** Past ±0.05 a colour temperature does not describe the
  light at all, and the app blocks the reading rather than printing a number.
  Fluorescent and cheap LED sit well off the locus; match the tint too.
- **A camera app that pre-processes.** Some apps write a DNG whose
  `AsShotNeutral` has already been adjusted. That is what per-app calibration
  profiles are for.

### Warning states

Warnings **replace** the number rather than sitting beside it. At arm's length
in a dim room the eye lands on the big figure and acts on it, and a caveat
underneath does not stop that. The blocking states are `CLIPPING`, `TOO DARK`,
`NO CALIBRATION`, `UNSUPPORTED FILE`, `OFF LOCUS`, `OUT OF RANGE` and
`ALIGN CARD`.

---

## Build, test, deploy

```bash
npm install
npm run dev        # dev server; the service worker is disabled here on purpose
npm test           # unit tests, no DOM and no camera
npm run typecheck
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build
```

Two generated-but-committed asset sets, regenerated by:

```bash
npm run icons      # draws the PNG icons from code, no image library
npm run fixtures   # rebuilds the synthetic DNG test fixtures
```

CI regenerates both and fails on any diff, so a stale generator cannot silently
disagree with a committed asset.

### The smoke test

```bash
npm run build && npm run smoke
```

Drives the production build in a real browser, served from a subpath, and
checks the flows that cross the DOM boundary the unit tests stay behind:
service worker scope, DNG import, the warning state replacing the number, a
two-point calibration reproducing both points, live mode against a fake camera,
and — the one check nothing else can make — that the app **loads and keeps its
data with the network switched off**.

It is not part of CI, because it needs a browser binary. It is worth running
before any release: it is what caught the readout overflowing onto the mode
toggle and swallowing taps.

### Deployment

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every
push to `main`. Enable it once under **Settings → Pages → Source → GitHub
Actions**.

The site lives at a subpath (`https://user.github.io/repo/`), which is the
single most common way a PWA on Pages breaks. Three things make it work:

- Vite's `base` is `'./'`, so every asset reference in the built HTML is
  relative.
- The manifest's `start_url` and `scope` are `"./"`, and every icon `src` is
  relative.
- The service worker registers with a scope derived from `document.baseURI` at
  runtime, and its precache manifest holds relative URLs resolved against the
  worker's own location.

`scripts/verify-build.mjs` runs after every CI build and fails if any precached
file is missing, if any path is absolute, or if the worker still contains build
placeholders. That check matters because `cache.addAll` is atomic: one missing
file means the install silently does nothing, the app looks fine online, and it
is simply broken offline — the one thing it exists to be.

### Cache busting

Every build stamps a cache name from the version, the short commit SHA and the
build timestamp, so a new deploy always invalidates the old cache. The running
version and commit are shown at the bottom of the measure screen and on the
Guide screen. When a new build is found, a banner offers to reload; accepting
posts `SKIP_WAITING` to the waiting worker so the update applies without having
to close every tab.

### Installing on an iPhone

Open the Pages URL in Safari → Share → **Add to Home Screen**. Launch it once
while online so the service worker precaches, after which it works with no
network at all. Verify by enabling airplane mode and launching from the home
screen icon.

---

## Testing

The colour maths is tested with no camera and no DOM.

```
xy (0.3127, 0.3290) → 6503.7 K, Duv +0.0032   (D65)
xy (0.4476, 0.4074) → 2854.9 K, Duv −0.0000   (CIE Illuminant A)
xy (0.3457, 0.3585) → 5000.7 K, Duv +0.0032   (D50)
xy (0.3324, 0.3474) → 5502.3 K, Duv +0.0032   (D55)
```

Daylight illuminants read a little green of the blackbody locus, which is
correct and is why D65 is not at Duv 0. These exact figures are pinned by
`src/color/readmeValues.test.ts`, so this table cannot drift from the code.

Two things are worth calling out because they are stronger than typical
assertions:

**The data tables validate each other.** The Robertson isotemperature table and
the CIE 1931 2° colour matching functions are both transcribed data, and a
transcription error in either would be silent. So the Planckian locus computed
from Planck's law and the CMFs is checked against the Robertson table's own u/v
columns at all 30 finite temperatures, and they agree to better than 1.5e-4.
Two independent sources agreeing that closely rules out an error in either. The
comparison uses the 1931-era value of `c₂` the Robertson table was computed
with, so the only residual is quadrature error and the table's own rounding.

**The DNG solver is checked by round trip.** Rather than needing a reference
DNG for every camera, the forward model (illuminant → what the camera records)
and the solver (what the camera recorded → illuminant) are run against each
other from 2000 K to 10000 K and must agree within 10 K, on and off the
Planckian locus. Against the committed fixture bytes, the solved illuminant is
also checked to regenerate the stored `AsShotNeutral` exactly.

Also covered: both byte orders producing identical results, truncated and
non-TIFF files failing cleanly, degenerate `AsShotNeutral` never yielding an
unflagged reading, AWB gains cancelling in the live-mode feature, two-point
mired calibration reproducing both points exactly and interpolating
monotonically, isotonic pooling of contradictory calibration points, and CSV
cells that start like a spreadsheet formula being neutralised.

### Adding a real DNG to the test suite

The synthetic fixtures in `test/fixtures/` are hand-built TIFF containers with
a plausible but entirely synthetic camera profile. Their expected values are
stored in the exact shape `exiftool -j -n` emits, so adding a real camera's
file needs no test changes:

```bash
cp ~/somewhere/IMG_1234.dng test/fixtures/iphone15pro.dng
exiftool -j -n test/fixtures/iphone15pro.dng > test/fixtures/iphone15pro.exiftool.json
npm test
```

The existing test discovers every `*.exiftool.json` in that directory and
checks the parser against the matching `.dng`.

---

## Layout

```
src/
  color/         Pure colour science. No DOM, no I/O, fully tested.
    robertson.ts   Isotemperature table and CCT
    planck.ts      Blackbody locus from Planck's law, daylight locus
    cmf.ts         CIE 1931 2° observer
    duv.ts         Signed distance from the Planckian locus
    adobeTint.ts   Lightroom/PhotoLab-compatible temperature and tint
    format.ts      Where display precision is decided
  dng/           TIFF/DNG parsing and the illuminant solve
  live/          Camera access, patch sampling, AWB-invariant features
  calibration/   Mired-space curve fitting and profiles
  storage/       IndexedDB, JSON backup, CSV export
  ui/            Screens
  pwa/           Service worker template and registration
scripts/         Icon drawing, fixture generation, build verification
```

## Licence

MIT.

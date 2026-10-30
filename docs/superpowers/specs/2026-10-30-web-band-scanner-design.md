# 9GRadio Web Band Scanner: Design

## Intent

A browser version of 9GRadio's scanner for HackRF and RTL-SDR radios plugged
directly into the computer. It scans a band for strong signals, stops and plays
the audio, logs every signal it finds, and lets the user mark a frequency "skip."

## Decided by the user

**Radios**
- HackRF or RTL-SDR, one or more, selectable, each able to scan its own part of
  the spectrum at the same time.
- If two radios hear the same signal, the one with the greatest signal strength
  is used.

**Screen**
- Layout B, spectrum first: a waterfall per radio with hits marked, a "Now
  playing" bar on top with Skip and Next, and the hit list in a right column.

**Hit list**
- Every found signal is logged automatically. New signals need no "listen" tag.
- A signal marked "skip" is ignored when it is found again.

**Stop rule**
1. A signal clears the "strong" line, and that radio stops and plays it.
2. It stays at least **n** seconds, playing anything that comes up.
3. After n it plays as long as the signal is on. When the signal drops, the **x**
   delay starts. If a signal returns during the delay, it plays until it drops
   and the delay starts over.
4. A full quiet x delay returns the radio to scanning.
5. Nothing is skipped automatically, so it stops again if found later.

A stuck carrier therefore holds the radio indefinitely. Next and Skip are the
manual exits.

**Modes**
- The other 9GRadio features are selectable as what to scan for, alongside AM,
  FM and sideband. APRS comes first.
- An APRS hit shows the metadata and the packet data.

## My calls

**Platform**
- Runs in Chromium browsers through WebUSB. TypeScript, Vite, no UI framework.
- A static site in `web/`. It runs from localhost and can later be hosted on any
  HTTPS address, so the "who else uses it" question doesn't change the build.
- One Web Worker per radio holds the USB connection, DSP and scan loop, so the
  page can't stall reception.

**Scanning**
- A whole slice is captured at once with an FFT, then the radio hops 0.9 × sample
  rate. This follows the Android scanner and rtl-sdr-scanner-cpp.
- "Strong" is a per-radio slider drawn as a line on the spectrum, default noise
  floor + 12 dB. Defaults: n = 10 s, x = 3 s, per radio.
- Found frequencies snap to the band's step. Hits within one channel width are
  the same signal and share one row.
- The band is placed away from the radio's center so its DC spike can't hide a
  signal. Wider bands shift their slices on alternate sweeps for the same reason.
- RTL-SDR runs at 2.4 MS/s and HackRF at 4.8 MS/s, a reduced rate for browser
  processing limits.

**APRS**
- A hit means a packet passed its error check. A signal that doesn't decode within
  3 seconds is ignored: not played and not logged. This check is new; the Android
  scanner detects by energy only.
- Audio plays like any other hit and can be muted. Every packet is kept.
- No map in the first version.

**Next**
- Leaves now and ignores that frequency for 5 seconds, so a signal that is still on
  doesn't stop the scan again straight away. After that it can be found as normal.

**Two radios, one signal**
- "Greatest signal strength" is measured as dB over each radio's own noise floor,
  since dBFS depends on each radio's gain setting.
- This only applies when both radios are looking for the same mode. An APRS radio
  keeps its frequency even when a voice radio hears it better, because it is doing
  a different job there.

**Two radios, different signals**
- Whichever started first keeps playing. The other shows as live in the list and
  stays parked until its signal ends. Clicking its row switches the audio.

**Data**
- One row per frequency. Tags belong to the frequency, not the radio. A row with
  packets stays labeled APRS, so its packets stay reachable.
- Skipped rows stay greyed with Unskip. The list and packets persist in the
  browser (IndexedDB). CSV export for the list and for packets.
- Radio data is untrusted: never rendered as HTML, and CSV cells are protected
  against spreadsheet formula injection.

**Hardware safety**
- HackRF RF amp and antenna power stay off, and the RTL-SDR bias tee is never
  turned on, so nothing can damage a connected antenna or preamp. Receive only.

**Signal strength**
- Shown as dBFS and dB above noise, not S-units or dBm. Those need calibration
  the web version doesn't have.

## Roadmap of receiver modes

| Stage | Modes | How |
|---|---|---|
| 1 (this build) | AM, NFM, WFM, USB, LSB, CW, APRS | TypeScript |
| 2 | POCSAG, ACARS | Rewrite the Kotlin decoders |
| 3 | DMR, D-STAR, YSF, P25, NXDN, dPMR | Compile dsdcc and mbelib to WebAssembly |

ADS-B, AIS, satellite tracking, SSTV, LRPT, MLAT and RDF aren't scan modes. They
could become separate tools later.

## Non-goals for the first version

- Transmit, recording, or an APRS map.
- Tuners other than R820T, R820T2 and R828D. RTL-SDR direct sampling below 24 MHz
  on non-V4 dongles.
- Browsers without WebUSB (Firefox, Safari).

## Known limits

No radio was attached while this was built. The RTL-SDR driver is a port of the
Android app's. The HackRF driver is new, written from libhackrf's source, because
the Android app has no HackRF support to port.

On 2026-10-30 the HackRF driver was run against a HackRF Pro (firmware 2026.01.3),
both from Node and in Chrome 156 through WebUSB. It streamed at 4.79 MS/s and found,
stopped on and played local FM stations, and Next and Stop worked. That test moved
the HackRF default gain from 40 dB, where the samples sat at quantization level, to
60 dB. Gains from 50 to 76 dB worked, and 84 dB overloaded.

Still untested on hardware: the RTL-SDR driver, and the APRS decoder on a real
packet (none were heard in 3 minutes on 144.390). The radio also stops on steady
carriers with no audio, such as 120.000 and 144.085 MHz on the HackRF Pro used for
testing. Under the stop rule these hold the radio until Skip.

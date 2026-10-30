# 9GRadio Web Scanner Release Notes

## 0.1.0 (2026-10-30)

The first release of a browser version of 9GRadio's scanner. It works with HackRF
and RTL-SDR radios plugged into the computer and runs in Chrome or Edge. It scans
a band for strong signals, stops and plays them, logs every signal it finds, and
lets you mark a frequency to skip.

### Scanning
- **Strong line.** A signal must clear it before the scan stops. It is drawn on
  the spectrum and set per radio, 12 dB over the noise by default.
- **Stop rule.** The radio stays at least **n** seconds, then for as long as the
  signal is on. When the signal drops it waits the **x** delay, and a reply during
  the delay starts the cycle again. A full quiet delay sends it back to scanning.
- **Nothing is skipped automatically.** A signal found again stops the scan again.
- **Skip** ignores a frequency on every radio from then on. **Unskip** undoes it.
- **Next** leaves now and ignores that frequency for 5 seconds.
- **Bands.** Thirteen presets (2 m, 70 cm, APRS, air band, FM broadcast, marine,
  NOAA weather, FRS/GMRS, CB, 40 m and 20 m phone, 20 m CW), or your own start,
  stop and step.
- **Per-radio settings.** Strong line, gain, PPM correction and timings are saved
  for each radio.

### Modes
- AM, NFM, WFM (mono), USB, LSB, CW and APRS.
- **APRS** counts a signal only once a packet passes its checksum. The packet panel
  shows the metadata (time, frequency, signal strength, radio) and the packet data,
  decoded and as raw text. It decodes positions (including compressed and Mic-E),
  weather, status, messages, objects, items and telemetry.
- The roadmap for later modes (POCSAG and ACARS next, then digital voice) is in
  `docs/superpowers/specs/2026-10-30-web-band-scanner-design.md`.

### Several radios
- Each radio scans its own band at the same time.
- When two radios looking for the same mode hear the same signal, the one with the
  most dB over its own noise plays it, and the other goes back to scanning.
- When two radios find different signals, the first keeps playing and the second
  shows as live in the list. Click its row to switch to it.

### Hit list and data
- Every signal is logged automatically, one row per frequency.
- The list, skips and APRS packets are saved in the browser and survive a reload.
- **Export CSV** for the list and for packets. **Clear** empties the list and keeps
  your skips.

### Radios
- **HackRF**, at 4.8 MS/s. Tested on a HackRF Pro (firmware 2026.01.3) in Chrome
  156, where it found and played local FM stations and Next and Stop worked. The
  default gain is 60 dB.
- **RTL-SDR** with an R820T, R820T2 or R828D tuner, at 2.4 MS/s. The RTL-SDR Blog
  V4's HF upconversion is supported. The driver is ported from the Android app.
- **Demo radio.** Runs the whole app on simulated signals with no hardware.
- **Receive only.** The HackRF RF amp and antenna power, and the RTL-SDR bias tee,
  always stay off.

### Known issues
- The RTL-SDR driver hasn't been tested on a real dongle yet.
- The APRS decoder hasn't been tested on a real over-the-air packet yet.
- A steady carrier with no audio, such as a radio's own interference, holds the
  radio until you press Skip. The HackRF Pro has them at 120.000 and 144.085 MHz.
  Skip each one once.
- On FM broadcast, the digital sidebands of HD Radio stations can be logged as
  stations on even tenths, such as 105.2. Skip them.
- Frequency labels above the spectrum overlap when signals are close together.
- Signal strength is shown as dB over noise and dBFS, not S-units, because there's
  no calibration.
- Needs a Chromium browser for WebUSB. RTL-SDR below 24 MHz needs a V4.

### Running it
- **From source:** `cd web && npm install && npm run dev`, then open
  http://localhost:5173.
- **From the release download:** unzip `9gradio-web-scanner-0.1.0.zip` and serve
  the folder, for example with `python3 -m http.server`, then open
  http://localhost:8000. Browsers only allow USB access from `localhost` or
  `https://`, so a hosted copy must use HTTPS.
- **Linux:** see the setup steps in `web/README.md`.

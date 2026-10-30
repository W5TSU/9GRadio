# 9GRadio Web Scanner

A browser version of 9GRadio's scanner for HackRF and RTL-SDR radios plugged
directly into your computer. It scans a band for strong signals, stops and plays
them, logs everything it finds, and lets you mark a frequency to skip. Run one
radio, or several on different parts of the spectrum at once.

You can try it with no hardware: **+ Demo radio** runs the whole app on simulated
signals.

## Running it

You need Node.js 20 or newer, and Chrome or Edge. Firefox and Safari don't have
WebUSB.

```sh
cd web
npm install
npm run dev
```

Then open http://localhost:5173 and click **+ Add radio**.

To build a static site you can host, run `npm run build`. The result is in
`web/dist/`. Browsers only allow USB access from `https://` or `localhost`, so a
hosted copy must use HTTPS.

## Linux setup

Without these two steps the browser can't open the radio. Windows needs a
different step: install the WinUSB driver for the dongle with Zadig.

**1. Give your account access to the radios.** Save this as
`/etc/udev/rules.d/52-9gradio-sdr.rules`:

```
# RTL-SDR
SUBSYSTEM=="usb", ATTR{idVendor}=="0bda", ATTR{idProduct}=="2832", MODE="0660", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="0bda", ATTR{idProduct}=="2836", MODE="0660", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="0bda", ATTR{idProduct}=="2837", MODE="0660", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="0bda", ATTR{idProduct}=="2838", MODE="0660", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="0bda", ATTR{idProduct}=="2840", MODE="0660", TAG+="uaccess"
# HackRF
SUBSYSTEM=="usb", ATTR{idVendor}=="1d50", ATTR{idProduct}=="6089", MODE="0660", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="1d50", ATTR{idProduct}=="604b", MODE="0660", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="1d50", ATTR{idProduct}=="cc15", MODE="0660", TAG+="uaccess"
```

Then run `sudo udevadm control --reload-rules`, and unplug and replug the radio.

**2. Keep the TV driver off RTL-SDR dongles.** Linux treats them as TV tuners by
default. Save this as `/etc/modprobe.d/blacklist-dvb-rtl.conf`:

```
blacklist dvb_usb_rtl28xxu
```

Then run `sudo modprobe -r dvb_usb_rtl28xxu`.

## How it behaves

**Stopping.** A signal has to clear the "strong" line, which is the dashed line on
the spectrum and defaults to 12 dB over the noise. The radio then stops and plays
it for at least the **Stay at least** time. After that it stays as long as the
signal is on. When the signal drops it waits the **Reply delay**, and a reply
during that wait starts the cycle again. A full quiet delay sends it back to
scanning. Nothing is skipped automatically, so it stops again next time it finds
the signal.

**Skip** ignores a frequency from now on, on every radio. **Next** leaves right
now and ignores that frequency for 5 seconds, so a signal that is still on doesn't
stop the scan again straight away.

**Two radios, one signal.** When two radios looking for the same mode hear the same
signal, the one with the most dB over its noise keeps it and the other goes back to
scanning.

**Two radios, two signals.** The first keeps playing and the second shows as live
(◉) in the list. Click its row to switch to it.

**APRS.** Scanning for APRS only counts a signal once a packet passes its checksum.
A signal with no valid packet is ignored and never logged. Click an APRS row to see
every packet. Mute works on APRS audio like any other.

## Limits of this version

- Modes are AM, NFM, WFM (mono), USB, LSB, CW and APRS. See the roadmap in
  `docs/superpowers/specs/2026-10-30-web-band-scanner-design.md`.
- RTL-SDR support covers the R820T, R820T2 and R828D tuners. Below 24 MHz it needs
  an RTL-SDR Blog V4, because direct sampling isn't supported yet.
- RTL-SDR runs at 2.4 MS/s and HackRF at 4.8 MS/s.
- Signal strength shows as dBFS and dB over noise, not S-units, because the web
  version has no calibration.
- HackRF's RF amp and antenna power, and the RTL-SDR bias tee, are always off.

## Development

```sh
npm test            # unit tests
npm run typecheck
npm run build
```

`src/scan/` holds the scan loop and stop rule, `src/dsp/` the demodulators,
`src/decoders/` APRS, `src/radio/` the USB drivers and demo radio, `src/app/` the
multi-radio logic and saving, and `src/ui/` the screen. Each radio runs in its own
Web Worker (`src/worker/`).

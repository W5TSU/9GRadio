import type { RadioInfo } from './types';

/** Turns a browser USB error into what the user can do about it. */
export function explainUsbError(error: unknown, kind: RadioInfo['kind'] | 'unknown'): string {
  const e = error instanceof Error ? error : new Error(String(error));
  const permission = 'The browser was refused access. On Linux, install the udev permissions file in web/README.md, then unplug the radio and plug it back in.';

  if (e.name === 'SecurityError' || /access denied|failed to open/i.test(e.message)) return permission;
  if (/claim interface/i.test(e.message)) {
    if (kind === 'rtlsdr') {
      return 'Something else is using this dongle. On Linux that is usually the TV driver: run "sudo modprobe -r dvb_usb_rtl28xxu". If not, close any other program using the radio.';
    }
    return 'Something else is using this radio. Close any other program using it, including other tabs.';
  }
  return e.message;
}

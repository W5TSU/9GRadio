/** How the page tells a radio's worker which radio to open. */
export type RadioSource =
  | { kind: 'demo'; index: number }
  | { kind: 'usb'; vendorId: number; productId: number; serial: string | null; ordinal: number };

type DeviceId = { vendorId: number; productId: number; serialNumber?: string | null };

const same = (a: DeviceId, b: DeviceId) =>
  a.vendorId === b.vendorId && a.productId === b.productId && (a.serialNumber ?? null) === (b.serialNumber ?? null);

export function sourceMatches(source: RadioSource, device: DeviceId): boolean {
  return (
    source.kind === 'usb' &&
    source.vendorId === device.vendorId &&
    source.productId === device.productId &&
    source.serial === (device.serialNumber ?? null)
  );
}

/** Cheap dongles often share a serial number, so count which one this is. */
export function sourceOrdinal<T extends DeviceId>(devices: T[], device: T): number {
  return devices.filter((d) => same(d, device)).indexOf(device);
}

export const RadioSources = {
  pick<T extends DeviceId>(devices: T[], s: { vendorId: number; productId: number; serial: string | null; ordinal: number }): T | undefined {
    const wanted = { vendorId: s.vendorId, productId: s.productId, serialNumber: s.serial };
    return devices.filter((d) => same(d, wanted))[s.ordinal];
  },
};

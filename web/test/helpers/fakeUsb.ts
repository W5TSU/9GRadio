/** A stand-in for a WebUSB device: records what a driver sends and answers its reads. */

export interface OutCall {
  request: number;
  value: number;
  index: number;
  data?: BufferSource;
}

export interface InCall {
  request: number;
  value: number;
  index: number;
  length: number;
}

export const bytes = (data?: BufferSource): number[] => {
  if (!data) return [];
  if (data instanceof ArrayBuffer) return [...new Uint8Array(data)];
  return [...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)];
};

interface Options {
  inResponse?: (call: InCall) => number[];
  onOut?: (call: OutCall) => void;
  productId?: number;
  vendorId?: number;
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
}

export class FakeUsb {
  outs: OutCall[] = [];
  ins: InCall[] = [];
  endpoints: number[] = [];
  lastLength = 0;
  configuration: number | null = null;
  claimed: number[] = [];
  opened = false;

  private pending: { resolve: (r: USBInTransferResult) => void; reject: (e: unknown) => void }[] = [];

  constructor(private readonly o: Options = {}) {}

  device(): USBDevice {
    const self = this;
    return {
      vendorId: this.o.vendorId ?? 0x1d50,
      productId: this.o.productId ?? 0x6089,
      productName: this.o.productName ?? 'Fake radio',
      manufacturerName: this.o.manufacturerName ?? 'Fake',
      serialNumber: this.o.serialNumber ?? 'FAKE123',
      get opened() {
        return self.opened;
      },
      get configuration() {
        return self.configuration === null ? null : { configurationValue: self.configuration };
      },
      async open() {
        self.opened = true;
      },
      async close() {
        self.opened = false;
      },
      async selectConfiguration(value: number) {
        self.configuration = value;
      },
      async claimInterface(n: number) {
        self.claimed.push(n);
      },
      async releaseInterface(n: number) {
        // As WebUSB does: releasing an interface aborts its pending transfers.
        self.failTransfers(new DOMException('The transfer was cancelled.', 'AbortError'));
        self.claimed = self.claimed.filter((c) => c !== n);
      },
      async controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource) {
        const call = { request: setup.request, value: setup.value, index: setup.index, data };
        self.outs.push(call);
        self.o.onOut?.(call);
        return { status: 'ok', bytesWritten: data ? bytes(data).length : 0 };
      },
      async controlTransferIn(setup: USBControlTransferParameters, length: number) {
        const call = { request: setup.request, value: setup.value, index: setup.index, length };
        self.ins.push(call);
        const answer = self.o.inResponse?.(call) ?? new Array(length).fill(0);
        return { status: 'ok', data: new DataView(Uint8Array.from(answer).buffer) };
      },
      transferIn(endpoint: number, length: number) {
        self.endpoints.push(endpoint);
        self.lastLength = length;
        return new Promise((resolve, reject) => self.pending.push({ resolve, reject }));
      },
    } as unknown as USBDevice;
  }

  inFlight() {
    return this.pending.length;
  }

  /** Completes the oldest queued bulk read with these bytes. */
  deliver(data: number[]) {
    const next = this.pending.shift();
    next?.resolve({
      status: 'ok',
      data: new DataView(Uint8Array.from(data.map((b) => b & 0xff)).buffer),
    } as USBInTransferResult);
  }

  failTransfers(error: unknown) {
    for (const p of this.pending.splice(0)) p.reject(error);
  }

  async flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
}

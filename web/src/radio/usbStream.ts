const RX_ENDPOINT = 1;
const INTERFACE = 0;

/**
 * Keeps several bulk reads queued so a slow moment in the page doesn't lose
 * samples. Stopping aborts the queue by releasing and re-claiming the interface.
 */
export class UsbStream {
  private running = false;
  private out = new Float32Array(0);

  constructor(
    private readonly device: USBDevice,
    private readonly transferBytes: number,
    private readonly queueDepth: number,
    private readonly convert: (raw: DataView, out: Float32Array) => void,
  ) {}

  get latencySamples() {
    return (this.queueDepth * this.transferBytes) / 2;
  }

  start(onIq: (iq: Float32Array) => void, onError: (error: Error) => void) {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < this.queueDepth; i++) void this.pump(onIq, onError);
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    await this.device.releaseInterface(INTERFACE);
    await this.device.claimInterface(INTERFACE);
  }

  private async pump(onIq: (iq: Float32Array) => void, onError: (error: Error) => void) {
    while (this.running) {
      let result: USBInTransferResult;
      try {
        result = await this.device.transferIn(RX_ENDPOINT, this.transferBytes);
      } catch (error) {
        if (this.running) {
          this.running = false;
          onError(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (!this.running) return;
      if (result.status !== 'ok' || !result.data) {
        this.running = false;
        onError(new Error(`USB read failed: ${result.status}`));
        return;
      }
      const values = result.data.byteLength;
      if (this.out.length !== values) this.out = new Float32Array(values);
      this.convert(result.data, this.out);
      onIq(this.out);
    }
  }
}

/** Runs async work one call at a time, in the order it was asked for. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

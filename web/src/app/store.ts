import type { PacketRecord } from './csv';
import type { HitRow } from './hitLog';

const HITS = 'hits';
const PACKETS = 'packets';
const BY_FREQ = 'byFreq';

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const finished = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

/** The hit list and every APRS packet, kept in the browser between visits. */
export class ScannerStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = '9gradio-scanner'): Promise<ScannerStore> {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(HITS, { keyPath: 'freqHz' });
      const packets = db.createObjectStore(PACKETS, { keyPath: 'id', autoIncrement: true });
      packets.createIndex(BY_FREQ, 'freqHz');
    };
    return new ScannerStore(await done(request));
  }

  close() {
    this.db.close();
  }

  async saveHit(row: HitRow) {
    const tx = this.db.transaction(HITS, 'readwrite');
    tx.objectStore(HITS).put(row);
    await finished(tx);
  }

  loadHits(): Promise<HitRow[]> {
    return done(this.db.transaction(HITS).objectStore(HITS).getAll());
  }

  /** Removes rows and the packets heard on them. */
  async deleteHits(freqs: number[]) {
    const tx = this.db.transaction([HITS, PACKETS], 'readwrite');
    const hits = tx.objectStore(HITS);
    const packets = tx.objectStore(PACKETS);
    for (const freq of freqs) {
      hits.delete(freq);
      const index = packets.index(BY_FREQ);
      const keys = await done(index.getAllKeys(freq));
      for (const key of keys) packets.delete(key);
    }
    await finished(tx);
  }

  async savePacket(record: PacketRecord) {
    const tx = this.db.transaction(PACKETS, 'readwrite');
    tx.objectStore(PACKETS).add(record);
    await finished(tx);
  }

  /** Newest first. */
  async packetsFor(freqHz: number): Promise<PacketRecord[]> {
    const list: PacketRecord[] = await done(
      this.db.transaction(PACKETS).objectStore(PACKETS).index(BY_FREQ).getAll(freqHz),
    );
    return list.sort((a, b) => b.at - a.at);
  }
}

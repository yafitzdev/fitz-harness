import { createServer } from "node:net";

export type PortAvailabilityProbe = (host: string, port: number) => Promise<boolean>;

export interface AvailablePortAllocatorOptions {
  host?: string;
  first?: number;
  last?: number;
  probe?: PortAvailabilityProbe;
}

/** Chooses a loopback port that is bindable at allocation time. The engine
 * adapter still verifies endpoint identity after launch because availability
 * checks cannot eliminate the small close-to-bind race. */
export function createAvailablePortAllocator(options: AvailablePortAllocatorOptions = {}): () => Promise<number> {
  const host = options.host ?? "127.0.0.1";
  const first = options.first ?? 19_000;
  const last = options.last ?? 19_999;
  const probe = options.probe ?? canBindPort;
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > 65_535 || first > last) {
    throw new RangeError("Port allocation range must be between 1 and 65535");
  }
  let next = first;
  return async () => {
    const capacity = last - first + 1;
    for (let attempt = 0; attempt < capacity; attempt += 1) {
      const candidate = next;
      next = next >= last ? first : next + 1;
      if (await probe(host, candidate)) return candidate;
    }
    throw new Error(`No available inference port on ${host} in ${first}-${last}`);
  };
}

async function canBindPort(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    const finish = (value: boolean, error?: Error) => {
      server.removeAllListeners();
      if (error) reject(error);
      else resolve(value);
    };
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") finish(false);
      else finish(false, error);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => finish(!error, error ?? undefined));
    });
  });
}

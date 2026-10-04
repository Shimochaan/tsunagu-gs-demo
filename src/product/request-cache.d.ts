export function peekData(url: string): any;
export function invalidateData(prefix?: string | null): void;
export function acquireData<T>(
  url: string,
  load: (signal: AbortSignal) => Promise<T>,
): { promise: Promise<T>; release(): void };

export function subscribeData(url:string, listener:()=>void):()=>void;

// Counts long-running async work (file extraction, AI calls). A restore swaps
// the whole database, so it must not happen while such work is mid-flight and
// about to write its results into whichever database is open when it resumes.

let inflight = 0;

export async function whileBusy<T>(fn: () => Promise<T>): Promise<T> {
  inflight++;
  try {
    return await fn();
  } finally {
    inflight--;
  }
}

export function isBusy(): boolean {
  return inflight > 0;
}

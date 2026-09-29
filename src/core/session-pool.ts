// Logged-in browser sessions reused across searches. Up to `size` searches of
// the same source run at once, one per slot; the rest wait in line. Each slot
// keeps its own session between uses and only recreates it when it died.
//
// An idle session is expensive: a SeatSpy one measured ~450 MB (9 processes),
// and the server stays up for days. So each slot closes its session after
// `idleMinutes` without use and reopens it on the next search (~6s, launch plus
// login), paid once per burst of searches.
export type SessionPoolOptions<S> = {
  label: string;
  size: number;
  createSession: (headless: boolean) => Promise<S>;
  isAlive: (session: S) => boolean;
  // What closing means depends on the source: one with its own browser closes
  // the browser; one on the shared Chrome closes only its tab.
  closeSession: (session: S) => Promise<void>;
  idleMinutes: number; // 0 disables idle closing
};

type Slot<S> = {
  session: Promise<S> | null;
  busy: boolean;
  idleTimer: NodeJS.Timeout | null;
};

export class SessionPool<S> {
  private slots: Slot<S>[];
  private waiting: Array<() => void> = [];

  constructor(private options: SessionPoolOptions<S>) {
    this.slots = Array.from({ length: options.size }, () => ({ session: null, busy: false, idleTimer: null }));
  }

  async acquire(): Promise<{ session: S; index: number }> {
    const freeIndex = this.slots.findIndex((slot) => !slot.busy);
    if (freeIndex === -1) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
      return this.acquire();
    }
    this.slots[freeIndex]!.busy = true;
    // Marking busy and cancelling the timer in the same synchronous block is what
    // keeps the idle close from firing on a search that is just starting.
    this.cancelIdleClose(freeIndex);
    try {
      return { session: await this.sessionOf(freeIndex), index: freeIndex };
    } catch (err) {
      // The caller got no index and cannot release it later; without this the
      // slot stays busy forever and, once all are, searches wait silently in line.
      this.release(freeIndex);
      throw err;
    }
  }

  release(index: number) {
    this.slots[index]!.busy = false;
    this.armIdleClose(index);
    this.waiting.shift()?.();
  }

  private async sessionOf(index: number): Promise<S> {
    const slot = this.slots[index]!;
    if (slot.session) {
      try {
        const session = await slot.session;
        if (this.options.isAlive(session)) return session;
      } catch {
        // The previous creation failed (e.g. the site blocked access): create a
        // new one below instead of repeating the same error.
      }
      slot.session = null;
    }

    const created = this.options.createSession(false);
    slot.session = created;
    // Otherwise a failed creation leaves the slot holding a rejected promise and
    // every later search on it fails the same way until a restart.
    created.catch(() => {
      if (slot.session === created) slot.session = null;
    });
    return created;
  }

  private armIdleClose(index: number) {
    const { idleMinutes } = this.options;
    // Negated instead of `<= 0` so NaN lands here: setTimeout(fn, NaN) fires at
    // once, and an invalid value would mean "close after every search".
    if (!(idleMinutes > 0)) return;
    const slot = this.slots[index]!;
    this.cancelIdleClose(index);
    slot.idleTimer = setTimeout(() => void this.closeIdle(index), idleMinutes * 60_000);
    // Without unref an idle slot keeps the process alive on its own.
    slot.idleTimer.unref();
  }

  private cancelIdleClose(index: number) {
    const slot = this.slots[index]!;
    if (!slot.idleTimer) return;
    clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
  }

  private async closeIdle(index: number) {
    const slot = this.slots[index]!;
    const { label, idleMinutes } = this.options;
    slot.idleTimer = null;
    if (slot.busy || !slot.session) return;

    // Drop the reference BEFORE awaiting: a search arriving during the close
    // creates a new session instead of getting the dying one.
    const closing = slot.session;
    slot.session = null;

    const session = await closing.catch(() => null);
    if (session === null) return;

    try {
      await this.options.closeSession(session);
      console.log(`[${label}] slot ${index} ocioso há ${idleMinutes} min — sessão fechada.`);
    } catch (err) {
      // The slot is already free to recreate, but the error stays visible: if it
      // is systematic, RAM leaks.
      console.error(`[${label}] falha ao fechar a sessão ociosa do slot ${index}:`, err);
    }
  }
}

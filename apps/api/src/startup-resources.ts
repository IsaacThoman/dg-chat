export type StartupCloser = () => void | Promise<void>;

/**
 * Owns resources until the HTTP server has accepted them. Startup failures close every acquired
 * resource in reverse order; one broken closer never prevents the remaining cleanup.
 */
export class StartupResourceOwner {
  readonly #closers: StartupCloser[] = [];
  #active = true;

  defer(closer: StartupCloser): () => void {
    if (!this.#active) throw new Error("Startup resource ownership has ended");
    this.#closers.push(closer);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      const index = this.#closers.indexOf(closer);
      if (index >= 0) this.#closers.splice(index, 1);
    };
  }

  release(): void {
    this.#active = false;
    this.#closers.length = 0;
  }

  async close(): Promise<unknown[]> {
    if (!this.#active) return [];
    this.#active = false;
    const errors: unknown[] = [];
    for (const closer of this.#closers.reverse()) {
      try {
        await closer();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#closers.length = 0;
    return errors;
  }
}

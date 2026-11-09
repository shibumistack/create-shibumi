// Shared cancellation and subprocess lifetime for the opt-in E2E runners.
export class E2EProcesses {
  private signal?: string;
  private cleaning = false;
  unsafe = false; // A group needed forced termination; nested groups may need manual recovery.
  private children = new Set<ReturnType<typeof Bun.spawn>>();

  constructor() {
    for (const name of ["SIGINT", "SIGTERM"] as const) process.on(name, () => {
      if (this.signal) return;
      this.signal = name;
      process.exitCode = name === "SIGINT" ? 130 : 143;
      if (!this.cleaning) for (const child of this.children) this.killGroup(child, "SIGTERM");
    });
  }

  get cancelled() { return this.signal !== undefined; }
  get exitCode() { return this.signal === "SIGINT" ? 130 : 143; }
  check() { if (this.signal && !this.cleaning) throw new Error(`Interrupted by ${this.signal}`); }
  cleanup() { this.cleaning = true; }
  resumeWork() { this.cleaning = false; }

  spawn(args: string[], options: Parameters<typeof Bun.spawn>[1]) {
    this.check();
    const child = Bun.spawn(args, { ...options, detached: true });
    this.children.add(child);
    return child;
  }

  private killGroup(child: ReturnType<typeof Bun.spawn>, signal: "SIGTERM" | "SIGKILL") {
    try { process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  async stop(child: ReturnType<typeof Bun.spawn>) {
    this.killGroup(child, "SIGTERM");
    // Give a nested E2E runner time to stop its own detached children and close
    // its browser session before forcing the group down.
    let expired!: () => void;
    const deadline = new Promise<void>(resolve => { expired = resolve; });
    const timer = setTimeout(expired, 30_000);
    try {
      const forced = await Promise.race([child.exited.then(() => false), deadline.then(() => true)]);
      if (forced) this.unsafe = true;
    } finally { clearTimeout(timer); this.killGroup(child, "SIGKILL"); await child.exited; this.children.delete(child); }
  }

  async run(args: string[], options: Parameters<typeof Bun.spawn>[1], timeout = 15 * 60_000) {
    const child = this.spawn(args, options);
    let timedOut = false;
    let aborted = false;
    let resolveAbort!: () => void;
    const cancelled = new Promise<void>(resolve => { resolveAbort = resolve; });
    const onSignal = () => { aborted = true; resolveAbort(); };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    // Read pipes concurrently; on timeout/cancel stop the whole group, not just Bun.
    const output = Promise.all([child.exited, new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()]);
    const timer = setTimeout(() => { timedOut = true; resolveAbort(); }, timeout);
    try {
      if (this.cancelled && !this.cleaning) onSignal();
      if (await Promise.race([output.then(() => false), cancelled.then(() => true)])) {
        await this.stop(child);
        // Descendants may hold stdout/stderr open briefly after their leader exits.
        await output;
      }
      const result = await output;
      if (timedOut) throw new Error(`${args[0]} timed out`);
      if (aborted) this.check();
      this.check();
      return result;
    } finally {
      clearTimeout(timer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      this.children.delete(child);
    }
  }
}

import type { LogTag, Logger } from './contracts';

const RING_CAPACITY = 4096;

interface LogEntry {
  cycle: string;
  tag: LogTag;
  msg: string;
}

export class RingLogger implements Logger {
  private readonly ring: Array<LogEntry> = [];
  private stamp = 0n;
  private readonly counters = new Map<LogTag, number>();
  private readonly errors = new Map<LogTag, number>();

  setStamp(cycles: bigint): void {
    this.stamp = cycles;
  }

  debug(tag: LogTag, msg: string): void {
    this.push(tag, msg);
  }

  warn(tag: LogTag, msg: string): void {
    this.errors.set(tag, (this.errors.get(tag) ?? 0) + 1);
    this.push(tag, msg);
  }

  error(tag: LogTag, msg: string): void {
    this.errors.set(tag, (this.errors.get(tag) ?? 0) + 1);
    this.push(tag, msg);
  }

  dump(limit: number): string {
    const start = Math.max(0, this.ring.length - limit);
    const lines: Array<string> = [];
    for (const e of this.ring.slice(start)) {
      lines.push(`[cy${e.cycle}] ${e.tag}: ${e.msg}`);
    }

    return lines.join('\n');
  }

  stats(): string {
    const parts: Array<string> = [];
    for (const [tag, n] of this.counters) {
      parts.push(`${tag}=${n}`);
    }

    return parts.join(' ');
  }

  private push(tag: LogTag, msg: string): void {
    const oldest = this.counters.keys().next().value;
    if (this.counters.size >= 64 && oldest !== undefined) {
      this.counters.delete(oldest);
    }
    this.counters.set(tag, (this.counters.get(tag) ?? 0) + 1);
    this.ring.push({ cycle: this.stamp.toString(), tag, msg });
    if (this.ring.length > RING_CAPACITY) {
      this.ring.shift();
    }
  }
}
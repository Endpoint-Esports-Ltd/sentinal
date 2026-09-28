/**
 * Event Buffer — sliding window of recent tool events used by the capture
 * heuristics to detect sequences like error → fix.
 *
 * ⛔ Bundled into the OpenCode plugin via `capture.ts` — keep imports local.
 */

import {
  isErrorEvent,
  type CaptureConsumer,
  type ToolEvent,
} from "./capture-patterns.js";

export interface ErrorWindowOptions {
  /** The event being analysed — excluded from its own window. */
  exclude?: ToolEvent;
  /** Whose consumption to honour (default "fix"). */
  consumer?: CaptureConsumer;
}

/**
 * Sliding window of recent tool events for pattern detection.
 * Maintains the last N events per session to detect sequences
 * like error → fix.
 */
export class EventBuffer {
  private events: ToolEvent[] = [];
  private maxSize: number;

  constructor(maxSize: number = 20) {
    this.maxSize = maxSize;
  }

  push(event: ToolEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  /**
   * Get recent events (most recent first). `exclude` drops the event being
   * analysed — callers push it before analysing, and it is never its own
   * predecessor.
   */
  recent(count: number = 5, exclude?: ToolEvent): ToolEvent[] {
    const pool = exclude
      ? this.events.filter((e) => e !== exclude)
      : this.events;
    return pool.slice(-count).reverse();
  }

  /**
   * Unconsumed errors among the last `windowSize` PRIOR events, most recent
   * first. `consumer` (default "fix") selects whose consumption is honoured.
   */
  recentErrors(
    windowSize: number = 3,
    opts: ErrorWindowOptions = {},
  ): ToolEvent[] {
    const consumer = opts.consumer ?? "fix";
    return this.recent(windowSize, opts.exclude).filter(
      (e) => isErrorEvent(e) && !e.consumedBy?.includes(consumer),
    );
  }

  /** The most recent unconsumed error in the window, or null. */
  hasRecentError(
    windowSize: number = 3,
    opts: ErrorWindowOptions = {},
  ): ToolEvent | null {
    return this.recentErrors(windowSize, opts)[0] ?? null;
  }

  clear(): void {
    this.events = [];
  }

  get size(): number {
    return this.events.length;
  }
}

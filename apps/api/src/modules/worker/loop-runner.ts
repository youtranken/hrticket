import { Logger } from '@nestjs/common';
import { beat } from './heartbeat';

export interface Loop {
  name: string;
  intervalMs: number;
  tick: () => Promise<void>;
}

/**
 * Runs one loop independently: tick → heartbeat → reschedule. A throwing tick is
 * caught and recorded (status=error) but the loop keeps its cadence — so one loop
 * crashing never wedges the others (Story 2.7 AC1). Returns a stop function.
 */
export function startLoop(loop: Loop, logger: Logger): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (): Promise<void> => {
    if (stopped) return;
    try {
      await loop.tick();
      await beat(loop.name, 'ok');
    } catch (e) {
      logger.error(`loop ${loop.name} failed: ${(e as Error)?.message}`);
      await beat(loop.name, 'error').catch(() => undefined);
    } finally {
      if (!stopped) timer = setTimeout(() => void run(), loop.intervalMs);
    }
  };

  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

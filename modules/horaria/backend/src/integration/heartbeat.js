import { heartbeatHandler } from '../controllers/whatsapp.js';
import { saveState } from './durable-state.js';
import { requireDelivery } from './providers.js';

/** Opt-in product scheduler. Shop settings decide due collection/reminder windows. */
export function startHeartbeat() {
  if (process.env.HORARIA_ALLOW_AUTOMATIC !== '1') return () => {};
  requireDelivery();
  if (!process.env.WEEKLY_REMINDER_SECRET) throw new Error('WEEKLY_REMINDER_SECRET is required');
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    let status = 200;
    try {
      await heartbeatHandler({ body: {}, query: {}, get: name => name === 'x-reminder-secret' ? process.env.WEEKLY_REMINDER_SECRET : undefined }, {
        status(code) { status = code; return this; },
        json() { saveState('heartbeat.json', { completedAt: new Date().toISOString(), status }); return this; },
      });
    } catch { saveState('heartbeat.json', { completedAt: new Date().toISOString(), status: 500 }); }
    finally { running = false; }
  };
  const timer = setInterval(tick, 60_000);
  void tick();
  return () => clearInterval(timer);
}

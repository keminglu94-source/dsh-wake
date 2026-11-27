import { normalizeConfig } from './config.js';
import { WakeStore } from './store.js';
import { WakeScheduler } from './scheduler.js';
import { buildWakeTool } from './tool.js';
import { WAKE_SOURCE_KIND } from './message.js';

export const name = 'dsh-wake';
export const inject = ['agents'];
export { WAKE_SOURCE_KIND };
export { Config } from './schema.js';

function makeLogger(ctx) {
	return (level, message) => {
		try { ctx?.logger?.[level === 'debug' ? 'debug' : level]?.(message); } catch { /* logger is optional */ }
	};
}

/**
 * Minimal plugin boundary:
 *   - schedules one same-session wake job at a time;
 *   - injects source.kind='heartbeat' into that session;
 *   - leaves what happens after waking entirely to the model.
 */
export function apply(ctx, baseConfig = {}) {
	const config = normalizeConfig(baseConfig);
	if (!config.enabled) return;
	const log = makeLogger(ctx);
	let store;
	try {
		store = new WakeStore(config.dataDir);
	} catch (error) {
		// A read-only / full disk must not take the whole host down.
		log('warn', `dsh-wake disabled: cannot prepare data dir (${String(error).slice(0, 160)})`);
		return;
	}
	const scheduler = new WakeScheduler({ ctx, config, store, log });
	const tool = buildWakeTool({ config, scheduler, store, log });
	let disposeTool = null;

	const register = () => {
		const bind = (tools) => {
			try {
				try { disposeTool?.(); } catch { /* previous registration is gone */ }
				disposeTool = tools.register(tool) ?? null;
			} catch (error) {
				log('warn', `wake tool register failed: ${String(error)}`);
			}
		};
		try {
			if (ctx?.tools?.register) {
				bind(ctx.tools);
				return;
			}
			ctx.inject(['tools'], (scoped) => {
				bind(scoped.tools);
			});
		} catch (error) {
			log('warn', `wake tool registration unavailable: ${String(error)}`);
		}
	};

	const start = () => {
		try {
			register();
			scheduler.start();
		} catch (error) {
			// Never let a broken jobs file / read-only dir break the host boot.
			log('warn', `dsh-wake start failed: ${String(error).slice(0, 160)}`);
		}
	};
	const stop = () => {
		scheduler.stop();
		try { disposeTool?.(); } catch { /* tool runtime is going away */ }
	};
	if (typeof ctx?.effect === 'function') ctx.effect(() => { start(); return stop; }, 'dsh-wake: scheduler');
	else start();

	log('info', `dsh-wake: ready (dir=${config.dataDir}, quiet ${config.quietStart}-${config.quietEnd}, max ${config.maxWakesPerDay}/day)`);
}

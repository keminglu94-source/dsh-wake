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
	// [本地自检] 宿主日志看不到，就自己记一笔，判断 apply() 到底有没有被调用
	const diag = (stage, extra = {}) => {
		try {
			const fsm = process.getBuiltinModule ? process.getBuiltinModule('node:fs') : null;
			if (!fsm) return;
			fsm.appendFileSync('D:/feiyu/wake-boot.log', JSON.stringify({
				at: new Date().toISOString(),
				pid: process.pid,
				stage,
				hasCtx: !!ctx,
				hasTools: !!ctx?.tools,
				hasRegister: typeof ctx?.tools?.register === 'function',
				...extra
			}) + '\n');
		} catch { /* 自检失败不影响正事 */ }
	};
	diag('apply-enter', { hasEnabled: baseConfig?.enabled, dataDir: baseConfig?.dataDir ?? '' });
	const config = normalizeConfig(baseConfig);
	if (!config.enabled) return;
	const log = makeLogger(ctx);
	let store;
	try {
		store = new WakeStore(config.dataDir);
	} catch (error) {
		// A read-only / full disk must not take the whole host down.
		log('warn', `dsh-wake disabled: cannot prepare data dir (${String(error).slice(0, 160)})`);
		diag('store-fail', { error: String(error).slice(0, 200) });
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
				diag('register-ok', { hasDispose: disposeTool !== null });
			} catch (error) {
				log('warn', `wake tool register failed: ${String(error)}`);
				diag('register-fail', { error: String(error).slice(0, 200) });
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
	diag('apply-ready', { dataDir: config.dataDir, maxPerDay: config.maxWakesPerDay });
}

/* [自检] 模块被 import 时就写一行，用来区分"没加载"和"加载了但 apply 没跑" */
try {
	const fsm = process.getBuiltinModule ? process.getBuiltinModule('node:fs') : null;
	if (fsm) fsm.appendFileSync('D:/feiyu/wake-boot.log', JSON.stringify({
		at: new Date().toISOString(),
		pid: process.pid,
		stage: 'module-import',
		argv: process.argv.slice(0, 3).join(' ')
	}) + '\n');
} catch { /* 自检失败不影响加载 */ }

/**
 * Settings schema for the DSH settings UI.
 *
 * `@deepseek-ai/schemastery` is a peer of every real DSH host, but the plugin
 * must still load on a bare Node test setup: when the module is unavailable we
 * export `undefined` (the same pattern fish-soul uses) and the apply-time
 * `normalizeConfig` remains the only source of truth.
 */
let Config;
try {
	const schemastery = await import('@deepseek-ai/schemastery');
	const z = schemastery.default ?? schemastery;
	Config = z.object({
		enabled: z.boolean().default(true)
			.description('关掉后不注册 wake_create，也不调度任何唤醒。'),
		dataDir: z.string().default('')
			.description('任务与计数文件目录；留空 = <DSH_HOME>/dsh-wake。'),
		quietStart: z.string().default('01:00')
			.description('静默时段开始（宿主本地时间，HH:mm，24 小时制）。'),
		quietEnd: z.string().default('08:00')
			.description('静默时段结束（宿主本地时间，HH:mm，24 小时制）。'),
		maxWakesPerDay: z.number().step(1).min(0).max(10000).default(8)
			.description('每天最多成功醒来几次；0 = 禁止唤醒。'),
		minAfterMinutes: z.number().step(1).min(1).max(1440).default(1)
			.description('wake_create 允许的最小提前分钟数。'),
		maxAfterMinutes: z.number().step(1).min(1).max(10080).default(1440)
			.description('wake_create 允许的最大提前分钟数。'),
		maxOverdueMinutes: z.number().step(1).min(0).max(10080).default(180)
			.description('任务超过这个分钟数还没下发就跳过；0 = 不检查。'),
		idleWaitMs: z.number().step(1).min(0).max(3600000).default(600000)
			.description('唤醒后等待该回合结束的上限；0 = 不等待。'),
		intentMaxChars: z.number().step(1).min(1).max(2000).default(500)
			.description('goal 最多保留多少字符。'),
	});
} catch {
	Config = undefined;
}

export { Config };

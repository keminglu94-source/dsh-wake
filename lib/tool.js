import { localDateKey, localTimeLabel, isQuietTime } from './time.js';
import { selectedPresetId, sessionEvents } from './scheduler.js';

export function sessionIdOf(exec) {
	try {
		return String(
			exec?.agent?.session?.id ?? exec?.agent?.id ?? exec?.sessionId ?? exec?.session?.id ?? '',
		).trim();
	} catch {
		return '';
	}
}

export function buildWakeTool({ config, scheduler, store, log = () => {}, now = () => new Date() }) {
	const capText = config.maxWakesPerDay === 0
		? '当前配置禁止唤醒（maxWakesPerDay=0）'
		: `全局每天最多 ${config.maxWakesPerDay} 次`;
	return {
		name: 'wake_create',
		description:
			'安排在同一个已有会话里发生一次后台心跳唤醒。' +
			`只允许 ${config.minAfterMinutes}～${config.maxAfterMinutes} 分钟后；` +
			`${capText}；` +
			`${config.quietStart}～${config.quietEnd} 是静默时段，不能安排。` +
			'唤醒后模型可以自行决定做什么；需要下一次唤醒时再次调用本工具。',
		parameters: {
			type: 'object',
			properties: {
				afterMinutes: {
					type: 'number',
					description: `多少分钟后唤醒（${config.minAfterMinutes}～${config.maxAfterMinutes}）`,
				},
				goal: {
					type: 'string',
					description: '下次醒来时想继续做什么；可以不填',
				},
			},
			required: ['afterMinutes'],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					message: { type: 'string' },
				},
				required: ['ok', 'message'],
				additionalProperties: false,
			},
			render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
		},
		timeoutMs: 5000,
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const sessionId = sessionIdOf(exec);
			if (sessionId === '') return { ok: false, message: 'wake_create 只能在具体会话里调用' };
			if (config.maxWakesPerDay === 0) {
				return { ok: false, message: '当前配置禁止唤醒（maxWakesPerDay=0）' };
			}
			const current = now();
			if (isQuietTime(current, config.quietStart, config.quietEnd)) {
				return {
					ok: false,
					message: `现在是 ${localTimeLabel(current)}，${config.quietStart}～${config.quietEnd} 是静默时段，不能创建唤醒任务`,
				};
			}
			const minutes = Number(args?.afterMinutes);
			if (!Number.isFinite(minutes) || minutes < config.minAfterMinutes || minutes > config.maxAfterMinutes) {
				return {
					ok: false,
					message: `afterMinutes 必须在 ${config.minAfterMinutes}～${config.maxAfterMinutes} 分钟之间`,
				};
			}
			// Never wake earlier than requested: round fractional minutes up.
			const wholeMinutes = Math.ceil(minutes);
			const next = new Date(current.getTime() + wholeMinutes * 60_000);
			if (isQuietTime(next, config.quietStart, config.quietEnd)) {
				return {
					ok: false,
					message: `下一次唤醒会落在静默时段 ${config.quietStart}～${config.quietEnd}，未安排`,
				};
			}
			// The cap belongs to the day the wake actually happens, not the day
			// it was scheduled. A 23:50 wake for 30 minutes later is tomorrow's
			// budget and must not be rejected by today's exhausted cap.
			const sameDay = localDateKey(next) === localDateKey(current);
			const used = sameDay ? store.todayCount(current) : 0;
			if (sameDay && used >= config.maxWakesPerDay) {
				return { ok: false, message: `今天全局已经醒来 ${config.maxWakesPerDay} 次，达到上限` };
			}
			const result = scheduler.schedule({
				sessionId,
				afterMinutes: wholeMinutes,
				goal: String(args?.goal ?? '').trim(),
				presetId: selectedPresetId(sessionEvents(exec?.agent?.session)) ?? '',
				now: current,
			});
			if (!result.ok) {
				return { ok: false, message: result.error === 'session-is-waking' ? '这个会话正在唤醒，稍后再安排' : '没有安排成功' };
			}
			const at = new Date(result.job.nextAt);
			return {
				ok: true,
				message:
					`已安排 ${localTimeLabel(at)} 在这个会话醒来（${localDateKey(at)}）；` +
					`${localDateKey(at)} 还剩 ${Math.max(0, config.maxWakesPerDay - used - 1)} 次唤醒额度`,
			};
		},
	};
}

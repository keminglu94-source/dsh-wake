import { localTimeLabel } from './time.js';

export const WAKE_SOURCE_KIND = 'heartbeat';

/**
 * The wake message deliberately identifies itself as a machine heartbeat.
 * Do not use source.kind='user': consumers such as fish-soul would treat it
 * as a human message and may journal or answer it as one.
 */
export async function createWakeMessage(prompt, meta = {}) {
	const content = [{ type: 'text', text: String(prompt ?? '') }];
	const source = {
		kind: WAKE_SOURCE_KIND,
		plugin: 'dsh-wake',
		form: 'wake',
		...(meta.wakeId ? { wakeId: String(meta.wakeId) } : {}),
		sections: [{ name: 'heartbeat', text: 'wake' }],
	};
	// Do not hand-roll a message object when dsh-llm is missing. createUserMessage
	// assigns the message id and the rest of the host envelope; a spliced object
	// without them can corrupt the persisted session (the same reason
	// dsh-heartbeat refuses to splice messages). A failure here is retried by
	// the scheduler as a pre-submit failure.
	const mod = await import('@deepseek-ai/dsh-llm');
	if (typeof mod?.createUserMessage !== 'function') {
		throw new Error('@deepseek-ai/dsh-llm createUserMessage unavailable');
	}
	return mod.createUserMessage({ content, source });
}

export function buildWakePrompt({
	goal = '',
	now = new Date(),
	maxChars = 500,
	quietStart = '',
	quietEnd = '',
} = {}) {
	const limit = Number.isFinite(Number(maxChars)) ? Math.max(1, Math.floor(Number(maxChars))) : 500;
	const intent = String(goal ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
	return [
		'[后台心跳唤醒]',
		`现在是 ${localTimeLabel(now)}。这是同一个会话的后台心跳，不是用户刚发来的消息。`,
		'你可以自行决定接下来做什么：继续之前的事情、整理状态、调用可用的工具，或者什么都不做。',
		'不要假装用户刚刚说过话，也不要为了回应心跳而强行发送消息。',
		`${intent ? `这次醒来的目标：${intent}` : '这次醒来没有预设目标。'}`,
		`${quietStart && quietEnd ? `如果下一次会落在静默时段 ${quietStart}～${quietEnd}，wake_create 会失败，请改到窗口之后。` : ''}`,
		'如果需要下一次唤醒，在你的回合中调用 wake_create，传入 afterMinutes 和可选的 goal；不需要就不调用。',
	].filter((line) => line !== '').join('\n');
}

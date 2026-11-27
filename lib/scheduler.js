import { randomUUID } from 'node:crypto';
import { isQuietTime } from './time.js';
import { buildWakePrompt, createWakeMessage } from './message.js';

const RETRY_DELAYS_MS = [30_000, 120_000];
const MAX_DISPATCH_RETRIES = 2;
const ACTIVE_STATUSES = new Set(['scheduled', 'dispatching']);
const RESUME_TIMEOUT_MS = 30_000;
const PRESET_TIMEOUT_MS = 10_000;
const FLUSH_TIMEOUT_MS = 5_000;

async function withTimeout(promise, ms, label) {
	let timer;
	try {
		return await Promise.race([
			Promise.resolve(promise),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function agentFromHandle(handle) {
	return handle?.agent ?? handle ?? null;
}

/** Read a session's event log across harness versions. Mirrors the accessor
 * used by dsh-heartbeat so the wake plugin works on 0.1.x and 0.2.x hosts. */
export function sessionEvents(session) {
	if (!session) return [];
	if (typeof session.snapshotEvents === 'function') {
		try {
			const snapshot = session.snapshotEvents();
			if (Array.isArray(snapshot)) return snapshot;
		} catch { /* fall through to the legacy accessor */ }
	}
	return Array.isArray(session.events) ? session.events : [];
}

/** Which agent preset the target session joined, read from its own log. */
export function selectedPresetId(events) {
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const event = events[i];
		if (event?.type !== 'agent-preset/selected') continue;
		const id = event.data?.agentPreset;
		if (typeof id === 'string' && id.trim() !== '') return id.trim();
	}
	return undefined;
}

function defaultAgentOptions(ctx) {
	try {
		const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.();
		if (!selection?.provider || !selection?.model) return undefined;
		return {
			provider: selection.provider,
			model: selection.model,
			...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
		};
	} catch {
		return undefined;
	}
}

/** Re-attach the preset the resumed session had joined.
 *
 * `agents.resume()` without `setup` returns a bare agent: global tools only,
 * no persona/memory sections. Re-mounting the recorded preset is what makes
 * the wake turn look like the session's own turn (this is exactly what
 * dsh-heartbeat does before delivering into a target session). Best effort:
 * a host without the presets service falls back to bare behaviour. */
async function mountPreset(agent, log, fallbackPresetId = '') {
	try {
		const presetId = selectedPresetId(sessionEvents(agent?.session)) || String(fallbackPresetId ?? '').trim() || undefined;
		if (presetId === undefined) return 'none';
		const agentCtx = agent?.ctx;
		if (!agentCtx || typeof agentCtx.get !== 'function') return 'ctx-missing';
		const presets = agentCtx.get('agentPresets');
		if (typeof presets?.mount !== 'function') return 'no-api';
		await withTimeout(presets.mount(agentCtx, presetId), PRESET_TIMEOUT_MS, 'agentPresets.mount');
		return `ok(${presetId})`;
	} catch (error) {
		log('warn', `wake preset mount failed: ${String(error).slice(0, 160)}`);
		return 'threw';
	}
}

export class WakeScheduler {
	constructor({
		ctx,
		config,
		store,
		log = () => {},
		timers = true,
		now = () => new Date(),
		createMessage = createWakeMessage,
	}) {
		this.ctx = ctx;
		this.config = config;
		this.store = store;
		this.log = log;
		this.timers = timers;
		this.now = now;
		this.createMessage = createMessage;
		this.timersBySession = new Map();
		this.running = false;
	}

	start() {
		if (this.running) return;
		this.running = true;
		const now = this.now().getTime();
		for (const job of this.store.loadJobs()) {
			if (!job?.sessionId) continue;
			if (job.status === 'dispatching') {
				// The process died while a wake was being submitted. The message may
				// already be in the session, so never retry: waking twice is worse
				// than missing one heartbeat.
				job.status = 'unknown';
				job.lastError = 'process-restarted-during-dispatch';
				job.updatedAt = Date.now();
				this.saveJob(job);
				this.log('warn', `wake found dispatching at startup, marked unknown: ${job.sessionId}`);
				continue;
			}
			if (job.status !== 'scheduled') continue;
			if (this.isOverdue(job, now)) {
				job.status = 'missed';
				job.lastError = 'overdue';
				job.updatedAt = now;
				this.saveJob(job);
				this.log('info', `wake skipped as overdue: ${job.sessionId}`);
				continue;
			}
			this.arm(job);
		}
	}

	isOverdue(job, now = this.now().getTime()) {
		if (!(this.config.maxOverdueMinutes > 0)) return false;
		return now - Number(job?.nextAt) > this.config.maxOverdueMinutes * 60_000;
	}

	stop() {
		this.running = false;
		for (const timer of this.timersBySession.values()) clearTimeout(timer);
		this.timersBySession.clear();
	}

	clearSessionTimer(sessionId) {
		const timer = this.timersBySession.get(sessionId);
		if (timer) clearTimeout(timer);
		this.timersBySession.delete(sessionId);
	}

	arm(job) {
		if (!this.timers || !this.running || !job?.sessionId) return;
		this.clearSessionTimer(job.sessionId);
		const delay = Math.max(0, Number(job.nextAt) - this.now().getTime());
		const timer = setTimeout(() => {
			this.timersBySession.delete(job.sessionId);
			void this.dispatchJob(job.id).catch((error) => this.log('warn', `wake dispatch error: ${String(error)}`));
		}, delay);
		timer.unref?.();
		this.timersBySession.set(job.sessionId, timer);
	}

	schedule({ sessionId, afterMinutes, goal = '', presetId = '', now = this.now() }) {
		const sid = String(sessionId ?? '').trim();
		if (sid === '') return { ok: false, error: 'missing-session' };
		const jobs = this.store.loadJobs();
		const existing = jobs.find((job) => job.sessionId === sid && ACTIVE_STATUSES.has(job.status));
		if (existing?.status === 'dispatching') {
			return { ok: false, error: 'session-is-waking' };
		}
		// A wake turn may schedule the next wake from a resumed, compacted
		// session whose preset event is gone. Inherit the last known preset id.
		const previousPreset = [...jobs].reverse().find((job) => job.sessionId === sid && job.presetId)?.presetId;
		const nextAt = new Date(now).getTime() + Number(afterMinutes) * 60_000;
		const job = {
			id: randomUUID(),
			sessionId: sid,
			goal: String(goal ?? '').trim().slice(0, this.config.intentMaxChars),
			// Captured at scheduling time as a fallback for when the session log
			// has been compacted past its agent-preset/selected event by wake time.
			presetId: String(presetId ?? '').trim() || String(previousPreset ?? '').trim(),
			nextAt,
			status: 'scheduled',
			attempts: 0,
			createdAt: new Date(now).getTime(),
			updatedAt: new Date(now).getTime(),
			lastError: '',
		};
		const kept = jobs.filter((item) => !(item.sessionId === sid && ACTIVE_STATUSES.has(item.status)));
		kept.push(job);
		this.store.saveJobs(kept);
		this.arm(job);
		return { ok: true, job };
	}

	async acquireAgent(sessionId, presetId = '') {
		let existing = null;
		try { existing = this.ctx?.agents?.get?.(sessionId) ?? null; } catch { existing = null; }
		if (existing && typeof existing.followup === 'function') {
			return { agent: existing, release: () => {}, resumed: false };
		}
		if (typeof this.ctx?.agents?.resume !== 'function') return null;
		try {
			const agentOptions = defaultAgentOptions(this.ctx);
			const handle = await withTimeout(
				this.ctx.agents.resume({
					resumeSessionId: sessionId,
					...(agentOptions === undefined ? {} : { agentOptions }),
				}),
				RESUME_TIMEOUT_MS,
				'agents.resume',
			);
			const agent = agentFromHandle(handle);
			if (!agent || typeof agent.followup !== 'function') return null;
			// The resumed agent is bare by construction; put the session's own
			// preset back before the wake turn runs.
			const preset = await mountPreset(agent, this.log, presetId);
			this.log('info', `wake resumed session ${sessionId} (preset=${preset})`);
			return {
				agent,
				resumed: true,
				release: () => {
					try { handle?.dispose?.(); } catch { /* best effort */ }
				},
			};
		} catch (error) {
			this.log('debug', `wake resume failed for ${sessionId}: ${String(error)}`);
			return null;
		}
	}

	async flush(agent) {
		try {
			const store = typeof this.ctx?.get === 'function' ? this.ctx.get('sessions') : this.ctx?.sessions;
			await withTimeout(store?.flush?.(agent?.session), FLUSH_TIMEOUT_MS, 'sessions.flush');
		} catch { /* the message is already in the inbox; flush is best effort */ }
	}

	async waitIdle(agent) {
		if (!(this.config.idleWaitMs > 0) || typeof agent?.whenIdle !== 'function') return true;
		let timer;
		try {
			await Promise.race([
				Promise.resolve(agent.whenIdle()),
				new Promise((resolve) => { timer = setTimeout(resolve, this.config.idleWaitMs); timer.unref?.(); }),
			]);
			return true;
		} catch {
			return false;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	saveJob(job) {
		const jobs = this.store.loadJobs();
		const index = jobs.findIndex((item) => item.id === job.id);
		if (index >= 0) jobs[index] = job;
		else jobs.push(job);
		this.store.saveJobs(jobs);
	}

	removeJob(id) {
		this.store.saveJobs(this.store.loadJobs().filter((job) => job.id !== id));
	}

	async dispatchJob(id) {
		const jobs = this.store.loadJobs();
		const job = jobs.find((item) => item.id === id);
		if (!job || !ACTIVE_STATUSES.has(job.status)) return { ok: false, skipped: true };
		// The timer path can only fire once per job, but a manual/stray second
		// call must not submit the same wake twice.
		if (job.status === 'dispatching') return { ok: false, skipped: true, error: 'already-dispatching' };
		const now = this.now();
		if (this.isOverdue(job, now.getTime())) {
			job.status = 'missed';
			job.lastError = 'overdue';
			job.updatedAt = Date.now();
			this.saveJob(job);
			this.log('info', `wake skipped as overdue: ${job.sessionId}`);
			return { ok: false, error: 'overdue' };
		}
		if (isQuietTime(now, this.config.quietStart, this.config.quietEnd)) {
			job.status = 'failed';
			job.lastError = 'quiet-hours';
			job.updatedAt = Date.now();
			this.saveJob(job);
			this.log('info', `wake skipped in quiet hours: ${job.sessionId}`);
			return { ok: false, error: 'quiet-hours' };
		}
		if (this.store.todayCount(now) >= this.config.maxWakesPerDay) {
			job.status = 'failed';
			job.lastError = 'daily-cap';
			job.updatedAt = Date.now();
			this.saveJob(job);
			this.log('info', `wake skipped at daily cap: ${job.sessionId}`);
			return { ok: false, error: 'daily-cap' };
		}

		job.status = 'dispatching';
		job.updatedAt = Date.now();
		this.saveJob(job);
		let acquired = null;
		let submitted = false;
		try {
			acquired = await this.acquireAgent(job.sessionId, job.presetId);
			if (!acquired?.agent) throw new Error('session agent unavailable');
			const message = await this.createMessage(buildWakePrompt({
				goal: job.goal,
				now,
				maxChars: this.config.intentMaxChars,
				quietStart: this.config.quietStart,
				quietEnd: this.config.quietEnd,
			}), { wakeId: job.id });
			submitted = true;
			acquired.agent.followup(message);
			this.store.incrementToday(now);
			await this.flush(acquired.agent);
			job.status = 'delivered';
			job.deliveredAt = Date.now();
			job.updatedAt = Date.now();
			this.saveJob(job);
			this.log('info', `wake delivered: ${job.sessionId}`);
			await this.waitIdle(acquired.agent);
			return { ok: true, job };
		} catch (error) {
			const message = String(error?.message ?? error).slice(0, 200);
			if (submitted) {
				// followup may already have appended the wake message. Never retry
				// an uncertain submission: that would wake/inject twice.
				job.status = 'unknown';
				job.lastError = `submitted-unknown: ${message}`;
				job.updatedAt = Date.now();
				this.saveJob(job);
				this.log('warn', `wake submission uncertain: ${job.sessionId}: ${message}`);
				return { ok: false, unknown: true, error: message };
			}
			job.attempts = Number(job.attempts ?? 0) + 1;
			job.lastError = message;
			job.updatedAt = Date.now();
			if (job.attempts <= MAX_DISPATCH_RETRIES) {
				const delay = RETRY_DELAYS_MS[job.attempts - 1] ?? RETRY_DELAYS_MS.at(-1);
				job.status = 'scheduled';
				job.nextAt = this.now().getTime() + delay;
				this.saveJob(job);
				this.arm(job);
				this.log('warn', `wake retry ${job.attempts}/${MAX_DISPATCH_RETRIES} in ${Math.round(delay / 1000)}s: ${job.sessionId}`);
				return { ok: false, retry: true, error: message };
			}
			job.status = 'failed';
			this.saveJob(job);
			this.log('warn', `wake failed after retries: ${job.sessionId}: ${message}`);
			return { ok: false, error: message };
		} finally {
			try { acquired?.release?.(); } catch { /* best effort */ }
		}
	}
}

export { MAX_DISPATCH_RETRIES };

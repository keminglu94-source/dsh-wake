import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isQuietTime, parseHhmm } from '../lib/time.js';
import { normalizeConfig } from '../lib/config.js';
import { WakeStore } from '../lib/store.js';
import { WakeScheduler } from '../lib/scheduler.js';
import { buildWakeTool, sessionIdOf } from '../lib/tool.js';

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wake-test-'));
}

test('quiet hours are host-local and support fixed 01:00-08:00', () => {
	assert.equal(parseHhmm('01:00'), 60);
	assert.equal(isQuietTime(new Date(2026, 0, 1, 0, 59), '01:00', '08:00'), false);
	assert.equal(isQuietTime(new Date(2026, 0, 1, 1, 0), '01:00', '08:00'), true);
	assert.equal(isQuietTime(new Date(2026, 0, 1, 7, 59), '01:00', '08:00'), true);
	assert.equal(isQuietTime(new Date(2026, 0, 1, 8, 0), '01:00', '08:00'), false);
});

test('session id is taken from the tool execution context, never from model args', () => {
	assert.equal(sessionIdOf({ agent: { session: { id: 's1' }, id: 'agent-1' } }), 's1');
	assert.equal(sessionIdOf({ agent: { id: 'agent-1' } }), 'agent-1');
	assert.equal(sessionIdOf({ sessionId: 's2' }), 's2');
	assert.equal(sessionIdOf({ session: { id: 's3' } }), 's3');
	assert.equal(sessionIdOf(undefined), '');
});

test('wake_create fails during quiet hours and after daily cap', async () => {
	const dir = tempDir();
	const config = normalizeConfig({ dataDir: dir, quietStart: '01:00', quietEnd: '08:00', maxWakesPerDay: 1 });
	const store = new WakeStore(dir);
	const scheduler = new WakeScheduler({ ctx: {}, config, store, timers: false });
	const tool = buildWakeTool({ config, scheduler, store, now: () => new Date(2026, 0, 1, 1, 30) });
	const quiet = await tool.execute({ afterMinutes: 30 }, { agent: { session: { id: 'session-1' } } });
	assert.equal(quiet.ok, false);
	assert.match(quiet.message, /静默时段/);

	const tool2 = buildWakeTool({ config, scheduler, store, now: () => new Date(2026, 0, 1, 10, 0) });
	const first = await tool2.execute({ afterMinutes: 30 }, { agent: { session: { id: 'session-1' } } });
	assert.equal(first.ok, true);
	store.incrementToday(new Date(2026, 0, 1, 10, 0));
	const capped = await tool2.execute({ afterMinutes: 30 }, { agent: { session: { id: 'session-1' } } });
	assert.equal(capped.ok, false);
	assert.match(capped.message, /上限/);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('maxWakesPerDay=0 disables waking and invalid quiet bounds fall back to the default window', async () => {
	const dir = tempDir();
	const config = normalizeConfig({ dataDir: dir, quietStart: 'not-a-time', maxWakesPerDay: 0 });
	assert.equal(config.quietStart, '01:00');
	assert.equal(config.quietEnd, '08:00');
	const store = new WakeStore(dir);
	const scheduler = new WakeScheduler({ ctx: {}, config, store, timers: false });
	const tool = buildWakeTool({ config, scheduler, store, now: () => new Date(2026, 0, 1, 10, 0) });
	const result = await tool.execute({ afterMinutes: 30 }, { agent: { session: { id: 'session-1' } } });
	assert.equal(result.ok, false);
	assert.match(result.message, /禁止唤醒/);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('dispatch retries a pre-submit failure at most twice', async () => {
	const dir = tempDir();
	const config = normalizeConfig({ dataDir: dir, maxWakesPerDay: 10, idleWaitMs: 0 });
	const store = new WakeStore(dir);
	let followups = 0;
	let resumes = 0;
	const agent = { followup: () => { followups += 1; } };
	const ctx = {
		agents: {
			get: () => null,
			resume: async () => {
				resumes += 1;
				if (resumes < 3) throw new Error('agent not ready');
				return { agent };
			},
		},
		get: () => undefined,
	};
	const scheduler = new WakeScheduler({
		ctx, config, store, timers: false,
		createMessage: async () => ({ role: 'user', content: [] }),
	});
	const created = scheduler.schedule({ sessionId: 'session-1', afterMinutes: 1, now: new Date() });
	assert.equal(created.ok, true);
	const jobId = created.job.id;
	const first = await scheduler.dispatchJob(jobId);
	assert.equal(first.retry, true);
	const second = await scheduler.dispatchJob(jobId);
	assert.equal(second.retry, true);
	const third = await scheduler.dispatchJob(jobId);
	assert.equal(third.ok, true);
	assert.equal(resumes, 3);
	assert.equal(followups, 1);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('submitted wake is not retried when followup throws after submission', async () => {
	const dir = tempDir();
	const config = normalizeConfig({ dataDir: dir, maxWakesPerDay: 10, idleWaitMs: 0 });
	const store = new WakeStore(dir);
	const agent = { followup: () => { throw new Error('connection lost'); } };
	const ctx = { agents: { get: () => agent }, get: () => undefined };
	const scheduler = new WakeScheduler({
		ctx, config, store, timers: false,
		createMessage: async () => ({ role: 'user', content: [] }),
	});
	const created = scheduler.schedule({ sessionId: 'session-1', afterMinutes: 1, now: new Date() });
	const result = await scheduler.dispatchJob(created.job.id);
	assert.equal(result.ok, false);
	assert.equal(result.unknown, true);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('resumed agents get the default model route and the session preset remounted', async () => {
	const dir = tempDir();
	const config = normalizeConfig({ dataDir: dir, maxWakesPerDay: 10, idleWaitMs: 0 });
	const store = new WakeStore(dir);
	let resumeArgs = null;
	let mounted = null;
	const agent = {
		followup: () => {},
		session: {
			snapshotEvents: () => [
				{ type: 'agent-preset/selected', data: { agentPreset: 'fish-soul' } },
			],
		},
		ctx: {
			get: (name) => (name === 'agentPresets'
				? { mount: async (_ctx, id) => { mounted = id; } }
				: undefined),
		},
	};
	const ctx = {
		agents: {
			get: () => null,
			resume: async (args) => { resumeArgs = args; return { agent }; },
		},
		get: (name) => (name === 'agentDefaultModel'
			? { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }) }
			: undefined),
	};
	const scheduler = new WakeScheduler({
		ctx, config, store, timers: false,
		createMessage: async () => ({ role: 'user', content: [] }),
	});
	const created = scheduler.schedule({ sessionId: 'session-1', afterMinutes: 1, now: new Date() });
	const result = await scheduler.dispatchJob(created.job.id);
	assert.equal(result.ok, true);
	assert.deepEqual(resumeArgs.agentOptions, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' });
	assert.equal(mounted, 'fish-soul');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('a job left dispatching by a crashed process is marked unknown and never re-sent', () => {
	const dir = tempDir();
	const config = normalizeConfig({ dataDir: dir, maxWakesPerDay: 10 });
	const store = new WakeStore(dir);
	store.saveJobs([{
		id: 'job-1', sessionId: 'session-1', nextAt: Date.now() - 1000,
		status: 'dispatching', attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), lastError: '',
	}]);
	const scheduler = new WakeScheduler({ ctx: {}, config, store, timers: false });
	scheduler.start();
	const [job] = store.loadJobs();
	assert.equal(job.status, 'unknown');
	assert.equal(job.lastError, 'process-restarted-during-dispatch');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('a scheduled job that is hours overdue is skipped instead of replayed', () => {
	const dir = tempDir();
	const config = normalizeConfig({ dataDir: dir, maxWakesPerDay: 10, maxOverdueMinutes: 60 });
	const store = new WakeStore(dir);
	store.saveJobs([{
		id: 'job-1', sessionId: 'session-1', nextAt: Date.now() - 2 * 60 * 60_000,
		status: 'scheduled', attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), lastError: '',
	}]);
	const scheduler = new WakeScheduler({ ctx: {}, config, store, timers: false });
	scheduler.start();
	const [job] = store.loadJobs();
	assert.equal(job.status, 'missed');
	assert.equal(job.lastError, 'overdue');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('the preset captured when scheduling is used when the session log lost its preset event', async () => {
	const dir = tempDir();
	const config = normalizeConfig({ dataDir: dir, maxWakesPerDay: 10, idleWaitMs: 0 });
	const store = new WakeStore(dir);
	let mounted = null;
	const agent = {
		followup: () => {},
		session: { snapshotEvents: () => [] },
		ctx: {
			get: (name) => (name === 'agentPresets'
				? { mount: async (_ctx, id) => { mounted = id; } }
				: undefined),
		},
	};
	const ctx = {
		agents: { get: () => null, resume: async () => ({ agent }) },
		get: () => undefined,
	};
	const scheduler = new WakeScheduler({
		ctx, config, store, timers: false,
		createMessage: async () => ({ role: 'user', content: [] }),
	});
	const created = scheduler.schedule({
		sessionId: 'session-1', afterMinutes: 1, presetId: 'fish-soul', now: new Date(),
	});
	const result = await scheduler.dispatchJob(created.job.id);
	assert.equal(result.ok, true);
	assert.equal(mounted, 'fish-soul');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('a second dispatch call cannot submit a job that is already dispatching', async () => {
	const dir = tempDir();
	const config = normalizeConfig({ dataDir: dir, maxWakesPerDay: 10 });
	const store = new WakeStore(dir);
	store.saveJobs([{
		id: 'job-1', sessionId: 'session-1', nextAt: Date.now(),
		status: 'dispatching', attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), lastError: '',
	}]);
	const scheduler = new WakeScheduler({ ctx: {}, config, store, timers: false });
	const result = await scheduler.dispatchJob('job-1');
	assert.equal(result.skipped, true);
	fs.rmSync(dir, { recursive: true, force: true });
});

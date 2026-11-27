import os from 'node:os';
import path from 'node:path';
import { parseHhmm } from './time.js';

export const DEFAULTS = Object.freeze({
	enabled: true,
	dataDir: '',
	quietStart: '01:00',
	quietEnd: '08:00',
	maxWakesPerDay: 8,
	minAfterMinutes: 1,
	maxAfterMinutes: 1440,
	maxOverdueMinutes: 180,
	idleWaitMs: 10 * 60_000,
	intentMaxChars: 500,
});

function integer(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(n)));
}

export function defaultDataDir() {
	const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
	return path.join(home, 'dsh-wake');
}

export function normalizeConfig(raw = {}) {
	const src = raw && typeof raw.wake === 'object' && raw.wake !== null ? raw.wake : raw;
	// A typo in the quiet window must never silently disable the safety rule:
	// fall back to the default window when either bound cannot be parsed.
	const rawStart = src.quietStart ?? DEFAULTS.quietStart;
	const rawEnd = src.quietEnd ?? DEFAULTS.quietEnd;
	const quietStart = parseHhmm(rawStart) === null ? DEFAULTS.quietStart : String(rawStart).trim();
	const quietEnd = parseHhmm(rawEnd) === null ? DEFAULTS.quietEnd : String(rawEnd).trim();
	const minAfterMinutes = integer(src.minAfterMinutes, DEFAULTS.minAfterMinutes, 1, 24 * 60);
	const maxAfterMinutes = Math.max(
		minAfterMinutes,
		integer(src.maxAfterMinutes, DEFAULTS.maxAfterMinutes, 1, 7 * 24 * 60),
	);
	return {
		enabled: src.enabled !== false,
		dataDir: String(src.dataDir ?? '').trim() || defaultDataDir(),
		quietStart,
		quietEnd,
		// 0 means "never wake". There is intentionally no "unlimited" value:
		// a runaway wake loop costs real tokens, so the cap must always exist.
		maxWakesPerDay: integer(src.maxWakesPerDay, DEFAULTS.maxWakesPerDay, 0, 10_000),
		minAfterMinutes,
		maxAfterMinutes,
		// A wake that fires hours late is no longer the moment the model planned
		// for. Skip it instead of replaying a stale goal.
		maxOverdueMinutes: integer(src.maxOverdueMinutes, DEFAULTS.maxOverdueMinutes, 0, 7 * 24 * 60),
		idleWaitMs: integer(src.idleWaitMs, DEFAULTS.idleWaitMs, 0, 60 * 60_000),
		intentMaxChars: integer(src.intentMaxChars, DEFAULTS.intentMaxChars, 1, 2000),
	};
}

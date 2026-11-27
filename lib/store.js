import fs from 'node:fs';
import path from 'node:path';
import { localDateKey } from './time.js';

function readJson(file, fallback) {
	try {
		const raw = fs.readFileSync(file, 'utf8');
		return JSON.parse(raw);
	} catch {
		return fallback;
	}
}

function writeAtomic(file, value) {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, file);
	} finally {
		try { fs.rmSync(tmp, { force: true }); } catch { /* already renamed */ }
	}
}

export class WakeStore {
	constructor(dataDir) {
		this.dir = String(dataDir ?? '').trim();
		if (this.dir === '') throw new Error('WakeStore requires dataDir');
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		this.jobsFile = path.join(this.dir, 'jobs.json');
		this.statsFile = path.join(this.dir, 'stats.json');
	}

	loadJobs() {
		const value = readJson(this.jobsFile, []);
		return Array.isArray(value) ? value : [];
	}

	saveJobs(jobs) {
		writeAtomic(this.jobsFile, Array.isArray(jobs) ? jobs : []);
	}

	loadStats() {
		const value = readJson(this.statsFile, {});
		return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
	}

	todayCount(date = new Date()) {
		const key = localDateKey(date);
		const stats = this.loadStats();
		return stats.date === key ? Math.max(0, Number(stats.count) || 0) : 0;
	}

	incrementToday(date = new Date()) {
		const key = localDateKey(date);
		const stats = this.loadStats();
		const count = stats.date === key ? Math.max(0, Number(stats.count) || 0) : 0;
		const next = { date: key, count: count + 1 };
		writeAtomic(this.statsFile, next);
		return next.count;
	}
}

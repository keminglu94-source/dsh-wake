/** Parse HH:mm in host-local time. Returns minutes since midnight or null. */
export function parseHhmm(raw) {
	const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(raw ?? '').trim());
	if (m === null) return null;
	return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesOfDay(date = new Date()) {
	return date.getHours() * 60 + date.getMinutes();
}

/**
 * [start, end) in host-local time. Supports overnight windows when start > end.
 * A same-time window is empty.
 */
export function isQuietTime(date, start = '01:00', end = '08:00') {
	const s = parseHhmm(start);
	const e = parseHhmm(end);
	if (s === null || e === null || s === e) return false;
	const m = minutesOfDay(date);
	return s < e ? (m >= s && m < e) : (m >= s || m < e);
}

export function localDateKey(date = new Date()) {
	const pad = (n) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localTimeLabel(date = new Date()) {
	const pad = (n) => String(n).padStart(2, '0');
	return `${localDateKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

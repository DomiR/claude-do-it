import type { Frontiers } from 'loro-crdt';
import { KEPT } from './constants';
import { DocError } from './errors';
import type { Origin, Version } from './types';

export type { Conflict, Origin, Version } from './types';

export function describeOrigin(origin: Origin): string {
	return origin.kind === 'agent' ? origin.name : origin.kind === 'user' ? 'the user' : 'file';
}

export function checkVersion(version: Version): void {
	if (!Number.isSafeInteger(version) || version < 1) {
		throw new DocError({ code: 'invalid', message: 'A version must be a positive safe integer' });
	}
}

interface Entry {
	version: Version;
	frontiers: Frontiers;
	origin: Origin | null;
}

/** Fixed storage, with the oldest entry overwritten once the ring is full. */
export class History {
	private readonly entries: Array<Entry | undefined> = new Array(KEPT);
	private start = 0;
	private count = 0;

	get size(): number {
		return this.count;
	}

	record(version: Version, frontiers: Frontiers, origin: Origin | null): void {
		const entry = { version, frontiers, origin: origin === null ? null : { ...origin } };
		const last = (this.start + this.count - 1) % KEPT;
		if (this.count && this.entries[last]?.version === version) {
			this.entries[last] = entry;
			return;
		}
		if (this.count === KEPT) {
			this.entries[this.start] = entry;
			this.start = (this.start + 1) % KEPT;
		} else {
			this.entries[(this.start + this.count) % KEPT] = entry;
			this.count++;
		}
	}

	find(version: Version): Entry | null {
		for (let i = this.count - 1; i >= 0; i--) {
			const entry = this.entries[(this.start + i) % KEPT]!;
			if (entry.version === version) return entry;
		}
		return null;
	}

	list(): ReadonlyArray<Entry> {
		return Array.from({ length: this.count }, (_, i) => this.entries[(this.start + i) % KEPT]!);
	}

	originsSince(version: Version): Origin[] | null {
		if (!this.find(version)) return null;
		const seen = new Set<string>();
		const origins: Origin[] = [];
		for (let i = 0; i < this.count; i++) {
			const entry = this.entries[(this.start + i) % KEPT]!;
			if (entry.version <= version || !entry.origin) continue;
			const key = originKey(entry.origin);
			if (!seen.has(key)) {
				seen.add(key);
				origins.push({ ...entry.origin });
			}
		}
		return origins;
	}
}

export function originKey(origin: Origin): string {
	return origin.kind === 'agent' ? `agent:${origin.name}` : origin.kind;
}

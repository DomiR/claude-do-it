import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { isDark, storedTheme, storeTheme } from './preferences';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const install = (storage: unknown) =>
	Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });

describe('theme preference', () => {
	beforeEach(() => {
		const data = new Map<string, string>();
		install({
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => void data.set(key, value)
		});
	});
	afterEach(() => {
		if (original) Object.defineProperty(globalThis, 'localStorage', original);
		else Reflect.deleteProperty(globalThis, 'localStorage');
	});

	test('defaults to System and round trips each choice', () => {
		expect(storedTheme()).toBe('System');
		for (const theme of ['Light', 'Dark', 'System'] as const) {
			storeTheme(theme);
			expect(storedTheme()).toBe(theme);
		}
	});

	test('falls back to System for an unknown value or blocked storage', () => {
		globalThis.localStorage.setItem('do-it.theme', 'purple');
		expect(storedTheme()).toBe('System');
		install({
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			}
		});
		expect(storedTheme()).toBe('System');
		expect(() => storeTheme('Dark')).not.toThrow();
	});

	test('shows dark when chosen, or when System follows a dark system', () => {
		expect(isDark('Dark', false)).toBe(true);
		expect(isDark('Light', true)).toBe(false);
		expect(isDark('System', true)).toBe(true);
		expect(isDark('System', false)).toBe(false);
	});
});

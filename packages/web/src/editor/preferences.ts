const WRAP_KEY = 'do-it.wrap-lines';

/** Whether long lines wrap, as last chosen in this browser. Off by default and when storage is unavailable. */
export const storedWrap = (): boolean => {
	try {
		return globalThis.localStorage?.getItem(WRAP_KEY) === 'on';
	} catch {
		return false;
	}
};

export const storeWrap = (wrap: boolean): void => {
	try {
		globalThis.localStorage?.setItem(WRAP_KEY, wrap ? 'on' : 'off');
	} catch {
		/* Private windows and blocked storage keep the default. */
	}
};

const THEME_KEY = 'do-it.theme';

export type ThemeChoice = 'System' | 'Light' | 'Dark';

/** The theme as last chosen in this browser. System by default, and when storage is unavailable or holds junk. */
export const storedTheme = (): ThemeChoice => {
	try {
		const value = globalThis.localStorage?.getItem(THEME_KEY);
		return value === 'light' ? 'Light' : value === 'dark' ? 'Dark' : 'System';
	} catch {
		return 'System';
	}
};

export const storeTheme = (theme: ThemeChoice): void => {
	try {
		globalThis.localStorage?.setItem(THEME_KEY, theme.toLowerCase());
	} catch {
		/* Private windows and blocked storage keep the default. */
	}
};

/** Whether the dark theme shows: chosen outright, or chosen as System while the operating system prefers dark. */
export const isDark = (theme: ThemeChoice, systemDark: boolean): boolean =>
	theme === 'Dark' || (theme === 'System' && systemDark);

/** Marks the page for the stylesheet's dark block. The inline script in index.html does the same before first paint. */
export const applyTheme = (dark: boolean): void => {
	globalThis.document?.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
};

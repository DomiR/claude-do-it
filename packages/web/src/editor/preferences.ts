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

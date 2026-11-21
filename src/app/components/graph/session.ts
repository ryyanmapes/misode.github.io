import { useCallback, useState } from 'preact/hooks'

/**
 * How things are shown, kept while jumping between presets, versions and tabs.
 * It is lost when the page is reloaded, unlike the settings that the browser stores.
 */
const values = new Map<string, unknown>()

/**
 * A piece of state that survives when the component is created again.
 * Until it is set, it is the initial value of whoever asks, so defaults can depend on the preset.
 */
export function useSessionState<T>(key: string, initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void] {
	const [value, setValue] = useState<T>(() => values.has(key) ? values.get(key) as T
		: typeof initial === 'function' ? (initial as () => T)() : initial)
	const set = useCallback((next: T | ((prev: T) => T)) => {
		setValue(prev => {
			const result = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next
			values.set(key, result)
			return result
		})
	}, [key])
	return [value, set]
}

/** Forgets what was kept under a key, for example of a tab that is closed */
export function dropSession(key: string) {
	values.delete(key)
}

/** An object that is the same every time it is asked for, to remember things in without causing renders */
export function sessionObject<T extends object>(key: string, create: () => T): T {
	if (!values.has(key)) values.set(key, create())
	return values.get(key) as T
}

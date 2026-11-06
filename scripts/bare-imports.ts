import { builtinModules } from 'node:module';

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

/** The package a bare import specifier names: `effect/Effect` is `effect`, `@scope/pkg/x` is `@scope/pkg`. */
export function packageOf(specifier: string): string {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/**
 * The npm packages a built JavaScript bundle imports at run time: static imports, dynamic imports with a
 * literal specifier, and `require` calls. Relative paths, `node:` and `bun:` modules, and Node builtins are skipped.
 */
export function bareImports(code: string): ReadonlyArray<string> {
	const found = new Set<string>();
	for (const { path } of new Bun.Transpiler({ loader: 'js' }).scan(code).imports) {
		if (path.startsWith('.') || path.startsWith('/') || path.startsWith('node:') || path.startsWith('bun:')) continue;
		const name = packageOf(path);
		if (name === 'bun' || builtins.has(name)) continue;
		found.add(name);
	}
	return [...found].sort();
}

/** The bare imports of `code` that `dependencies` does not declare. */
export function undeclaredImports(code: string, dependencies: Readonly<Record<string, string>>): ReadonlyArray<string> {
	return bareImports(code).filter((name) => !(name in dependencies));
}

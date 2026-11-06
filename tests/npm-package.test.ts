import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bareImports, packageOf, undeclaredImports } from '../scripts/bare-imports';

const root = join(import.meta.dir, '..');
const dist = join(root, 'dist', 'npm');

describe('bare import scan', () => {
	test('names the package of each bare import and skips relative, node, and bun modules', () => {
		const code = [
			"import{Effect as a}from'effect/Effect';",
			"import b from'@effect/platform-bun/BunRuntime';",
			"import{diffChars}from'diff';",
			"import fs from'node:fs';import path from'path';import{$}from'bun';import'./local.js';",
			"const c=await import('loro-crdt');",
			"const d=require('@scope/pkg/deep');"
		].join('\n');
		expect(bareImports(code)).toEqual(['@effect/platform-bun', '@scope/pkg', 'diff', 'effect', 'loro-crdt']);
		expect(packageOf('effect/unstable/ai/McpServer')).toBe('effect');
		expect(packageOf('@a/b/c')).toBe('@a/b');
	});

	test('reports only the imports the dependencies do not declare', () => {
		expect(undeclaredImports("import'diff';import'effect';", { effect: '4.1.2' })).toEqual(['diff']);
	});
});

describe('the built npm package', () => {
	beforeAll(async () => {
		const build = Bun.spawn([process.execPath, 'scripts/npm.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
		const [stderr, code] = await Promise.all([new Response(build.stderr).text(), build.exited]);
		if (code !== 0) throw new Error(`bun scripts/npm.ts failed with ${code}\n${stderr}`);
	}, 180_000);

	test('declares every package its bin files import', () => {
		const manifest = JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8')) as {
			dependencies: Record<string, string>;
		};
		const files = readdirSync(join(dist, 'bin')).filter((name) => name.endsWith('.js'));
		expect(files.sort()).toEqual(['daemon.js', 'do-it.js']);
		for (const file of files) {
			const imports = bareImports(readFileSync(join(dist, 'bin', file), 'utf8'));
			expect(imports.length).toBeGreaterThan(0);
			for (const name of imports) expect(manifest.dependencies, `${file} imports ${name}`).toHaveProperty(name);
		}
	});
});

import { APP_VERSION } from '@do-it/protocol';
import { Config, Effect, FileSystem, Option, Path } from 'effect';

/** Set by the npm build, which ships the skill next to the CLI. */
declare const DO_IT_SKILL_ROOT: string | undefined;
const skillRoot = new URL(typeof DO_IT_SKILL_ROOT === 'string' ? DO_IT_SKILL_ROOT : '../../../skill', import.meta.url);

/** Marks a copy made by `do-it skill install`, so a later install may replace it. */
export const SKILL_MARKER = '.do-it-version';

export type SkillInstall =
	| { kind: 'installed'; path: string; replaced: boolean }
	| { kind: 'linked'; path: string }
	| { kind: 'occupied'; path: string };

/** The skill directory shipped with this CLI. */
export const skillSource = Effect.gen(function* () {
	const path = yield* Path.Path;
	return yield* path.fromFileUrl(skillRoot);
}).pipe(Effect.orDie);

/** The skill's SKILL.md and where it lives. */
export const readSkill = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const file = path.join(yield* skillSource, 'SKILL.md');
	return { path: file, content: yield* fs.readFileString(file) };
});

/** Claude Code reads personal skills from `~/.claude/skills`, or `$CLAUDE_CONFIG_DIR/skills`. */
export const defaultSkillDir = Effect.gen(function* () {
	const path = yield* Path.Path;
	const configured = yield* Config.option(Config.String('CLAUDE_CONFIG_DIR'));
	const base = Option.isSome(configured) ? configured.value : path.join(yield* Config.String('HOME'), '.claude');
	return path.join(base, 'skills', 'do-it');
}).pipe(Effect.orDie);

/**
 * Copies the skill into `dir` (default: the personal Claude Code skills
 * directory). A copy made by an earlier install is replaced; anything else
 * there is kept unless `force` is set.
 */
export const installSkill = Effect.fn('installSkill')(function* (dir: string | undefined, force: boolean) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const source = yield* skillSource;
	const target = path.resolve(dir ?? (yield* defaultSkillDir));
	const existing = yield* fs.lstat(target).pipe(Effect.option);
	if (Option.isSome(existing)) {
		const same = yield* fs.realPath(target).pipe(
			Effect.map((real) => real === source),
			Effect.orElseSucceed(() => false)
		);
		if (same) return { kind: 'linked', path: target } satisfies SkillInstall;
		const ours = existing.value.type === 'Directory' && (yield* fs.exists(path.join(target, SKILL_MARKER)));
		if (!ours && !force) return { kind: 'occupied', path: target } satisfies SkillInstall;
		// On a symbolic link this removes the link, never what it points to.
		yield* fs.remove(target, { recursive: true });
	}
	yield* fs.makeDirectory(path.dirname(target), { recursive: true });
	yield* fs.copy(source, target);
	yield* fs.writeFileString(path.join(target, SKILL_MARKER), `${APP_VERSION}\n`);
	return { kind: 'installed', path: target, replaced: Option.isSome(existing) } satisfies SkillInstall;
});

/**
 * What is in a skill directory, compared with the skill this CLI ships.
 * `link` is where a symbolic link points; `marker` is the version a
 * `do-it skill install` copy records.
 */
export type SkillState =
	| { kind: 'missing' }
	| { kind: 'linked' }
	| { kind: 'same'; link: string | null; marker: string | null }
	| { kind: 'differs'; link: string | null; marker: string | null; directory: boolean };

/** Compares the SKILL.md in `target` byte for byte with the one in `source`. */
export const inspectSkill = Effect.fn('inspectSkill')(function* (target: string, source: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const existing = yield* fs.lstat(target).pipe(Effect.option);
	if (Option.isNone(existing)) return { kind: 'missing' } satisfies SkillState;
	const real = yield* fs.realPath(target).pipe(Effect.orElseSucceed(() => null));
	const realSource = yield* fs.realPath(source).pipe(Effect.orElseSucceed(() => source));
	if (real === realSource) return { kind: 'linked' } satisfies SkillState;
	const link =
		existing.value.type === 'SymbolicLink'
			? (real ?? (yield* fs.readLink(target).pipe(Effect.orElseSucceed(() => target))))
			: null;
	const marker = yield* fs.readFileString(path.join(target, SKILL_MARKER)).pipe(
		Effect.map((text) => text.trim()),
		Effect.orElseSucceed(() => null)
	);
	const ours = yield* fs.readFile(path.join(source, 'SKILL.md')).pipe(Effect.orDie);
	const theirs = yield* fs.readFile(path.join(target, 'SKILL.md')).pipe(Effect.orElseSucceed(() => null));
	if (theirs !== null && Buffer.from(theirs).equals(Buffer.from(ours)))
		return { kind: 'same', link, marker } satisfies SkillState;
	const stat = yield* fs.stat(target).pipe(Effect.option);
	const directory = Option.isSome(stat) && stat.value.type === 'Directory';
	return { kind: 'differs', link, marker, directory } satisfies SkillState;
});

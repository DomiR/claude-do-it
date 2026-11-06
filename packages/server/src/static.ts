import { Effect, FileSystem, Option, Path } from 'effect';
import { HttpServerResponse as Response, Mime } from 'effect/http';

/** Serves the built web app from `root`, falling back to index.html for app routes. */
export const staticResponse = Effect.fn('staticResponse')(function* (root: string, pathname: string) {
	const fs = yield* FileSystem.FileSystem;
	const paths = yield* Path.Path;
	if (!(yield* fs.exists(paths.resolve(root, 'index.html'))))
		return Response.html('<!doctype html><p>Run <code>bun run build:web</code> to build the web app.</p>');
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return Response.text('Invalid path', { status: 400 });
	}
	if (decoded.includes('\0') || decoded.includes('\\')) return Response.text('Invalid path', { status: 400 });
	const canonical = yield* fs.realPath(root);
	let path = paths.resolve(canonical, `.${decoded}`);
	if (path !== canonical && !path.startsWith(canonical + paths.sep)) return Response.text('Forbidden', { status: 403 });
	const file = yield* fs.stat(path).pipe(
		Effect.map((info) => info.type === 'File'),
		Effect.catch(() => Effect.succeed(false))
	);
	if (!file) path = paths.resolve(canonical, 'index.html');
	path = yield* fs.realPath(path);
	if (!path.startsWith(canonical + paths.sep)) return Response.text('Forbidden', { status: 403 });
	// Set the type explicitly: HEAD responses carry no body to infer it from.
	return yield* Response.file(path, {
		contentType: Option.getOrElse(Mime.getType(path), () => 'application/octet-stream')
	});
});

type FileNode = { readonly kind: "file"; readonly data: Uint8Array; readonly mtimeMs: number };

type DirectoryNode = { readonly kind: "dir"; readonly children: Set<string>; readonly mtimeMs: number };

type FsNode = FileNode | DirectoryNode;

type ReadOptions = string | { readonly encoding?: string } | undefined;

type MkdirOptions = { readonly recursive?: boolean } | number | undefined;

const FILE_MODE = 0o100644;

const DIRECTORY_MODE = 0o040000;

class FsError extends Error {
	readonly code: string;

	constructor(code: string, path: string) {
		super(`${code}: ${path}`);
		this.code = code;
	}
}

class Stats {
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
	readonly mode: number;
	readonly uid = 1;
	readonly gid = 1;
	readonly dev = 1;
	readonly ino = 1;
	private readonly kind: FsNode["kind"];

	constructor(node: FsNode) {
		this.kind = node.kind;
		this.size = node.kind === "file" ? node.data.byteLength : 0;
		this.mtimeMs = node.mtimeMs;
		this.ctimeMs = node.mtimeMs;
		this.mode = node.kind === "file" ? FILE_MODE : DIRECTORY_MODE;
	}

	isFile(): boolean {
		return this.kind === "file";
	}

	isDirectory(): boolean {
		return this.kind === "dir";
	}

	isSymbolicLink(): boolean {
		return false;
	}
}

const segmentsOf = (path: string): string[] =>
	path.split("/").reduce<string[]>((segments, part) => {
		if (part === "..") segments.pop();
		else if (part !== "" && part !== ".") segments.push(part);

		return segments;
	}, []);

const normalize = (path: string): string => `/${segmentsOf(path).join("/")}`;

const parentOf = (path: string): string => normalize(segmentsOf(path).slice(0, -1).join("/"));

const baseOf = (path: string): string => segmentsOf(path).at(-1) ?? "";

const wantsRecursive = (options: MkdirOptions): boolean => options !== undefined && options instanceof Object && options.recursive === true;

const encodingOf = (options: ReadOptions): string | undefined => (options instanceof Object ? options.encoding : options);

export class MemoryFS {
	private readonly nodes = new Map<string, FsNode>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]]);
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	readonly promises = {
		readFile: (path: string, options?: ReadOptions) => this.readFile(path, options),
		writeFile: (path: string, data: string | Uint8Array) => this.writeFile(path, data),
		unlink: (path: string) => this.unlink(path),
		readdir: (path: string) => this.readdir(path),
		mkdir: (path: string, options?: MkdirOptions) => this.mkdir(path, options),
		rmdir: (path: string) => this.rmdir(path),
		stat: (path: string) => this.stat(path),
		lstat: (path: string) => this.stat(path),
		readlink: (path: string) => Promise.reject(new FsError("ENOENT", path)),
		symlink: (_target: string, path: string) => Promise.reject(new FsError("ENOTSUP", path)),
		chmod: () => Promise.resolve(),
	};

	private node(path: string): FsNode {
		const node = this.nodes.get(normalize(path));

		if (!node) throw new FsError("ENOENT", path);

		return node;
	}

	private directory(path: string): DirectoryNode {
		const node = this.node(path);

		if (node.kind !== "dir") throw new FsError("ENOTDIR", path);

		return node;
	}

	private file(path: string): FileNode {
		const node = this.node(path);

		if (node.kind !== "file") throw new FsError("EISDIR", path);

		return node;
	}

	private link(path: string, node: FsNode): void {
		this.nodes.set(path, node);
		this.directory(parentOf(path)).children.add(baseOf(path));
	}

	private unlinkNode(path: string): void {
		this.nodes.delete(path);
		this.directory(parentOf(path)).children.delete(baseOf(path));
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		const target = normalize(path);

		if (this.nodes.has(target)) return;

		const parent = parentOf(target);

		if (!this.nodes.has(parent)) {
			if (!wantsRecursive(options)) throw new FsError("ENOENT", parent);

			await this.mkdir(parent, { recursive: true });
		}

		this.link(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
	}

	async writeFile(path: string, data: string | Uint8Array): Promise<void> {
		const target = normalize(path);

		await this.mkdir(parentOf(target), { recursive: true });
		this.link(target, { kind: "file", data: data instanceof Uint8Array ? data : this.encoder.encode(data), mtimeMs: Date.now() });
	}

	async readFile(path: string, options?: ReadOptions): Promise<string | Uint8Array> {
		const { data } = this.file(path);

		return encodingOf(options) === undefined ? data : this.decoder.decode(data);
	}

	async readText(path: string): Promise<string> {
		return this.decoder.decode(this.file(path).data);
	}

	async readdir(path: string): Promise<string[]> {
		return [...this.directory(path).children].sort();
	}

	async unlink(path: string): Promise<void> {
		this.file(path);
		this.unlinkNode(normalize(path));
	}

	async rmdir(path: string): Promise<void> {
		if (this.directory(path).children.size > 0) throw new FsError("ENOTEMPTY", path);

		this.unlinkNode(normalize(path));
	}

	async stat(path: string): Promise<Stats> {
		return new Stats(this.node(path));
	}
}

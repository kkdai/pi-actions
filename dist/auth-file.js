import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeSync, } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { maxAuthBytes } from "./auth.js";
// A worker's cwd anchors relative operations to the verified directory inode,
// even if the caller's parent path is renamed or replaced after validation.
// A private claim removes the public filename from the final unlink operation.
const cleanupScript = `
const fs = require("node:fs");
const expected = JSON.parse(process.argv[1]);
const stat = (path) => fs.statSync(path, { bigint: true });
const lstat = (path) => fs.lstatSync(path, { bigint: true });
const parent = stat(".");
const same = (value, dev, ino) => value.dev === BigInt(dev) && value.ino === BigInt(ino);
const ownedFile = (value) => value.isFile() && value.uid === BigInt(expected.uid) && value.nlink === 1n && same(value, expected.dev, expected.ino);
if (!parent.isDirectory() || parent.uid !== BigInt(expected.uid) || (parent.mode & 0o7777n) !== 0o700n || !same(parent, expected.parentDev, expected.parentIno)) {
  throw new Error("Auth parent identity changed.");
}
if (!ownedFile(lstat(expected.name))) throw new Error("Auth file identity changed.");
const claimDirectory = fs.mkdtempSync(".pi-auth-cleanup-");
const claimStat = lstat(claimDirectory);
if (claimStat.uid !== BigInt(expected.uid) || (claimStat.mode & 0o7777n) !== 0o700n) throw new Error("Unsafe auth cleanup directory.");
fs.renameSync(expected.name, claimDirectory + "/auth.json");
process.chdir(claimDirectory);
const currentDirectory = stat(".");
if (!same(currentDirectory, claimStat.dev, claimStat.ino) || currentDirectory.uid !== BigInt(expected.uid) || (currentDirectory.mode & 0o7777n) !== 0o700n) throw new Error("Auth cleanup directory changed.");
const claimed = lstat("auth.json");
if (!ownedFile(claimed)) {
  // Restore a raced-in file with an exclusive link, never overwriting its name.
  // If restoration is not possible, preserve the claim rather than delete data.
  try {
    if (claimed.isDirectory()) {
      fs.mkdirSync("../" + expected.name, { mode: 0o700 });
      fs.renameSync("auth.json", "../" + expected.name);
    } else {
      if (claimed.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync("auth.json"), "../" + expected.name);
      else fs.linkSync("auth.json", "../" + expected.name);
      fs.unlinkSync("auth.json");
    }
  } catch {}
  throw new Error("Unexpected auth entry was preserved.");
}
fs.unlinkSync("auth.json");
`;
function sameFile(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function inside(path) {
    return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function privateOwned(stat, uid, mode) {
    return stat.uid === BigInt(uid) && (stat.mode & 4095n) === BigInt(mode);
}
export class AuthFile {
    path;
    fd;
    stat;
    directories;
    uid;
    present = true;
    closed = false;
    constructor(path, fd, stat, directories, uid) {
        this.path = path;
        this.fd = fd;
        this.stat = stat;
        this.directories = directories;
        this.uid = uid;
    }
    static open(path, runnerTemp, create = false) {
        if (typeof process.getuid !== "function" || constants.O_NOFOLLOW === undefined) {
            throw new Error("Private auth files require a runner with POSIX ownership and permissions.");
        }
        const uid = process.getuid();
        let fd;
        let created = false;
        let opened;
        let canonicalPath = "";
        try {
            if (!path || !runnerTemp || !isAbsolute(path))
                throw new Error();
            const root = realpathSync(runnerTemp);
            const absolute = resolve(path);
            let suffix = relative(resolve(runnerTemp), absolute);
            if (!inside(suffix))
                suffix = relative(root, absolute);
            if (!inside(suffix))
                throw new Error();
            canonicalPath = join(root, suffix);
            const parent = dirname(canonicalPath);
            const rootStat = lstatSync(root, { bigint: true });
            if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
                throw new Error();
            const directories = [{ path: root, stat: rootStat, private: parent === root }];
            let current = root;
            const parents = relative(root, parent).split(sep).filter(Boolean);
            for (const part of parents) {
                current = join(current, part);
                if (create) {
                    try {
                        mkdirSync(current, { mode: 0o700 });
                    }
                    catch (error) {
                        if (!error ||
                            typeof error !== "object" ||
                            !("code" in error) ||
                            error.code !== "EEXIST") {
                            throw error;
                        }
                    }
                }
                const stat = lstatSync(current, { bigint: true });
                directories.push({ path: current, stat, private: true });
                if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwned(stat, uid, 0o700)) {
                    throw new Error();
                }
            }
            if (parent === root && !privateOwned(rootStat, uid, 0o700))
                throw new Error();
            if (!create) {
                const stat = lstatSync(canonicalPath, { bigint: true });
                if (!stat.isFile() ||
                    stat.isSymbolicLink() ||
                    !privateOwned(stat, uid, 0o600) ||
                    stat.nlink !== 1n) {
                    throw new Error();
                }
            }
            fd = openSync(canonicalPath, constants.O_NOFOLLOW |
                constants.O_NONBLOCK |
                (create ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY : constants.O_RDONLY), 0o600);
            created = create;
            const stat = fstatSync(fd, { bigint: true });
            opened = new AuthFile(canonicalPath, fd, stat, directories, uid);
            opened.assertCurrent();
            return opened;
        }
        catch {
            let cleanupFailed = false;
            if (created && opened) {
                try {
                    opened.remove();
                }
                catch {
                    cleanupFailed = true;
                }
            }
            if (fd !== undefined) {
                try {
                    closeSync(fd);
                }
                catch {
                    cleanupFailed = true;
                }
            }
            throw new Error("Cannot open the private auth file. Use a new output path or an existing input file under RUNNER_TEMP, owned by this user, with directory mode 0700 and file mode 0600; symlinks and hard links are not allowed." +
                (cleanupFailed ? " Private auth reservation cleanup also failed." : ""));
        }
    }
    assertCurrent(checkPrivacy = true) {
        try {
            if (!this.present || this.closed)
                throw new Error();
            for (const directory of this.directories) {
                const current = lstatSync(directory.path, { bigint: true });
                if (!current.isDirectory() ||
                    current.isSymbolicLink() ||
                    !sameFile(current, directory.stat) ||
                    (checkPrivacy && directory.private && !privateOwned(current, this.uid, 0o700))) {
                    throw new Error();
                }
            }
            const current = lstatSync(this.path, { bigint: true });
            const opened = fstatSync(this.fd, { bigint: true });
            if (!current.isFile() ||
                current.isSymbolicLink() ||
                !sameFile(current, this.stat) ||
                !sameFile(opened, this.stat) ||
                current.uid !== BigInt(this.uid) ||
                (checkPrivacy &&
                    (!privateOwned(current, this.uid, 0o600) ||
                        current.nlink !== 1n ||
                        opened.size !== this.stat.size ||
                        opened.mtimeNs !== this.stat.mtimeNs ||
                        opened.ctimeNs !== this.stat.ctimeNs))) {
                throw new Error();
            }
        }
        catch {
            throw new Error("The private auth file or its directory changed or has unsafe ownership or permissions.");
        }
    }
    read() {
        this.assertCurrent();
        try {
            const buffer = Buffer.alloc(maxAuthBytes + 1);
            let length = 0;
            while (length < buffer.length) {
                const count = readSync(this.fd, buffer, length, buffer.length - length, length);
                if (!count)
                    break;
                length += count;
            }
            if (length > maxAuthBytes)
                throw new Error();
            this.assertCurrent();
            return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
        }
        catch {
            throw new Error("Cannot read the private auth file or its contents exceed the 48 KB limit.");
        }
    }
    write(json) {
        const buffer = Buffer.from(json, "utf8");
        if (buffer.length > maxAuthBytes)
            throw new Error("The auth handoff exceeds the 48 KB secret limit.");
        this.assertCurrent();
        try {
            let offset = 0;
            while (offset < buffer.length) {
                const count = writeSync(this.fd, buffer, offset, buffer.length - offset, offset);
                if (!count)
                    throw new Error();
                offset += count;
            }
            ftruncateSync(this.fd, buffer.length);
            this.stat = fstatSync(this.fd, { bigint: true });
            this.assertCurrent();
        }
        catch {
            throw new Error("Cannot write the private auth handoff file.");
        }
    }
    remove() {
        if (!this.present)
            return;
        this.assertCurrent(false);
        try {
            const parent = this.directories[this.directories.length - 1];
            execFileSync(process.execPath, [
                "-e",
                cleanupScript,
                JSON.stringify({
                    name: basename(this.path),
                    dev: this.stat.dev.toString(),
                    ino: this.stat.ino.toString(),
                    uid: this.uid,
                    parentDev: parent.stat.dev.toString(),
                    parentIno: parent.stat.ino.toString(),
                }),
            ], {
                cwd: parent.path,
                env: {},
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 10_000,
                maxBuffer: 64 * 1024,
            });
            if (fstatSync(this.fd, { bigint: true }).nlink !== 0n)
                throw new Error();
            this.present = false;
        }
        catch {
            throw new Error("Cannot clean up the private auth file.");
        }
    }
    close() {
        if (this.closed)
            return;
        try {
            closeSync(this.fd);
            this.closed = true;
        }
        catch {
            throw new Error("Cannot close the private auth file.");
        }
    }
}

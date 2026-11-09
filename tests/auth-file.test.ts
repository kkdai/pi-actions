import childProcess from "node:child_process"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { AuthFile } from "../dist/auth-file.js"

const roots: string[] = []
const originalLstat = fs.lstatSync
const originalOpen = fs.openSync
const originalClose = fs.closeSync
const originalExec = childProcess.execFileSync

function workerPrelude(script: string) {
  vi.spyOn(childProcess, "execFileSync").mockImplementation((executable, args, options) => {
    const command = [...(args as string[])]
    command[1] = script + command[1]
    return originalExec(executable, command, options)
  })
  syncBuiltinESMExports()
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-auth-file-test-")))
  roots.push(root)
  const parent = join(root, "private")
  fs.mkdirSync(parent, { mode: 0o700 })
  const path = join(parent, "auth.json")
  fs.writeFileSync(path, "synthetic auth", { mode: 0o600 })
  return { root, parent, path }
}

function reportForeignOwner(path: string) {
  vi.spyOn(fs, "lstatSync").mockImplementation((input, options) => {
    const stat = originalLstat(input, options)
    if (String(input) === path)
      stat.uid = typeof stat.uid === "bigint" ? stat.uid + 1n : stat.uid + 1
    return stat
  })
  syncBuiltinESMExports()
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  syncBuiltinESMExports()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

test.each(["file", "parent"])("rejects a foreign-owner %s without root privileges", (target) => {
  const { root, parent, path } = fixture()
  reportForeignOwner(target === "file" ? path : parent)
  expect(() => AuthFile.open(path, root)).toThrow(/private auth file/)
  expect(fs.readFileSync(path, "utf8")).toBe("synthetic auth")
})

test("rejects a changed input even when a writer modifies the same inode", () => {
  const { root, path } = fixture()
  const file = AuthFile.open(path, root)
  try {
    fs.writeFileSync(path, "a different synthetic auth document")
    expect(() => file.assertCurrent()).toThrow(/changed|unsafe/)
    file.remove()
    expect(fs.existsSync(path)).toBe(false)
  } finally {
    file.close()
  }
})

test("rejects invalid UTF-8 instead of changing opaque credentials", () => {
  const { root, path } = fixture()
  fs.writeFileSync(
    path,
    Buffer.concat([Buffer.from('{"access":"'), Buffer.from([0xff]), Buffer.from('"}')]),
  )
  const file = AuthFile.open(path, root)
  try {
    expect(() => file.read()).toThrow(/Cannot read/)
    file.remove()
  } finally {
    file.close()
  }
})

test("keeps producer snapshots current through repeated writes and truncation", () => {
  const { root, parent } = fixture()
  const path = join(parent, "new-auth.json")
  const file = AuthFile.open(path, root, true)
  try {
    file.write("a long synthetic snapshot")
    file.write("short")
    file.assertCurrent()
    expect(fs.readFileSync(path, "utf8")).toBe("short")
    file.remove()
  } finally {
    file.close()
  }
})

test("removes only the known input after its permissions become unsafe", () => {
  const { root, path } = fixture()
  const file = AuthFile.open(path, root)
  try {
    fs.chmodSync(path, 0o644)
    expect(() => file.assertCurrent()).toThrow(/changed|unsafe/)
    file.remove()
    expect(fs.existsSync(path)).toBe(false)
  } finally {
    file.close()
  }
})

test("does not delete outside the captured parent when reservation validation fails", () => {
  const { root, parent } = fixture()
  const path = join(parent, "new-auth.json")
  const outside = join(root, "outside")
  fs.mkdirSync(outside, { mode: 0o700 })
  const unrelated = join(outside, "new-auth.json")
  fs.writeFileSync(unrelated, "unrelated contents", { mode: 0o600 })
  const backup = join(root, "original-parent")
  vi.spyOn(fs, "openSync").mockImplementation((input, flags, mode) => {
    const fd = originalOpen(input, flags, mode)
    if (String(input) === path) {
      fs.renameSync(parent, backup)
      fs.symlinkSync(outside, parent)
    }
    return fd
  })
  syncBuiltinESMExports()
  expect(() => AuthFile.open(path, root, true)).toThrow(/private auth file/)
  expect(fs.readFileSync(unrelated, "utf8")).toBe("unrelated contents")
})

test("never follows a replaced parent to unlink an alias of a new reservation", () => {
  const { root, parent } = fixture()
  const path = join(parent, "new-auth.json")
  const outside = join(root, "caller-directory")
  fs.mkdirSync(outside, { mode: 0o700 })
  const alias = join(outside, "new-auth.json")
  const backup = join(root, "original-parent")
  vi.spyOn(fs, "openSync").mockImplementation((input, flags, mode) => {
    const fd = originalOpen(input, flags, mode)
    if (String(input) === path) {
      fs.renameSync(parent, backup)
      fs.linkSync(join(backup, "new-auth.json"), alias)
      fs.symlinkSync(outside, parent)
    }
    return fd
  })
  syncBuiltinESMExports()
  expect(() => AuthFile.open(path, root, true)).toThrow(/private auth file/)
  expect(fs.existsSync(alias)).toBe(true)
  expect(fs.existsSync(join(backup, "new-auth.json"))).toBe(true)
})

test("suppresses cleanup-worker diagnostics and reports cleanup failure", () => {
  const { root, path } = fixture()
  const file = AuthFile.open(path, root)
  vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
    throw new Error("synthetic-never-log-this-secret")
  })
  syncBuiltinESMExports()
  try {
    expect(() => file.remove()).toThrow("Cannot clean up the private auth file.")
    expect(fs.existsSync(path)).toBe(true)
  } finally {
    file.close()
  }
})

test("refuses a redirected parent before the cleanup worker starts", () => {
  const { root, parent, path } = fixture()
  const file = AuthFile.open(path, root)
  const outside = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-auth-outside-")))
  roots.push(outside)
  const other = join(outside, "auth.json")
  fs.writeFileSync(other, "caller data", { mode: 0o600 })
  const backup = join(root, "original-parent")
  vi.spyOn(childProcess, "execFileSync").mockImplementation((executable, args, options) => {
    fs.renameSync(parent, backup)
    fs.symlinkSync(outside, parent)
    return originalExec(executable, args, options)
  })
  syncBuiltinESMExports()
  try {
    expect(() => file.remove()).toThrow(/clean up/)
    expect(fs.readFileSync(other, "utf8")).toBe("caller data")
    expect(fs.readFileSync(join(backup, "auth.json"), "utf8")).toBe("synthetic auth")
  } finally {
    file.close()
  }
})

test("anchors cleanup when the parent is redirected after worker validation", () => {
  const { root, parent, path } = fixture()
  const file = AuthFile.open(path, root)
  const outside = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-auth-outside-")))
  roots.push(outside)
  const other = join(outside, "auth.json")
  fs.writeFileSync(other, "caller data", { mode: 0o600 })
  const backup = join(root, "original-parent")
  workerPrelude(`(() => {
    const fs = require("node:fs");
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (source === "auth.json") {
        rename(${JSON.stringify(parent)}, ${JSON.stringify(backup)});
        fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(parent)});
      }
      return rename(source, target);
    };
  })();`)
  try {
    file.remove()
    expect(fs.readFileSync(other, "utf8")).toBe("caller data")
    expect(fs.existsSync(join(backup, "auth.json"))).toBe(false)
  } finally {
    file.close()
  }
})

test("restores a different file claimed during the final cleanup interval", () => {
  const { root, path } = fixture()
  const file = AuthFile.open(path, root)
  workerPrelude(`(() => {
    const fs = require("node:fs");
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (source === "auth.json") {
        rename(source, "original-auth.json");
        fs.writeFileSync(source, "caller data", { mode: 0o600 });
      }
      return rename(source, target);
    };
  })();`)
  try {
    expect(() => file.remove()).toThrow(/clean up/)
    expect(fs.readFileSync(path, "utf8")).toBe("caller data")
    expect(fs.readFileSync(join(root, "private", "original-auth.json"), "utf8")).toBe(
      "synthetic auth",
    )
  } finally {
    file.close()
  }
})

test.each(["symlink", "directory"])("preserves a raced-in %s during final claim", (kind) => {
  const { root, path } = fixture()
  const file = AuthFile.open(path, root)
  const other = join(root, "caller-data")
  fs.writeFileSync(other, "caller data")
  workerPrelude(`(() => {
    const fs = require("node:fs");
    const rename = fs.renameSync;
    let replaced = false;
    fs.renameSync = (source, target) => {
      if (!replaced && source === "auth.json") {
        replaced = true;
        rename(source, "original-auth.json");
        if (${JSON.stringify(kind)} === "symlink") fs.symlinkSync(${JSON.stringify(other)}, source);
        else {
          fs.mkdirSync(source, { mode: 0o700 });
          fs.writeFileSync(source + "/caller-file", "caller directory data");
        }
      }
      return rename(source, target);
    };
  })();`)
  try {
    expect(() => file.remove()).toThrow(/clean up/)
    expect(fs.readFileSync(other, "utf8")).toBe("caller data")
    if (kind === "symlink") expect(fs.lstatSync(path).isSymbolicLink()).toBe(true)
    else expect(fs.readFileSync(join(path, "caller-file"), "utf8")).toBe("caller directory data")
    expect(fs.readFileSync(join(root, "private", "original-auth.json"), "utf8")).toBe(
      "synthetic auth",
    )
  } finally {
    file.close()
  }
})

test("does not give cleanup workers credential environment variables or contents", () => {
  const { root, path } = fixture()
  const file = AuthFile.open(path, root)
  vi.stubEnv("PAT_TOKEN", "synthetic-worker-must-not-inherit")
  vi.stubEnv("PI_AUTH_TOKEN", "synthetic-worker-must-not-inherit")
  vi.spyOn(childProcess, "execFileSync").mockImplementation((executable, args, options) => {
    expect(options?.env).toEqual({})
    expect(JSON.stringify(args)).not.toContain("synthetic-worker-must-not-inherit")
    expect(JSON.stringify(args)).not.toContain("synthetic auth")
    return originalExec(executable, args, options)
  })
  syncBuiltinESMExports()
  try {
    file.remove()
  } finally {
    file.close()
  }
})

test("suppresses raw close diagnostics", () => {
  const { root, path } = fixture()
  const file = AuthFile.open(path, root)
  file.remove()
  vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
    originalClose(fd)
    throw new Error("synthetic-never-log-this-secret")
  })
  syncBuiltinESMExports()
  expect(() => file.close()).toThrow("Cannot close the private auth file.")
})

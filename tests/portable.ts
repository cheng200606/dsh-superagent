/**
 * Test helpers that work on every platform the project runs on.
 *
 * Windows refuses a symbolic link without the Developer Mode or an elevated shell, but a junction
 * needs neither, and it links a directory the same way. The tests that need a link use this helper.
 */
import { symlinkSync } from 'node:fs'
import { platform } from 'node:os'
import { it } from 'vitest'

/**
 * A test that needs what only a POSIX system has: a shell script that runs as a program, a file mode, a
 * signal it can wait for, or tmux. Windows has none of them, so the test is skipped there and says why.
 */
export const posixOnly: (name: string, body: () => unknown, timeout?: number) => void =
  it.skipIf(platform() === 'win32')

/** Links a directory to a path, as a junction on Windows and a symbolic link elsewhere. */
export function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, platform() === 'win32' ? 'junction' : 'dir')
}

/** Links a file to a path; Windows needs the type, and a file link needs the same privilege as any other. */
export function linkFile(target: string, path: string): void {
  symlinkSync(target, path, 'file')
}

/**
 * The names a worker shim directory holds on this platform. Windows gets a `.cmd` variant of every shim,
 * because a shell there resolves a command through PATHEXT and cannot see an extensionless file.
 */
export function shimNames(...names: string[]): string[] {
  const all = platform() === 'win32' ? names.flatMap(name => [name, `${name}.cmd`]) : names
  return all.sort()
}

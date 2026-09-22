/**
 * Where a Session's workspace may live.
 *
 * The directory picker confines what a browser can *choose*, but a Session is
 * created from a wire request that carries its own `cwd`, and nothing validated
 * that. A deployment that fences the picker therefore fenced the dialog and not
 * the entry: a caller could still ask for any directory on the host.
 *
 * The check is made on canonical paths, because a purely lexical comparison is
 * escaped by a junction or a symlink placed under an allowed directory. A path
 * that does not exist yet is resolved by canonicalizing its nearest existing
 * ancestor and appending the rest, so a Session may still be created in a
 * directory the deployment is about to create.
 *
 * @module @deepseek-ai/dsh-team-identity/workspace-root
 */

import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * Canonicalize a path that may not exist yet.
 *
 * `realpath` needs every component to exist, and a Session's workspace usually
 * does not on first use. Walking up to the nearest existing ancestor and
 * re-appending the missing tail keeps the answer canonical for the part that
 * can be resolved — which is the part a junction would have to sit in to escape.
 * @param path - absolute path to canonicalize.
 * @returns the canonical path, or the lexically resolved one when nothing on it exists.
 */
export function canonicalize(path: string): string {
  const absolute = resolve(path)
  const missing: string[] = []
  let current = absolute
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing)
    } catch {
      // Not there (or not resolvable): try the parent.
    }
    const parent = dirname(current)
    if (parent === current) return absolute
    missing.unshift(basename(current))
    current = parent
  }
}

/**
 * Whether one directory is `root` itself or lies beneath it.
 *
 * Both sides are canonicalized first. On a case-insensitive filesystem the
 * comparison is made on canonical casing, which is what `realpath` reports, so
 * two spellings of one directory compare equal.
 * @param root - the only directory a workspace may be created under.
 * @param candidate - the directory a caller asked for.
 * @returns whether the candidate stays inside the root.
 */
export function isWithin(root: string, candidate: string): boolean {
  const canonicalRoot = canonicalize(root)
  const canonicalCandidate = canonicalize(candidate)
  if (canonicalCandidate === canonicalRoot) return true
  return canonicalCandidate.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep)
}

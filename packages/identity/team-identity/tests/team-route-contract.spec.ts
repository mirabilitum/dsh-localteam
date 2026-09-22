/**
 * One contract with two faces: the routes the Host serves, and the browser that
 * calls them.
 *
 * The browser half lives in `ui-deliverables` and repeats the three path
 * literals, because importing this Host-only package for three strings would drag
 * a Node module graph into a browser bundle. This test is what keeps that
 * duplication honest — a route renamed here without renaming it there would leave
 * the member's buttons pointing at a path that no longer answers, and nothing
 * else in either package would notice.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TEAM_EXPORT_PATH, TEAM_HANDOVER_PATH, TEAM_IDENTITY_PATH } from '../src/paths.ts'

/** The browser half that names these routes. */
const CLIENT_SOURCE = fileURLToPath(
  new URL('../../../client/ui-deliverables/src/client/team-surface.ts', import.meta.url),
)

describe('the team route contract', () => {
  it('is named by the Host that serves it and the browser that calls it', () => {
    const source = readFileSync(CLIENT_SOURCE, 'utf8')
    for (const path of [TEAM_IDENTITY_PATH, TEAM_EXPORT_PATH, TEAM_HANDOVER_PATH]) {
      expect(source, `${path} is missing from the browser half`).toContain(`'${path}'`)
    }
  })
})

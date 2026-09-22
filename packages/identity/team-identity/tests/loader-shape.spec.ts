/**
 * The export shape the loader requires.
 *
 * The loader unwraps a module with `exports.default ?? exports`, so a `default`
 * export wins outright. This plugin is apply-shaped: a default export made the
 * loader receive the `TeamIdentity` class instead, ignore `apply` and `inject`,
 * and mount a plugin that did nothing — while still reporting as active and while
 * every hand-built-context test passed, because those tests bypass the unwrap.
 *
 * That is what this file is for: it asserts the shape against the loader's own
 * unwrap rule, so the mistake cannot come back unnoticed.
 */

import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

/** The loader's unwrap: `exports.default ?? exports`, twice for esbuild interop. */
function unwrap(exports: Record<string, unknown>): Record<string, unknown> {
  const once = (exports as { default?: unknown }).default ?? exports
  if (typeof once !== 'object' || once === null) return exports
  const record = once as Record<string, unknown>
  if (record['__esModule'] !== true) return record
  return (record['default'] ?? record) as Record<string, unknown>
}

describe('loader export shape', () => {
  it('exposes no default export', () => {
    // A default here would shadow everything below it in the loader's eyes.
    expect(Object.hasOwn(plugin, 'default')).toBe(false)
  })

  it('survives the loader unwrap with apply and inject intact', () => {
    const resolved = unwrap(plugin as unknown as Record<string, unknown>)
    expect(typeof resolved.apply).toBe('function')
    expect(resolved.name).toBe('team-identity')
    expect(resolved.inject).toEqual(['connection'])
  })

  it('registers the services this plugin actually reaches at runtime', () => {
    // `apply` reaches webServer, timer, and typertGateway through its own
    // injections. Only `connection` is a hard dependency of the plugin itself,
    // because identity resolution must work on a profile with no web carrier.
    expect(plugin.inject).toEqual(['connection'])
  })
})

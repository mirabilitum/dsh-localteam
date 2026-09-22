/**
 * The sign-in surface: the page a member fills in, the document the gate script
 * writes, and the index transform that installs the gate.
 *
 * What matters here is that signing in cannot be faked from the page — the
 * document renders a form and nothing that could mint a cookie — and that the
 * gate is placement-sensitive: it must land in `<head>` to run before the shell's
 * own scripts, or the application mounts first and the gate only covers it.
 */

import { describe, expect, it } from 'vitest'
import { TEAM_IDENTITY_PATH, TEAM_SIGN_IN_DOCUMENT_PATH } from '../src/http-route.ts'
import {
  signInDocumentBody,
  signInGateScript,
  signInPage,
  TEAM_SIGN_IN_PAGE_PATH,
} from '../src/sign-in-page.ts'

/** Mirror of the plugin's index transform, so placement is asserted here too. */
function injectGate(html: string): string {
  return html.replace(/<head(?:\s[^>]*)?>/i, open => `${open}${signInGateScript()}`)
}

describe('sign-in page', () => {
  it('renders a form that posts to the team identity endpoint', () => {
    const html = signInPage('required')
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('id="form"')
    expect(html).toContain('id="name"')
    expect(html).toContain('type="password"')
    // The page must post to the sign-in endpoint; the exact spacing of the
    // generated script is not a contract worth pinning.
    expect(html).toContain('fetch(')
    expect(html).toContain(TEAM_IDENTITY_PATH)
    expect(html).toContain("method: 'POST'")
    expect(html).toContain("credentials: 'same-origin'")
  })

  it('never carries anything that could mint a cookie by itself', () => {
    const html = signInPage('required')
    // The cookie is only ever minted by a successful POST response.
    expect(html).not.toContain('document.cookie')
    expect(html).not.toContain('set-cookie')
  })

  it('tells a returning member why the form reappeared', () => {
    expect(signInPage('invalid')).toContain('上次登录已失效')
    expect(signInPage('signed-out')).toContain('已退出登录')
    expect(signInPage('required')).not.toContain('class="info"')
  })
})

describe('sign-in document', () => {
  it('exposes exactly the document the page renders', () => {
    expect(signInDocumentBody('invalid')).toEqual({ html: signInPage('invalid') })
  })
})

describe('sign-in gate script', () => {
  it('checks status before asking for the document', () => {
    const script = signInGateScript()
    expect(script).toContain(TEAM_IDENTITY_PATH)
    expect(script).toContain(TEAM_SIGN_IN_DOCUMENT_PATH)
    expect(script.indexOf(TEAM_IDENTITY_PATH)).toBeLessThan(script.indexOf(TEAM_SIGN_IN_DOCUMENT_PATH))
  })

  it('leaves the browser alone when the status endpoint is unreachable', () => {
    // Fails open toward the page already fetched: a login form nobody could
    // submit would be worse than the shell.
    expect(signInGateScript()).toContain('{signedIn:true}')
  })

  it('skips the sign-in routes so it cannot re-enter itself', () => {
    const script = signInGateScript()
    expect(script).toContain(JSON.stringify(TEAM_SIGN_IN_PAGE_PATH))
    expect(script).toContain('return;')
  })

  it('carries no closing script tag that would break the injection', () => {
    // The injection is a raw HTML transform, so the script's own text must not be
    // able to end the element early.
    const script = signInGateScript()
    expect(script.slice(0, -'</script>'.length)).not.toContain('</script')
  })
})

describe('gate placement', () => {
  const index = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<script type="module" src="/assets/app.js"></script>',
    '</head><body><div id="root"></div></body></html>',
  ].join('')

  it('lands inside head, before the shell scripts', () => {
    const injected = injectGate(index)
    const gate = injected.indexOf(signInGateScript())
    expect(gate).toBeGreaterThan(injected.indexOf('<head'))
    expect(gate).toBeLessThan(injected.indexOf('/assets/app.js'))
  })

  it('keeps the original document intact around the insertion', () => {
    expect(injectGate(index).replace(signInGateScript(), '')).toBe(index)
  })

  it('leaves a document without head untouched', () => {
    const fragment = '<div>no head here</div>'
    expect(injectGate(fragment)).toBe(fragment)
  })
})

/**
 * The sign-in surface a signed-out browser is served instead of the application.
 *
 * Two pieces, one document:
 *
 * - {@link signInPage} renders the page itself, served at
 *   {@link TEAM_SIGN_IN_PAGE_PATH} for a direct visit and for a cookie that has
 *   gone stale.
 * - {@link signInDocumentBody} exposes that same document as JSON, and
 *   {@link signInGateScript} is injected into the application's `<head>` so a
 *   signed-out browser replaces the shell while it is still parsing rather than
 *   letting the application mount and then covering it.
 *
 * The gate is a convenience for a signed-out member, **not** a security
 * boundary: every `/api` route re-checks the same cookie server-side, which is
 * what actually keeps an unsigned-in browser out.
 *
 * @module @deepseek-ai/dsh-team-identity/sign-in-page
 */

import { TEAM_IDENTITY_PATH } from './paths.ts'

/** Exact Fetch path serving the page to a human. */
export const TEAM_SIGN_IN_PAGE_PATH = '/team/signin'

/** Reason the browser is being asked to sign in. */
export type SignInReason = 'required' | 'invalid' | 'signed-out'

/**
 * Render the sign-in page.
 * @param reason - why the browser is being asked to sign in.
 * @returns the complete HTML document.
 */
export function signInPage(reason: SignInReason): string {
  const notice = reason === 'invalid'
    ? '上次登录已失效，请重新登录。'
    : reason === 'signed-out'
      ? '已退出登录。'
      : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>团队登录</title>
<style>
${STYLES}
</style>
</head>
<body>
<main>
  <h1>团队登录</h1>
  <p class="lead">请填写你的姓名与管理员发给你的邀请码。</p>
  <form id="form" autocomplete="off">
    <label>姓名
      <input id="name" name="name" type="text" required autofocus autocomplete="off">
    </label>
    <label>邀请码
      <input id="code" name="code" type="password" required autocomplete="off">
    </label>
    <button id="submit" type="submit">登录</button>
  </form>
  <p id="notice"${notice === '' ? '' : ' class="info"'}>${escapeHtml(notice)}</p>
</main>
<script>
${SIGN_IN_CLIENT_SCRIPT}
</script>
</body>
</html>
`
}

/**
 * Expose the page as data so the gate script can write it without embedding HTML.
 * @param reason - why the browser is being asked to sign in.
 * @returns the JSON payload the gate reads.
 */
export function signInDocumentBody(reason: SignInReason): { readonly html: string } {
  return { html: signInPage(reason) }
}

/**
 * Index-injection script that replaces the application shell with the sign-in page.
 *
 * Injected into `<head>`, so it runs while the shell is still parsing:
 * `document.write` replaces the document instead of letting the application
 * mount first. It skips the sign-in routes themselves, and it fails open toward
 * the page it already fetched — a browser that cannot reach the status endpoint
 * is left alone rather than shown a login form it cannot submit.
 * @returns the `<script>` text to inject.
 */
export function signInGateScript(): string {
  return '<script>(function(){'
    + 'var p=window.location.pathname;'
    + `if(p===${JSON.stringify(TEAM_SIGN_IN_PAGE_PATH)}||p.slice(0,4)===${JSON.stringify('/api')})return;`
    + `var status=${JSON.stringify(TEAM_IDENTITY_PATH)};`
    + 'fetch(status,{method:\'GET\',credentials:\'same-origin\',cache:\'no-store\'})'
    + '.then(function(r){return r.ok?r.json():{signedIn:true}})'
    + '.then(function(s){'
    + 'if(!s||s.signedIn)return;'
    + `return fetch(${JSON.stringify(`${TEAM_IDENTITY_PATH}.page`)},{method:'GET',credentials:'same-origin',cache:'no-store'})`
    + '.then(function(r){return r.ok?r.json():null})'
    + '.then(function(d){if(!d||typeof d.html!==\'string\')return;'
    + 'document.open();document.write(d.html);document.close()})'
    + '})'
    + '.catch(function(){})'
    + '})()</script>'
}

const STYLES = `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  background: #f6f7f9; color: #1a1a1a;
}
main {
  width: min(92vw, 380px); padding: 32px; border-radius: 14px;
  background: #fff; border: 1px solid #e3e5e8;
  box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.06);
}
h1 { margin: 0 0 6px; font-size: 19px; }
p.lead { margin: 0 0 22px; color: #5c6270; font-size: 13px; }
label { display: block; margin-bottom: 14px; font-size: 13px; color: #3c414c; }
input {
  width: 100%; margin-top: 6px; padding: 9px 11px; font: inherit;
  border: 1px solid #d3d6db; border-radius: 8px; background: #fff; color: inherit;
}
input:focus { outline: 2px solid #3b6ef5; outline-offset: 1px; border-color: #3b6ef5; }
button {
  width: 100%; padding: 10px; font: inherit; font-weight: 600; cursor: pointer;
  border: 0; border-radius: 8px; background: #3b6ef5; color: #fff;
}
button:disabled { opacity: .55; cursor: default; }
#notice { min-height: 20px; margin: 12px 0 0; font-size: 13px; color: #b3261e; }
#notice.info { color: #5c6270; }
@media (prefers-color-scheme: dark) {
  body { background: #14161a; color: #e8eaed; }
  main { background: #1d2024; border-color: #2c3037; box-shadow: none; }
  p.lead { color: #9aa1ad; }
  label { color: #c3c8d0; }
  input { background: #14161a; border-color: #3a3f47; }
  #notice { color: #f2b8b5; }
  #notice.info { color: #9aa1ad; }
}`

const SIGN_IN_CLIENT_SCRIPT = `(function () {
  var form = document.getElementById('form')
  var notice = document.getElementById('notice')
  var submit = document.getElementById('submit')
  function say(text, bad) {
    notice.textContent = text
    notice.className = bad ? '' : 'info'
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault()
    var name = document.getElementById('name').value.trim()
    var code = document.getElementById('code').value
    if (name === '' || code === '') { say('姓名与邀请码都要填。', true); return }
    submit.disabled = true
    say('正在登录…', false)
    fetch(${JSON.stringify(TEAM_IDENTITY_PATH)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name, code: code }),
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (response) {
      if (response.ok) { window.location.replace('/'); return }
      return response.json().catch(function () { return {} }).then(function (body) {
        say(body.reason === 'code' ? '邀请码不对。' : '姓名或邀请码不对。', true)
      })
    }).catch(function () {
      say('网络异常，请重试。', true)
    }).then(function () { submit.disabled = false })
  })
})()`

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => HTML_ESCAPES[character] as string)
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

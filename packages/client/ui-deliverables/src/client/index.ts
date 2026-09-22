/**
 * Deliverables plugin, browser half: registers the produced-files row into
 * the chat view's turn-tail chain, and provides the `chatFileMentions`
 * service that links inline-code mentions of produced or delivered files in the closing
 * prose. All policy lives here — the supported mutation calls, mention
 * matching, chip cap, and copy — so
 * composing this plugin out of cordis.yml removes both surfaces entirely;
 * the owning view renders an empty chain and inert prose at zero cost.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ChatFileMentions } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PresentedOpenController } from './present-open.ts'
import { PresentRow } from './PresentRow.tsx'
import { Deliverables, selectDeliverables, type DeliverablesInjected } from './Deliverables.tsx'
import { en, NS, zh, type DeliverablesKey } from './locales.ts'
import { TeamSurface } from './team-surface.ts'
import { TeamSurfaceActions, type TeamSurfaceInjected } from './TeamSurfaceActions.tsx'
import {
  deliverablesDefinition, presentedForClosing, producedFileMentions, selectProducedFiles,
} from './turn-deliverables.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Produced-files row copy. */
    'deliverables': DeliverablesKey
  }
}

export { ProducedFiles, type ProducedFilesProps } from './ProducedFiles.tsx'
export { producedForClosing } from './turn-deliverables.ts'
export { TeamSurface, type TeamMemberView, type TeamScope, type TeamView } from './team-surface.ts'
export { TeamSurfaceActions, type TeamSurfaceInjected } from './TeamSurfaceActions.tsx'

/** Required services for the tail-slot registration and its dictionaries. */
export const inject = ['slots', 'locale', 'uiConversation', 'remote', 'remote.session']

/**
 * Client plugin body: register the dictionaries and the turn-tail entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const opener = new PresentedOpenController()
  ctx.effect(() => () => opener.dispose())
  ctx.on('connection/reset', () => { opener.resetHost() })
  // The deployment's team surface is read once per page rather than once per
  // message row, and read again only when the connection is replaced.
  const team = new TeamSurface()
  ctx.effect(() => () => team.dispose(), 'ui-deliverables: team surface')
  ctx.on('connection/reset', () => { team.forget() })
  void team.load()
  ctx.uiConversation.events.register(deliverablesDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-deliverables: dictionaries')
  ctx.slots.inject(
    'conversation.chat.turnTail',
    () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      select: selectDeliverables,
      locale: NS,
      inject: (): DeliverablesInjected => ({
        hooks: { presentedOpen: opener.state, presentedHost: opener.host },
        reloadPresentedHost: () => opener.loadHost(),
        openPresented: (sessionId, seq, index, action) => opener.open(sessionId, seq, index, action),
      }),
    }, Deliverables),
  )
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'present', locale: NS }, PresentRow,
  ))
  // The team gestures ride the session header rather than a message row. That is
  // not a layout preference: the moment a takeover matters most is a first turn
  // blocked on an approval, where no reply has finished and an entry attached to
  // a message row would not exist at all. Both controls are per Session, so the
  // entry resolves them against the Session it was injected for.
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'team-surface',
    order: 20,
    locale: NS,
    inject: (sessionId): TeamSurfaceInjected => ({
      hooks: { team: team.view },
      readManifest: scope => team.manifest(sessionId, scope),
      downloadSelection: paths => team.downloadSelection(sessionId, paths),
      downloadFile: path => team.downloadFile(sessionId, path),
      readControl: () => team.control(sessionId),
      takeOver: () => team.takeOver(sessionId),
      handOver: to => team.handOver(sessionId, to),
    }),
  }, TeamSurfaceActions))
  // The prose side of the same vocabulary: the chat view reaches this face
  // via ctx.get, so its absence — this plugin composed out — is the off state.
  const t = ctx.locale.bind(NS)
  const mentions: ChatFileMentions = {
    forClosing(owner) {
      const paths = selectProducedFiles(owner)
      const presented = presentedForClosing(owner)
      if (paths === null && presented.length === 0) return undefined
      return producedFileMentions([...new Set([...paths ?? [], ...presented.map(file => file.path)])], owner.openFile,
        path => t('presented.previewButton', { name: path }))
    },
  }
  ctx.provide('chatFileMentions', mentions)
}

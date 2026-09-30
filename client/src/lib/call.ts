// Global call bus, in the same shape as lib/toast.ts and lib/confirm.ts: any
// module can ring someone without threading a hook through the tree, and
// <CallCenter/> (mounted once in App) does the actual WebRTC work.
//
// It is a bus rather than a context because a call has to survive navigation —
// you start one from Chats, then walk to Tasks while still talking. A context
// under the router would unmount with the page and drop the media.

export type CallKind = 'audio' | 'video'

export interface CallRequest {
  conversationId: string
  kind: CallKind
  title: string          // who/what you are calling, for the overlay header
}

type Listener = (req: CallRequest) => void

let listeners: Listener[] = []

export function subscribeCalls(l: Listener): () => void {
  listeners.push(l)
  return () => { listeners = listeners.filter((x) => x !== l) }
}

/** Ring everyone else in a conversation. No-op if <CallCenter/> isn't mounted. */
export function startCall(conversationId: string, kind: CallKind, title: string) {
  for (const l of listeners) l({ conversationId, kind, title })
}

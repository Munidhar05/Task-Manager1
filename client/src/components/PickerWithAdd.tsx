import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from '../lib/toast'

export interface PickOption { id: string; name: string }

// A dropdown that can grow. Behind the department, category and assignee
// pickers, which all drew the same complaint: the list was fixed. A manager
// could choose from the departments or brands the org was born with, and
// nothing anywhere let them add one.
//
// The add action is the LAST ROW OF THE MENU, drawn in the same warm tint as
// every secondary button so it reads as an action rather than one more choice.
// That is why this is a custom menu and not a <select>: a native <option>
// cannot be styled, and an unstyled "Add…" entry at the bottom of a native
// list was tried first and nobody noticed it. A "+ Add" button beside the box
// was tried next and rejected: the action belongs in the list, where you are
// already looking when you find the thing you want is missing.
//
// Two kinds of add. `onAdd` is for things that are just a name (a department,
// a category): the trigger swaps for a name box with Add / ✕ in the same spot,
// the promise creates it, and the result is selected. `onAddClick` is for
// things that need a whole form (a new user): the caller opens it and selects
// the result itself. Employees see neither — `canAdd` is the caller's role
// check, and the server refuses them regardless.
//
// The menu is portalled to <body> and positioned from the trigger's rect:
// every form this lives in scrolls inside a modal or drawer, which would clip
// a menu positioned inside it. It flips upward when the space below is short.
type Row = { kind: 'opt'; id: string; name: string } | { kind: 'add' }

export default function PickerWithAdd({ value, onChange, options, blankLabel, addLabel, noun, canAdd, onAdd, onAddClick, placeholder, maxLength = 40, dataVa, compact, ariaLabel }: {
  value: string
  onChange: (id: string) => void
  options: PickOption[]
  blankLabel: string
  addLabel: string            // the add row's text: "Add another department…"
  noun: string                // for messages: "Added department Design"
  canAdd: boolean
  onAdd?: (name: string) => Promise<PickOption & { existed?: boolean }>
  onAddClick?: () => void
  placeholder?: string
  maxLength?: number
  dataVa?: string             // the voice assistant finds the trigger by this
  compact?: boolean           // inline and sized to its text (the task drawer)
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0) // keyboard cursor, an index into rows
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number } | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const typed = useRef({ s: '', at: 0 })
  const uid = useId()

  const rows: Row[] = [{ kind: 'opt', id: '', name: blankLabel }, ...options.map((o): Row => ({ kind: 'opt', id: o.id, name: o.name }))]
  if (canAdd) rows.push({ kind: 'add' })
  const current = options.find((o) => o.id === value)

  // Focus returns to the trigger after adding or cancelling, so a keyboard user
  // is not dropped at the top of the form. Done after the re-render that brings
  // the trigger back, hence state rather than a direct call.
  const [refocus, setRefocus] = useState(false)
  useEffect(() => {
    if (refocus && !adding) { btnRef.current?.focus(); setRefocus(false) }
  }, [refocus, adding])

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const below = window.innerHeight - r.bottom - 8
    const above = r.top - 8
    const want = Math.min(320, rows.length * 38 + 20)
    const up = below < want && above > below
    const maxHeight = Math.max(120, Math.min(320, up ? above : below))
    // At least as wide as the trigger, and wider when a row needs it (the add
    // row's label, a long name), the way a native menu grows to its widest
    // option. The width is the menu's own (styles.css); if that runs off the
    // right edge it is slid back on screen once rendered, see below.
    setPos({
      left: r.left, width: compact ? Math.max(r.width, 220) : r.width, maxHeight,
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    })
  }
  const openMenu = () => {
    const i = rows.findIndex((x) => x.kind === 'opt' && x.id === value)
    setActive(i < 0 ? 0 : i)
    place()
    setOpen(true)
  }
  const close = () => setOpen(false)

  // Latest `place` for the listeners below, which are bound once per opening.
  const placeRef = useRef(place)
  placeRef.current = place
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) close()
    }
    // The trigger moved under the menu (the form scrolled, the window resized):
    // follow it. Not "close": the body itself scrolls a few pixels the moment
    // the trigger takes focus, which closed the menu before it was ever seen.
    // Scrolling inside the menu is the menu's own business.
    const onScroll = (e: Event) => { if (!popRef.current?.contains(e.target as Node)) placeRef.current() }
    const onResize = () => placeRef.current()
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  // Keep the keyboard cursor in view as it moves through a long list.
  useEffect(() => {
    if (open) popRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])
  // The menu's real width is only known once it has rendered; a wide one next
  // to the right edge (the drawer) is moved left so it stays on screen.
  useLayoutEffect(() => {
    const m = popRef.current
    if (!open || !m) return
    const r = m.getBoundingClientRect()
    const over = r.right - (window.innerWidth - 8)
    if (over > 0) m.style.left = `${Math.max(8, r.left - over)}px`
  }, [open, pos])

  const startAdd = () => {
    if (onAddClick) { onAddClick(); return }
    setName(''); setErr(''); setAdding(true)
  }
  const choose = (row: Row) => {
    close()
    if (row.kind === 'add') { startAdd(); return }
    onChange(row.id)
    setRefocus(true)
  }
  const cancel = () => { setAdding(false); setErr(''); setRefocus(true) }
  const add = async () => {
    const clean = name.replace(/\s+/g, ' ').trim()
    if (!clean) { setErr(`Type a ${noun} name.`); return }
    setBusy(true); setErr('')
    try {
      const r = await onAdd!(clean)
      onChange(r.id)
      toast.success(r.existed ? `${r.name} already exists — selected it` : `Added ${noun} ${r.name}`)
      setAdding(false); setRefocus(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  // The trigger keeps focus while the menu is open; the keys a native select
  // answers to are handled here. Escape with the menu open closes the menu and
  // nothing else — a modal listening for Escape must not lose the whole form.
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenu() }
      return
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((i) => Math.min(rows.length - 1, i + 1)); break
      case 'ArrowUp': e.preventDefault(); setActive((i) => Math.max(0, i - 1)); break
      case 'Home': e.preventDefault(); setActive(0); break
      case 'End': e.preventDefault(); setActive(rows.length - 1); break
      case 'Enter': case ' ': e.preventDefault(); choose(rows[active]); break
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break
      case 'Tab': close(); break
      default:
        // Type-ahead, as a native select has it: letters typed within a moment
        // of each other jump to the first name that starts with them.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now(); const t = typed.current
          t.s = (now - t.at < 800 ? t.s : '') + e.key.toLowerCase(); t.at = now
          const i = rows.findIndex((r) => r.kind === 'opt' && r.name.toLowerCase().startsWith(t.s))
          if (i >= 0) setActive(i)
        }
    }
  }

  if (adding) {
    return (
      <div>
        <div className="addpick-row">
          <input
            autoFocus value={name} maxLength={maxLength} placeholder={placeholder || `${cap(noun)} name`} aria-label={`New ${noun} name`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              // Enter adds and Escape cancels, without reaching anything that
              // listens for them further up (a modal closing on Escape would
              // throw away the whole form over a mistyped name).
              if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add() }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel() }
            }}
          />
          <button type="button" className="btn btn-primary" onClick={add} disabled={busy || !name.trim()}>{busy ? <span className="spinner" /> : 'Add'}</button>
          <button type="button" className="btn btn-ghost" onClick={cancel} aria-label={`Cancel adding a ${noun}`} title="Cancel">✕</button>
        </div>
        {err && <div className="addpick-err" role="alert">{err}</div>}
      </div>
    )
  }
  return (
    <div className={'addpick' + (compact ? ' addpick-compact' : '')}>
      <button
        ref={btnRef} type="button" className={'addpick-btn' + (open ? ' open' : '')} data-va={dataVa}
        role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        aria-controls={open ? `${uid}-menu` : undefined} aria-activedescendant={open ? `${uid}-${active}` : undefined}
        onClick={() => (open ? close() : openMenu())} onKeyDown={onKey}
      >
        <span className="addpick-label">{current ? current.name : blankLabel}</span>
        <svg className="addpick-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef} id={`${uid}-menu`} className={'addpick-menu' + (canAdd ? ' has-foot' : '')} role="listbox" aria-label={ariaLabel}
          style={{ left: pos.left, minWidth: pos.width, maxHeight: pos.maxHeight, top: pos.top, bottom: pos.bottom }}
        >
          {rows.map((row, i) => row.kind === 'add' ? (
            // Pinned to the menu's bottom edge: still the last row, but a long
            // list (every teammate) must not hide it below the fold.
            <div key="__add" className="addpick-foot">
              <div className="addpick-sep" role="presentation" />
              <div
                id={`${uid}-${i}`} data-i={i} role="option" aria-selected={false}
                className={'addpick-opt addpick-opt-add' + (i === active ? ' active' : '')}
                onMouseEnter={() => setActive(i)} onClick={() => choose(row)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                <span className="addpick-opt-name">{addLabel}</span>
              </div>
            </div>
          ) : (
            <div
              key={row.id || '__blank'} id={`${uid}-${i}`} data-i={i} role="option" aria-selected={row.id === value}
              className={'addpick-opt' + (i === active ? ' active' : '') + (row.id === value ? ' selected' : '')}
              onMouseEnter={() => setActive(i)} onClick={() => choose(row)}
            >
              <span className="addpick-opt-name">{row.name}</span>
              {row.id === value && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7" /></svg>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

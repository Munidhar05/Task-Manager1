import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

// The public welcome page — the first thing an unauthenticated visitor sees at "/".
//
// It exists because signing in told a newcomer nothing: the login screen assumed
// you already knew what VoTask was. The page answers "what is this?" before it
// ever asks for a password, and the only two account actions (Log in / Get
// started) live in the top bar — deliberately NOT repeated down the page, so the
// scroll reads as an explanation rather than a funnel.
//
// It leads with VOICE, not meetings. Both are real, but "run your workspace by
// talking to it" is the one sentence that makes someone want an account; meeting
// extraction is what they appreciate second, once they believe the first. Leading
// with both at once is what made the earlier draft feel unfocused.
//
// The hero SHOWS an assistant exchange — spoken line, the plan, a Confirm button —
// rather than describing one. It carries the product's most important promise
// (nothing is written until you approve it) as a picture, which no amount of body
// copy does as well.
//
// Every claim is a capability that ships. Keep it that way: a landing page that
// overpromises is a support ticket later.

/* ---------------------------------------------------------------- icons ---- */
const I = ({ children, size = 20 }: { children: React.ReactNode; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const IcMic = () => <I><rect x="9" y="2" width="6" height="11" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1" /><path d="M12 19v3M8 22h8" /></I>
const IcEar = () => <I><path d="M6 8a6 6 0 1 1 12 0c0 2.5-1.6 3.4-2.6 4.4S14 14.6 14 16a3 3 0 0 1-6 0" /><path d="M9.5 8a2.5 2.5 0 0 1 5 0" /></I>
const IcCheck = () => <I><rect x="3" y="3" width="18" height="18" rx="5" /><path d="m8.5 12 2.5 2.5L16 9" /></I>
const IcGlobe = () => <I><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18" /><path d="M12 3a14 14 0 0 0 0 18" /></I>
const IcShield = () => <I><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></I>
const IcChat = () => <I><path d="M21 11.5a8.4 8.4 0 0 1-9.4 8.4 8.4 8.4 0 0 1-3.7-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" /></I>
const IcTrophy = () => <I><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z" /><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 0-3 3" /></I>
const IcBell = () => <I><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></I>
const IcGrid = () => <I><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></I>
const IcRoute = () => <I><circle cx="6" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M9 6h6a3 3 0 0 1 3 3v6" /></I>
const IcSearch = () => <I><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></I>
const IcLog = () => <I><rect x="4" y="3" width="16" height="14" rx="2" /><path d="M4 21h16" /><path d="M8 8h8M8 12h5" /></I>
const IcClock = () => <I><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></I>
const IcUsers = () => <I><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9" /><path d="M16 3.1A4 4 0 0 1 16 11" /></I>
const IcBolt = () => <I><path d="M13 2 4.5 13H11l-1 9 8.5-11H12z" /></I>
const IcPhone = () => <I><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M11 18.5h2" /></I>
const IcArrow = () => <I size={16}><path d="M5 12h14M13 6l6 6-6 6" /></I>

/* ------------------------------------------------------- shared fragments -- */
// A person chip, the way a task shows its owner inside the app.
const Who = ({ initials, name }: { initials: string; name: string }) => (
  <span className="lp-who"><span className="lp-who-av">{initials}</span>{name}</span>
)

/* ---------------------------------------------------------------- content -- */
const HERO_POINTS = [
  { icon: <IcMic />, text: 'Nearly every action in the app, spoken' },
  { icon: <IcGlobe />, text: 'Understands whatever language your team speaks' },
  { icon: <IcShield />, text: 'Nothing changes until you confirm it on screen' },
]

const PLAINLY = [
  {
    icon: <IcMic />,
    title: 'You talk, it does the work',
    body: 'The assistant is the interface, not a search box bolted on. It creates, assigns, updates, messages and reports — in one sentence, across several steps.',
  },
  {
    icon: <IcEar />,
    title: 'It sits in on your meetings',
    body: 'Hand it the conversation and it returns the decisions, the risks, and the tasks that were agreed — each with an owner, a real date, and the sentence it came from.',
  },
  {
    icon: <IcCheck />,
    title: 'You stay in charge',
    body: 'Nothing is created, changed or sent until you have seen exactly what it will be. Approve, edit, or throw it away before a single task reaches anyone.',
  },
]

// Grouped so the reader sees the RANGE, not just four nice sentences.
const SAY_GROUPS = [
  { label: 'Build the work', lines: ['“Create a task for the design review, due Thursday.”', '“Split the migration between Ravi and Anjali.”'] },
  { label: 'Move it along', lines: ['“Mark the pricing deck in review.”', '“Push the release call to Monday.”'] },
  { label: 'Chase the people', lines: ['“Message everyone who is overdue.”', '“Ask Anjali where the deck stands.”'] },
  { label: 'See where it stands', lines: ['“Who is carrying the most work this week?”', '“Show me everything overdue.”'] },
]

const MEETING_POINTS = [
  { icon: <IcUsers />, title: 'It works out who owns it', body: 'Named directly, volunteered in the room, or genuinely unclear — and when it is unclear it says so rather than guessing.' },
  { icon: <IcClock />, title: 'It turns talk into real dates', body: '“By the end of the week”, “the day after tomorrow”, “before the next review” — spoken out loud, stored as a date the board can sort by.' },
  { icon: <IcBolt />, title: 'It reads the urgency', body: 'Critical, high, medium or low, taken from how the thing was said — not from a dropdown nobody remembers to set.' },
]

const LANG_CARDS = [
  { icon: <IcChat />, title: 'Switch mid-sentence', body: 'People borrow words from another language halfway through a thought. That is ordinary speech, and it parses.' },
  { icon: <IcGlobe />, title: 'Whichever script is quicker', body: 'Say it or type it however it comes out. What gets extracted is the meaning, not the spelling.' },
  { icon: <IcCheck />, title: 'Same result either way', body: 'The owner, the deadline and the priority come out right regardless of the language the sentence started in.' },
]

const FEATURES = [
  { icon: <IcCheck />, title: 'Tasks that hold their shape', body: 'To Do → In Progress → Blocked → In Review → Done, with a manager approval step. Comments, attachments, subtasks, dependencies, progress and reassignment.' },
  { icon: <IcRoute />, title: 'Every task says where it came from', body: 'An origin badge shows whether it arrived from a meeting, a voice command, a chat or by hand — with the original sentence still attached.' },
  { icon: <IcSearch />, title: 'Ask in writing instead', body: 'A text assistant that searches your own work: what is overdue, who owns what, where a project stands. It retrieves only what your role may see.' },
  { icon: <IcChat />, title: 'Chat next to the work', body: 'Direct and group conversations with files, reactions, edits, read receipts and presence — delivered in real time.' },
  { icon: <IcTrophy />, title: 'A leaderboard that is earned', body: 'Daily performance scoring counted from what actually shipped, with a calibration view so the numbers can be checked rather than trusted.' },
  { icon: <IcBell />, title: 'Nudges, not nagging', body: 'Push notifications when work is assigned, submitted, approved, reopened or commented on — plus one daily digest instead of a stream.' },
  { icon: <IcGrid />, title: 'A view per role', body: 'Employees see their own work. Managers see team workload, progress and everything overdue. Admins get org metrics, users and the audit log.' },
  { icon: <IcPhone />, title: 'The same thing on your phone', body: 'A native Android app with push notifications, and the assistant waiting on the button in the middle of the tab bar.' },
]

const FAQ = [
  {
    q: 'Do I have to talk to it?',
    a: 'No. Everything the assistant does, you can also do by hand on the screen — it is an ordinary task manager underneath. Voice is the fast path, not the only one.',
  },
  {
    q: 'What if it mishears me?',
    a: 'You see the plan before anything runs, written out in plain words, with a Confirm and a Cancel. A misheard sentence costs you one tap — never a wrong task sitting in somebody’s list.',
  },
  {
    q: 'Does it need an AI subscription to work?',
    a: 'No. With no AI provider configured, a built-in rule-based engine still pulls owners, dates and priorities out of a transcript. A real model is better on messy speech, but the app never simply stops.',
  },
  {
    q: 'Can people see each other’s work?',
    a: 'Only what their role allows. The AI obeys exactly the same rules the screen does — an employee asking the assistant about the team cannot retrieve someone else’s tasks through it.',
  },
  {
    q: 'Is there a record of what changed?',
    a: 'Every change is written to an audit log with who did it and when, including the ones the assistant made on your behalf. The admin log and the scoring both read from it.',
  },
  {
    q: 'What do I need to try it?',
    a: 'An account and one meeting. Paste a transcript or upload a recording, and watch the tasks come out of it with owners and dates already filled in. That is the whole demo.',
  },
]

/* ------------------------------------------------------------------ page --- */
export default function Landing() {
  // The top bar gains its hairline and shadow only once the page has moved, so the
  // hero opens flush instead of under a floating strip.
  //
  // Which element scrolls is not the same on every screen: below 720px styles.css
  // sets `html, body { overflow-x: hidden }`, which computes overflow-y to auto on
  // an element already fixed at height:100% — so on phones BODY is the scroller and
  // window.scrollY never leaves 0. Hence reading every candidate offset, and a
  // capturing listener on document, which sees the (non-bubbling) scroll event
  // whichever of them fired it.
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0
      setStuck(y > 8)
    }
    onScroll()
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', onScroll, { capture: true })
  }, [])

  // Sections fade up as they arrive. Built so it can only ever ADD polish: the
  // hidden state lives behind a `.js` class this effect sets, so if the script
  // never runs the page still renders plainly and completely. The timeout is the
  // second belt — if an observer somehow never fires, everything reveals anyway
  // rather than leaving a blank band halfway down the page.
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = root.current
    if (!el) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    if (!('IntersectionObserver' in window)) return
    const targets = Array.from(el.querySelectorAll<HTMLElement>('[data-reveal]'))
    if (!targets.length) return
    el.classList.add('js')
    const show = (t: HTMLElement) => t.classList.add('in')
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { show(e.target as HTMLElement); io.unobserve(e.target) }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.04 })
    targets.forEach((t) => io.observe(t))
    const failsafe = window.setTimeout(() => targets.forEach(show), 2500)
    return () => { io.disconnect(); window.clearTimeout(failsafe) }
  }, [])

  return (
    <div className="lp" ref={root}>
      {/* ---- top bar: the ONLY place account actions live ---- */}
      <header className={'lp-nav' + (stuck ? ' stuck' : '')}>
        <div className="lp-nav-in">
          <a className="lp-logo" href="#top">
            <img src="/logo.png" alt="" className="lp-logo-img" />
            <span className="lp-logo-name">VoTask</span>
          </a>
          <nav className="lp-nav-links" aria-label="Page sections">
            <a href="#voice">Voice control</a>
            <a href="#meetings">Meetings</a>
            <a href="#questions">Questions</a>
          </nav>
          <div className="lp-nav-cta">
            <Link to="/login" className="lp-btn lp-btn-ghost">Log in</Link>
            <Link to="/signup" className="lp-btn lp-btn-primary">Get started</Link>
          </div>
        </div>
      </header>

      <main id="top">
        {/* ================================================================ hero */}
        <section className="lp-hero">
          <div className="lp-hero-in">
            <div className="lp-hero-copy">
              <span className="lp-eyebrow"><span className="lp-dot" />Voice-first · works in any language</span>
              <h1 className="lp-h1">Run your entire workspace by voice.</h1>
              <p className="lp-lede">
                Create a task, reassign it, change a status, message the team, pull up the numbers —
                say it, and VoTask does it, after showing you exactly what it is about to do. And
                when the work gets decided in a meeting instead, it listens to that too and turns
                the conversation into assigned tasks with owners and deadlines.
              </p>
              <div className="lp-actions">
                <Link to="/signup" className="lp-btn lp-btn-primary lp-btn-lg">Create your workspace</Link>
                <Link to="/login" className="lp-btn lp-btn-outline lp-btn-lg">I already have an account</Link>
              </div>
              <ul className="lp-points">
                {HERO_POINTS.map((p) => (
                  <li key={p.text}><span className="lp-point-ic">{p.icon}</span>{p.text}</li>
                ))}
              </ul>
            </div>

            {/* The whole promise as one picture: a spoken line, the plan it made,
                and the approval that gates it. */}
            <div className="lp-hero-art" aria-hidden="true">
              <div className="lp-asst">
                <div className="lp-asst-head"><span className="lp-live" />Listening</div>
                <div className="lp-said">
                  <span className="lp-said-ic"><IcMic /></span>
                  <p>“Assign the pricing deck review to Anjali, due Friday, high priority.”</p>
                </div>
                <div className="lp-rule"><span>VoTask will do</span></div>
                <div className="lp-task">
                  <div className="lp-task-top">
                    <span className="lp-task-t">Review the pricing deck</span>
                    <span className="lp-chip lp-chip-high">High</span>
                  </div>
                  <div className="lp-task-m">
                    <Who initials="AV" name="Anjali Verma" />
                    <span className="lp-chip">Due Friday</span>
                  </div>
                </div>
                <div className="lp-asst-foot">
                  <span className="lp-btn lp-btn-primary lp-btn-sm">Confirm</span>
                  <span className="lp-btn lp-btn-quiet lp-btn-sm">Cancel</span>
                </div>
              </div>
              {/* The payoff. Without it the hero stops at "Confirm" and never
                  shows that anything actually happened. */}
              <div className="lp-done">
                <span className="lp-done-ic"><IcCheck /></span>
                <div>
                  <b>Task created</b>
                  <span>Anjali notified · on her board</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============================================== so what is it, plainly */}
        <section className="lp-sec lp-band">
          <div className="lp-in">
            <div className="lp-head" data-reveal>
              <h2 className="lp-h2">So what is it, plainly?</h2>
              <p className="lp-sub">
                It is a task manager for teams who would rather talk than type. Three things happen
                that a normal task board cannot do on its own.
              </p>
            </div>
            <div className="lp-3" data-reveal>
              {PLAINLY.map((c) => (
                <article className="lp-card" key={c.title}>
                  <span className="lp-card-ic">{c.icon}</span>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ======================================================= voice control */}
        <section className="lp-sec lp-warm" id="voice">
          <div className="lp-in">
            <div className="lp-head" data-reveal>
              <span className="lp-kicker"><span className="lp-dot" />The main event</span>
              <h2 className="lp-h2">Say it, and it is done</h2>
              <p className="lp-sub">
                Most of what you do in VoTask, you can do without touching the screen: build the
                work, move it along, chase the people on it, and check where it stands. The
                assistant is on every screen — and on your phone it is the button in the middle.
              </p>
            </div>

            {/* One sentence, several actions. The multi-step plan is what separates
                this from a voice shortcut, so it gets the big treatment. */}
            <div className="lp-demo" data-reveal>
              <div className="lp-demo-said">
                <span className="lp-demo-label">You say</span>
                <p className="lp-quote">“Message everyone who is overdue, then move the release review to Monday.”</p>
                <span className="lp-demo-note">One sentence. Two jobs. No menus.</span>
              </div>
              <div className="lp-asst lp-asst-plan" aria-hidden="true">
                <div className="lp-asst-head"><span className="lp-live" />Assistant</div>
                <p className="lp-plan-intro">Here is the plan — nothing has run yet.</p>
                <ol className="lp-steps">
                  <li><span className="lp-step-n">1</span><div><b>Find overdue tasks</b><span>4 found, across 3 people</span></div></li>
                  <li><span className="lp-step-n">2</span><div><b>Send 4 chat messages</b><span>One each, naming their task</span></div></li>
                  <li><span className="lp-step-n">3</span><div><b>Reschedule “Release review”</b><span>Friday → Monday 8 Sep</span></div></li>
                </ol>
                <div className="lp-asst-foot">
                  <span className="lp-btn lp-btn-primary lp-btn-sm">Confirm all</span>
                  <span className="lp-btn lp-btn-quiet lp-btn-sm">Edit</span>
                  <span className="lp-btn lp-btn-quiet lp-btn-sm">Cancel</span>
                </div>
              </div>
            </div>

            <div className="lp-says" data-reveal>
              {SAY_GROUPS.map((g) => (
                <div className="lp-say-group" key={g.label}>
                  <span className="lp-say-label">{g.label}</span>
                  {g.lines.map((l) => <p className="lp-say-line" key={l}>{l}</p>)}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============================================================ meetings */}
        <section className="lp-sec" id="meetings">
          <div className="lp-in">
            <div className="lp-head" data-reveal>
              <span className="lp-kicker"><span className="lp-dot" />Meetings</span>
              <h2 className="lp-h2">The work gets decided in the room. It arrives on the board.</h2>
              <p className="lp-sub">
                Upload the recording, paste the transcript, or let it listen live while you talk.
                What comes back is not a summary you have to re-read — it is the tasks, already
                addressed to people, with the line that created each one still attached.
              </p>
            </div>

            <div className="lp-demo lp-demo-wide" data-reveal>
              <div className="lp-panel" aria-hidden="true">
                <div className="lp-panel-head"><span className="lp-live" />Transcript · 24 min</div>
                <div className="lp-line"><span className="lp-sp lp-sp-a">PR</span><p>“Let's get the deployment documentation finished — can you take that one, and have it ready by tomorrow?”</p></div>
                <div className="lp-line"><span className="lp-sp lp-sp-b">RK</span><p>“Yes, I'll do it. I'll need someone to look it over before the release call though.”</p></div>
                <div className="lp-line lp-line-dim"><span className="lp-sp lp-sp-c">AV</span><p>“Fine, send it across when it's ready.”</p></div>
              </div>
              <div className="lp-panel lp-panel-out" aria-hidden="true">
                <div className="lp-panel-head lp-panel-head-out"><IcCheck />2 tasks extracted</div>
                <div className="lp-task">
                  <div className="lp-task-top">
                    <span className="lp-task-t">Finish the deployment documentation</span>
                    <span className="lp-chip lp-chip-high">High</span>
                  </div>
                  <div className="lp-task-m"><Who initials="RK" name="Ravi Kumar" /><span className="lp-chip">Due tomorrow</span></div>
                  <p className="lp-task-src">“…can you take that one, and have it ready by tomorrow?”</p>
                </div>
                <div className="lp-task">
                  <div className="lp-task-top">
                    <span className="lp-task-t">Review the docs before the release call</span>
                    <span className="lp-chip">Medium</span>
                  </div>
                  <div className="lp-task-m"><span className="lp-chip lp-chip-warn">Needs confirmation</span><span className="lp-chip">This week</span></div>
                  <p className="lp-task-src">“…someone to look it over before the release call.”</p>
                </div>
              </div>
            </div>

            <div className="lp-3 lp-3-flat" data-reveal>
              {MEETING_POINTS.map((c) => (
                <article className="lp-mini" key={c.title}>
                  <span className="lp-mini-ic">{c.icon}</span>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ============================================================ language
             Names no language on purpose — the point is that it does not matter
             which one your team happens to speak. */}
        <section className="lp-sec lp-warm">
          <div className="lp-in">
            <div className="lp-head lp-head-center" data-reveal>
              <span className="lp-lang-ic"><IcGlobe /></span>
              <h2 className="lp-h2">Talk like a person. It keeps up.</h2>
              <p className="lp-sub">
                Real meetings are not tidy. People switch language halfway through a sentence,
                borrow words from another one, and type in whichever script is quicker. VoTask
                understands your team in whatever language they actually use — and still gets the
                owner, the deadline and the priority right. Nobody has to talk like a form to be
                understood.
              </p>
            </div>
            <div className="lp-3" data-reveal>
              {LANG_CARDS.map((c) => (
                <article className="lp-card" key={c.title}>
                  <span className="lp-card-ic">{c.icon}</span>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ============================================================ features */}
        <section className="lp-sec">
          <div className="lp-in">
            <div className="lp-head" data-reveal>
              <span className="lp-kicker"><span className="lp-dot" />Everything else</span>
              <h2 className="lp-h2">And a serious task manager underneath.</h2>
              <p className="lp-sub">
                The voice is the fast path, not the whole product. Everything below works exactly
                the same whether you spoke it or clicked it.
              </p>
            </div>
            <div className="lp-grid" data-reveal>
              {FEATURES.map((f) => (
                <article className="lp-feat" key={f.title}>
                  <span className="lp-feat-ic">{f.icon}</span>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </article>
              ))}
            </div>
            <div className="lp-trust" data-reveal>
              <div className="lp-trust-item">
                <span className="lp-trust-ic"><IcShield /></span>
                <p><b>Role-based access, end to end.</b> People see their own scope and nothing else — and the assistant obeys the same rules the screen does.</p>
              </div>
              <div className="lp-trust-item">
                <span className="lp-trust-ic"><IcLog /></span>
                <p><b>Every change on the record.</b> An audit log of who did what and when, including the changes the assistant made for you.</p>
              </div>
            </div>
          </div>
        </section>

        {/* =========================================================== questions */}
        <section className="lp-sec lp-band" id="questions">
          <div className="lp-in">
            <div className="lp-head" data-reveal>
              <span className="lp-kicker"><span className="lp-dot" />Questions</span>
              <h2 className="lp-h2">The things people ask first.</h2>
            </div>
            <div className="lp-faq" data-reveal>
              {[FAQ.slice(0, 3), FAQ.slice(3)].map((col, i) => (
                <div className="lp-faq-col" key={i}>
                  {col.map((f) => (
                    <details className="lp-q" key={f.q}>
                      <summary>
                        <span className="lp-q-t">{f.q}</span>
                        <span className="lp-q-ic" aria-hidden="true" />
                      </summary>
                      <p>{f.a}</p>
                    </details>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ================================================================= cta */}
        <section className="lp-cta-sec">
          <div className="lp-in">
            <div className="lp-cta" data-reveal>
              <h2 className="lp-h2">Stop typing what you already said out loud.</h2>
              <p className="lp-sub">
                Create a workspace, then bring it one meeting — or just talk to it. You will know
                inside five minutes whether this is how your team should be working.
              </p>
              <div className="lp-actions lp-actions-center">
                <Link to="/signup" className="lp-btn lp-btn-primary lp-btn-lg">Create your workspace<IcArrow /></Link>
                <Link to="/login" className="lp-btn lp-btn-outline lp-btn-lg">Log in</Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-in lp-foot-in">
          <a className="lp-logo" href="#top">
            <img src="/logo.png" alt="" className="lp-logo-img" />
            <span className="lp-logo-name">VoTask</span>
          </a>
          <span className="lp-foot-tag">Say it · Confirm it · Done</span>
          <div className="lp-foot-links">
            <Link to="/privacy">Privacy Policy</Link>
            <span className="lp-foot-sep">·</span>
            <Link to="/login">Log in</Link>
            <span className="lp-foot-sep">·</span>
            <Link to="/signup">Get started</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}

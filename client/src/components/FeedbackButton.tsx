// The floating "Feedback" tab — always in the bottom-right corner, on every
// authenticated page, so leaving feedback never takes more than one click.
//
// It sits ABOVE the "Ask BTM" voice pill, which owns the very corner (and is
// draggable). Phones hide it: the bottom nav, the new-task FAB and the mic
// already crowd that corner there, so on mobile feedback stays where it was —
// the sidebar's "Rate this app" and the profile menu.
export default function FeedbackButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="fbtn" onClick={onClick} aria-label="Give feedback about this app" title="Tell us what you think">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-4-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 4 11.5 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" />
      </svg>
      <span>Feedback</span>
    </button>
  )
}

// Say something before dying.
//
// One Render service is both the API and the website, so an unguarded throw
// anywhere takes the whole product down — and node's default for an unhandled
// rejection is to exit printing only the rejection value, which for a failed
// upstream call is a bare "TypeError: fetch failed" with no request context and
// no stack. That is how a crash leaves no evidence: the process is gone, the
// terminal shows one meaningless line, and the client only sees ECONNRESET on
// whatever request happened to be in flight.
//
// Every route and socket handler in this server catches its own errors today.
// These exist for the one added later that doesn't.
//
// Its own module, imported first, because ESM hoists every `import` and evaluates
// it before the importing file's own statements: `process.on(...)` written at the
// top of index.js would register only AFTER restore.js had copied its snapshot and
// db.js had opened the database. Module bodies run in import order, so being the
// first import is the only way to cover the others. (Same reason restore.js
// precedes db.js.)
//
// That ordering matters for exactly one case, worth naming so nobody "simplifies"
// this back inline on the strength of a passing test: a module that throws
// SYNCHRONOUSLY while being evaluated — restore.js failing on a bad snapshot, db.js
// failing to open the file. That aborts the import graph on the spot, so an inline
// handler is never reached. Unhandled REJECTIONS are order-insensitive (node only
// reports them at the end of the tick, by which point an inline handler would be
// installed), so they prove nothing either way.

// The asymmetry between the two is deliberate.
//
// A rejected promise usually means one request lost its error handling. Killing
// every open WebSocket, in-flight upload and live meeting transcription over that
// is a worse outcome than carrying on, so it is logged loudly and the process
// lives.
//
// An uncaught exception has already unwound an unknown amount of stack, so
// module state is untrustworthy — better to log it and let a clean process take
// over than to keep serving from a corrupted one.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled promise rejection — some handler is missing a try/catch:')
  console.error(reason instanceof Error ? reason.stack : reason)
})

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception — exiting so a clean process replaces this one:')
  console.error(err?.stack || err)
  process.exit(1)
})

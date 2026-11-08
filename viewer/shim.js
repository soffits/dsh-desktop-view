/*
 * Loaded by the relayed Cua viewer page before its own code. The viewer
 * sends its gRPC-Web calls with `credentials: "omit"`; behind DSH, every
 * request must carry the login cookies (DSH's own and the sign-in proxy's),
 * so its fetches here keep same-origin credentials instead. Nothing else in
 * the page changes.
 */
(() => {
  const original = window.fetch.bind(window)
  window.fetch = (input, init) => original(input, { ...init, credentials: 'same-origin' })
})()

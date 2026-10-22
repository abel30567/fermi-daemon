// Turn supervision for any adapter session (see ./index.mjs): process-level
// failures become turn outcomes, the same way for every harness.
//   - a turn running past turnTimeoutMs: the harness is killed (SIGKILL) and the
//     turn ends as turn_end { ok: false, kind: 'timeout' };
//   - a harness that exits mid-turn: turn_end { ok: false, kind: 'crash' }.
//     Start a new session to restart.
// Each send() gets one turn_end; a turn_end the harness reports after its turn
// already ended (e.g. on its way down after a timeout) is dropped.
import { EventEmitter } from 'node:events'

export function supervise(session, { turnTimeoutMs } = {}) {
  const events = new EventEmitter()
  let turn = null // the in-flight turn: { since, timer }
  const end = (ev) => {
    clearTimeout(turn.timer)
    turn = null
    events.emit('event', ev)
  }
  const fail = (kind, detail) =>
    end({ type: 'turn_end', ok: false, kind, detail, durationMs: Date.now() - turn.since, raw: null })

  session.events.on('event', (ev) => {
    if (ev.type !== 'turn_end') events.emit('event', ev)
    else if (turn) end(ev)
  })
  session.events.on('raw', (line) => events.emit('raw', line))
  session.events.on('stderr', (s) => events.emit('stderr', s))
  session.events.on('exit', (code) => {
    if (turn) fail('crash', `harness exited (${code}) mid-turn`)
    events.emit('exit', code)
  })

  return {
    pid: session.pid,
    events,
    get alive() {
      return session.alive
    },
    send(text) {
      const sent = session.send(text)
      if (sent === false) return false
      if (turn) clearTimeout(turn.timer)
      turn = { since: Date.now() }
      if (turnTimeoutMs)
        turn.timer = setTimeout(() => {
          fail('timeout', `turn exceeded ${turnTimeoutMs}ms`)
          session.close('SIGKILL')
        }, turnTimeoutMs)
      return sent
    },
    interrupt: () => session.interrupt(),
    close: (signal) => session.close(signal),
  }
}

// Preload (node --import) that makes any TCP connection to a non-loopback host
// throw, so a test proves the code under it stays on localhost.
import net from 'node:net'

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const o = typeof args[0] === 'object' && args[0] !== null ? (Array.isArray(args[0]) ? args[0][0] : args[0]) : { port: args[0], host: args[1] }
  const host = o?.host ?? 'localhost'
  if (!o?.path && !LOOPBACK.test(host)) throw new Error(`localhost-only: blocked connection to ${host}:${o?.port}`)
  return connect.apply(this, args)
}

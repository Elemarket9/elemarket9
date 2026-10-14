/**
 * Minimal RESP2 client for native redis:// and rediss:// rate limiting.
 *
 * Written in dependency-free, typed TypeScript so
 * the hot security path has no third-party client to audit and the file can be
 * executed directly by Node for tests. Supports AUTH (URL userinfo or
 * REDIS_USERNAME/REDIS_PASSWORD) and SELECT (URL path db). One serialized
 * connection per process, lazily established, with per-command timeout and
 * fail-fast error handling; callers must always have a durable fallback.
 */

import net from "node:net";
import tls from "node:tls";

type Reply = string | number | null | Error | Reply[];
type Config = { host: string; port: number; tls: boolean; username: string | null; password: string | null; db: number };
type State = { socket: net.Socket; buffer: Buffer; pending: ((reply: Reply) => void) | null; config: Config };
/** @returns {{ host: string, port: number, tls: boolean, username: string | null, password: string | null, db: number }} */
export function parseRedisUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error(`Unsupported Redis URL protocol: ${url.protocol}`);
  }
  const password = process.env.REDIS_PASSWORD?.trim() || decodeURIComponent(url.password) || null;
  const username = process.env.REDIS_USERNAME?.trim() || decodeURIComponent(url.username) || (password ? "default" : null);
  const db = url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isSafeInteger(db) || db < 0 || db > 15) throw new Error("Redis database index must be 0-15");
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    tls: url.protocol === "rediss:",
    username,
    password,
    db,
  };
}

// ---------------------------------------------------------------------------
// RESP2 codec
// ---------------------------------------------------------------------------

function encodeCommand(args: (string | number)[]) {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const value = String(arg);
    parts.push(`$${Buffer.byteLength(value)}\r\n${value}\r\n`);
  }
  return parts.join("");
}

/** Parse one RESP2 value from buf starting at offset. @returns {{ value: any, end: number } | null} */
function parseReply(buf: Buffer, offset: number): { value: Reply; end: number } | null {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const lineEnd = buf.indexOf("\r\n", offset);
  if (lineEnd === -1) return null;
  const header = buf.toString("utf8", offset + 1, lineEnd);
  const afterLine = lineEnd + 2;
  switch (type) {
    case "+":
      return { value: header, end: afterLine };
    case "-":
      return { value: new Error(header), end: afterLine };
    case ":": {
      const n = Number.parseInt(header, 10);
      return Number.isSafeInteger(n) ? { value: n, end: afterLine } : { value: new Error(`Invalid integer reply: ${header}`), end: afterLine };
    }
    case "$": {
      const len = Number.parseInt(header, 10);
      if (len === -1) return { value: null, end: afterLine };
      if (len < 0 || afterLine + len + 2 > buf.length) return null;
      const value = buf.toString("utf8", afterLine, afterLine + len);
      return { value, end: afterLine + len + 2 };
    }
    case "*": {
      const count = Number.parseInt(header, 10);
      if (count === -1) return { value: null, end: afterLine };
      if (count < 0) return { value: new Error(`Invalid array reply: ${header}`), end: afterLine };
      const items = [];
      let cursor = afterLine;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buf, cursor);
        if (!item) return null;
        items.push(item.value);
        cursor = item.end;
      }
      return { value: items, end: cursor };
    }
    default:
      return { value: new Error(`Unknown RESP type: ${type}`), end: afterLine };
  }
}

// ---------------------------------------------------------------------------
// Connection management (one serialized lazy connection)
// ---------------------------------------------------------------------------

let connection: Promise<State | null> | null = null;
let connectionKey: string | null = null;
let queuedCommands = 0;
let commandChain: Promise<Reply | void> = Promise.resolve();

function establishConnection(config: Config): Promise<State> {
  return new Promise<State>((resolve, reject) => {
    const socket = config.tls
      ? tls.connect({ host: config.host, port: config.port, servername: config.host, minVersion: "TLSv1.2" })
      : net.connect({ host: config.host, port: config.port });
    socket.setNoDelay(true);
    const connectTimer = setTimeout(() => fail(new Error("Redis connection timeout")), 800);
    const state: State = { socket, buffer: Buffer.alloc(0), pending: null, config };
    socket.on("data", (chunk) => {
      state.buffer = state.buffer.length ? Buffer.concat([state.buffer, chunk]) : chunk;
      // Serialization guarantees at most one in-flight command; consume its reply.
      while (state.pending) {
        const parsed = parseReply(state.buffer, 0);
        if (!parsed) return;
        state.buffer = state.buffer.subarray(parsed.end);
        const resolve = state.pending;
        state.pending = null;
        resolve(parsed.value);
      }
    });
    const handshake: string[][] = [];
    if (config.password) handshake.push(config.username ? ["AUTH", config.username, config.password] : ["AUTH", config.password]);
    if (config.db > 0) handshake.push(["SELECT", String(config.db)]);

    const fail = (error: unknown) => {
      clearTimeout(connectTimer);
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    socket.once("error", fail);
    socket.once(config.tls ? "secureConnect" : "connect", () => {
      (async () => {
        for (const command of handshake) {
          const reply = await roundTrip(state, command);
          if (reply instanceof Error) throw reply;
        }
        clearTimeout(connectTimer);
        socket.removeListener("error", fail);
        socket.on("error", () => destroyConnection());
        // The HTTP listener owns server lifetime. An idle cache connection
        // must not retain a drained server after SIGTERM. Each command's
        // timeout keeps the event loop alive until its response or failure.
        socket.unref();
        resolve(state);
      })().catch(fail);
    });
  });
}

function destroyConnection() {
  if (!connection) return;
  const current = connection;
  // Reset to null (not a promise) so the lazy reconnect check fires again.
  connection = null;
  connectionKey = null;
  current.then((state) => { state?.socket.destroy(); }).catch(() => {});
}

function roundTrip(state: State, args: (string | number)[]): Promise<Reply> {
  return new Promise<Reply>((resolve) => {
    state.pending = resolve;
    // Replies for previously serialized commands may already be sitting in the
    // buffer (one TCP segment can carry several). Consume them before writing;
    // otherwise we would wait for a 'data' event that already fired.
    const parsed = parseReply(state.buffer, 0);
    if (parsed) {
      state.buffer = state.buffer.subarray(parsed.end);
      state.pending = null;
      resolve(parsed.value);
      return;
    }
    state.socket.write(encodeCommand(args));
  });
}

/**
 * Run a command against native Redis. Resolves with the parsed reply, or an
 * Error instance for RESP errors and transport failures — this path must
 * never throw, so the rate limiter can always fall back to PostgreSQL.
 */
export async function redisCommand(rawUrl: string, args: (string | number)[], timeoutMs = 800): Promise<Reply> {
  if (queuedCommands >= 64) return new Error("Redis command queue saturated");
  queuedCommands++;
  try {
    const config = parseRedisUrl(rawUrl);
    const key = JSON.stringify(config);
    const run = async (): Promise<Reply> => {
      if (connectionKey !== key) destroyConnection();
      if (!connection) {
        connectionKey = key;
        connection = establishConnection(config).catch(() => null);
      }
      const state = await connection;
      if (!state) { destroyConnection(); return new Error("Redis connection unavailable"); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        roundTrip(state, args),
        new Promise<Reply>((resolve) => { timer = setTimeout(() => resolve(new Error("Redis command timeout")), timeoutMs); }),
      ]);
      if (timer) clearTimeout(timer);
      if (result instanceof Error) destroyConnection();
      return result;
    };
    const result = commandChain.then(run, run);
    // The sequencing promise retains no result and recovers for the next caller.
    commandChain = result.then(() => undefined, () => undefined);
    return await result;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally { queuedCommands--; }

}

/**
 * Sliding-window-free fixed-window counter with TTL, evaluated atomically.
 * Mirrors the HTTPS cache semantics in rate-limit.server.ts:
 * increments the key, sets the TTL on first hit, returns [count, ttl].
 */
export async function redisIncrementWithTtl(rawUrl: string, key: string, windowSeconds: number) {
  const script = "local c=redis.call('INCR',KEYS[1]); if c==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; local ttl=redis.call('TTL',KEYS[1]); return {c,ttl}";
  const reply = await redisCommand(rawUrl, ["EVAL", script, "1", key, String(windowSeconds)]);
  if (reply instanceof Error) return reply;
  if (!Array.isArray(reply) || reply.length !== 2) return new Error("Unexpected Redis EVAL reply");
  return reply;
}

/** Test hook: close the shared connection. */
export function closeRedisConnectionForTests() {
  destroyConnection();
}

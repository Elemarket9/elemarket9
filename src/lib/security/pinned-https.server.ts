import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { assertPublicHttpsEndpoint, isPrivateOrReservedIp } from "./ssrf.server";

/** Provider-neutral HTTPS transport: validate every DNS answer and pin the
 * validated address for the actual TLS connection. TLS hostname verification,
 * SNI and the Host header continue to use the original hostname. Redirects
 * are denied. Suitable for JSON webhooks and HTTP provider adapters only.
 */
export async function fetchPinnedPublicHttps(
  destination: string | URL,
  init: {
    method?: "GET" | "POST" | "PUT";
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const endpoint = await assertPublicHttpsEndpoint(String(destination));
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some((a) => !isIP(a.address) || isPrivateOrReservedIp(a.address))
  ) {
    throw new Error("Destination resolved to a restricted address");
  }
  const pinned = addresses[0];
  if (init.body && Buffer.byteLength(init.body) > 128 * 1024)
    throw new Error("Outgoing request too large");
  if (init.signal?.aborted) throw new Error("Outgoing request cancelled");
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const done = (error?: Error, response?: Response) => {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(response!);
    };
    const request = httpsRequest(
      endpoint,
      {
        method: init.method ?? "GET",
        headers: init.headers,
        timeout: 10_000,
        // Disable implicit IPv4/IPv6 switching so no fallback can resolve again.
        family: pinned.family,
        servername: isIP(hostname) ? undefined : hostname,
        lookup: (_host, _options, cb) => {
          cb(null, pinned.address, pinned.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 502;
        if (status < 200 || (status >= 300 && status < 400)) {
          response.destroy();
          done(new Error("Unexpected HTTP status or redirect rejected"));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 512 * 1024) {
            response.destroy(new Error("HTTP response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", (error: Error) => done(error));
        response.on("end", () => {
          const headers = new Headers();
          const contentType = response.headers["content-type"];
          if (typeof contentType === "string") headers.set("content-type", contentType);
          done(
            undefined,
            new Response(
              status === 204 || status === 205 ? null : new Uint8Array(Buffer.concat(chunks)),
              { status, headers },
            ),
          );
        });
      },
    );
    const onAbort = () => request.destroy(new Error("Outgoing request cancelled"));
    request.on("error", (error: Error) => done(error));
    request.on("timeout", () => request.destroy(new Error("Outgoing HTTPS timeout")));
    init.signal?.addEventListener("abort", onAbort, { once: true });
    request.end(init.body);
  });
}

// Test-only stand-in for the TanStack Start request context, so server code that
// reads the current request (rate limiting) can run outside the HTTP runtime.
export function getRequest() {
  return new Request("https://marketplace.example.com/api/payments/webhook", {
    method: "POST",
    headers: { "x-forwarded-for": "198.51.100.10" },
  });
}
export const getRequestHeaders = () => getRequest().headers;

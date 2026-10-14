/**
 * Bound the customer support UI wait. This does NOT cancel a server mutation:
 * messages retain their idempotency key so retrying after an uncertain network
 * outcome cannot create a second message.
 */
export function withSupportRequestTimeout<T>(request: Promise<T>, timeoutMs = 25_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Support request timed out")), timeoutMs);
    void request.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

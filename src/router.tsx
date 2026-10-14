import { createIsomorphicFn } from "@tanstack/react-start";
import { getStartContext } from "@tanstack/start-storage-context";
import { createRouter } from "@tanstack/react-router";
import { AppErrorComponent } from "@/lib/error-component";
import { routeTree } from "./routeTree.gen";

const getCspNonce = createIsomorphicFn()
  .server(() => {
    // Do not call getGlobalStartContext() here. Its return type is derived from
    // Register, while routeTree.gen registers `router` as ReturnType<typeof getRouter>.
    // Reading the global context from inside getRouter therefore creates a circular
    // type dependency that collapses the context to `never` during tsc.
    // Start's storage context is the request-scoped runtime source and deliberately
    // keeps that storage boundary independent of the router's Register type.
    const context = getStartContext().contextAfterGlobalMiddlewares;
    if (
      !context ||
      typeof context !== "object" ||
      !("cspNonce" in context) ||
      typeof context.cspNonce !== "string"
    ) {
      throw new Error("TanStack Start CSP nonce is unavailable during SSR");
    }
    return context.cspNonce;
  })
  .client(() => document.querySelector<HTMLMetaElement>("meta[property=csp-nonce]")?.content);

export function getRouter() {
  return createRouter({
    routeTree,
    defaultErrorComponent: AppErrorComponent,
    ssr: {
      nonce: getCspNonce(),
    },
  });
}

// Public module contract: executive identity server functions only.
export { requireSameOrigin } from "../../../internal/auth/executive/security.mjs";
export { faceEngineConfigured } from "../../../internal/auth/executive/engine.server.mjs";
export { requireExecutiveHost, createExecutiveChallenge, enrollExecutiveProfile, revokeExecutiveFaceProfile } from "../../../internal/auth/executive/core.server.mjs";

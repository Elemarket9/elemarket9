// Server-only contract: consumers must verify commerce outcomes independently.
export { verifyExposure, learningObservation } from '../internal/eide/attribution.server';
export type { DiscoveryExposure, DiscoveryEventType, AttributedObservation } from '../internal/eide/attribution.server';

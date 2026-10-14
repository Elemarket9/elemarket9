import { createFrontendFixtures } from './helpers/frontend-fixture.mjs';
if (!process.env.ELEMARKET_E2E_DATABASE_URL || !process.env.ELEMARKET_E2E_FIXTURES) throw new Error('Provide a migrated local test database and an external fixture output path.');
await createFrontendFixtures(process.env.ELEMARKET_E2E_DATABASE_URL, process.env.ELEMARKET_E2E_FIXTURES);
console.log('Fresh local frontend sessions prepared.');

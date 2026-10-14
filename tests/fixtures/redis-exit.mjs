import assert from 'node:assert/strict';
import {loadTypeScript} from '../../scripts/helpers/load-typescript.mjs';
const {redisCommand}=loadTypeScript('src/lib/security/redis-rate-limit.server.ts');
assert.equal(await redisCommand(process.env.REDIS_URL,['PING']),'PONG');
console.log('Redis ping completed');
// Exit naturally. Explicitly closing Redis here would conceal the regression.

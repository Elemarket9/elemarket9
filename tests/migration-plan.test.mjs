import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingMigrations,migrationName,isMigrationFile} from '../scripts/migration-plan.mjs';
test('migration ledger uses path-independent filename',()=>{
  assert.equal(migrationName('/migrations/0033_fix.sql'),'0033_fix.sql');
  assert.equal(isMigrationFile('auth/0001_auth.sql'),true);
  assert.equal(isMigrationFile('auth'),false);
});
test('migrations are ordered, applied once, and ignore directories',()=>{
  const files=['0030_b.sql','auth','0001_a.sql','0010_c.sql'];
  assert.deepEqual(pendingMigrations(files,['0001_a.sql']),[
    {name:'0010_c.sql',path:'0010_c.sql'},
    {name:'0030_b.sql',path:'0030_b.sql'}
  ]);
});

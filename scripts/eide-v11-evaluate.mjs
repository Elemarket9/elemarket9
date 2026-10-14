#!/usr/bin/env node
// Deterministic synthetic judgments, not observed customer metrics or model training.
import {PGlite} from '@electric-sql/pglite';import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {migrateDiscoveryFixture,seedDiscoveryFixture,syntheticJudgments} from './helpers/eide-fixture.mjs';
import {loadTypeScript} from './helpers/load-typescript.mjs';import {evaluateRanking,evaluateDiscovery} from './eide-evaluation.mjs';
const db=new PGlite({extensions:{pgcrypto}});
try{
 await migrateDiscoveryFixture(db);await seedDiscoveryFixture(db);
 const sql={query:async(t,p=[]) =>(await db.query(t,p)).rows};
 const search=loadTypeScript('src/modules/catalog/internal/search.server.ts',{'@/lib/db':{getDiscoverySql:async()=>sql},'@/lib/env.server':{env:()=> 'synthetic-evaluation-only-secret'}}).searchProducts;
 const evaluate=async()=>{const scenarios=[];const exposures=[];let zeroResults=0;
  for(const scenario of syntheticJudgments){const response=await search({q:scenario.q});const hits=response.hits.slice(0,5);zeroResults+=Number(!hits.length);for(const hit of hits)exposures.push({merchantId:hit.merchantId,isNewProduct:hit.id==='v11_phone_unknown'});scenarios.push({name:scenario.name,rankedIds:hits.map(h=>h.id),...evaluateRanking({rankedIds:hits.map(h=>h.id),judgments:scenario.judgments,k:5})});}
  return {scenarios,discovery:evaluateDiscovery({searches:syntheticJudgments.length,zeroResults,exposures})};};
 const v11=await evaluate();await db.exec("update marketplace_search_synonyms set status='disabled'");const synonymAblation=await evaluate();
 console.log(JSON.stringify({data:'synthetic; no real customer metrics; new-product cohort fixed at fixture reference 2026-02-15, 30-day age',k:5,v11,synonymAblation},null,2));
}finally{await db.close();}

/** Offline evaluation of judged results and privacy-minimized funnel counters.
 * No model fitting, live rank changes, or financial mutations occur here.
 */
export function evaluateRanking({rankedIds, judgments, k=10}) {
  if(!Number.isSafeInteger(k)||k<1||k>1000)throw new Error('Invalid K');
  const ids=[...new Set(rankedIds)].slice(0,k);
  const grade=id=>Math.min(4,Math.max(0,Number.isFinite(judgments[id])?judgments[id]:0));
  const gain=(g,i)=>(2**g-1)/Math.log2(i+2);
  const dcg=ids.reduce((sum,id,i)=>sum+gain(grade(id),i),0);
  const ideal=Object.keys(judgments).map(grade).sort((a,b)=>b-a).slice(0,k).reduce((sum,g,i)=>sum+gain(g,i),0);
  const relevant=Object.keys(judgments).filter(id=>grade(id)>0).length;
  const first=ids.findIndex(id=>grade(id)>0);
  return {precision:ids.filter(id=>grade(id)>0).length/k,ndcg:ideal?dcg/ideal:0,mrr:first<0?0:1/(first+1),recall:relevant?ids.filter(id=>grade(id)>0).length/relevant:0};
}
export function evaluateDiscovery({impressions=0, clicks=0, attributedPurchases=0, searches=0, zeroResults=0, exposures=[]}) {
  const ratio=(n,d)=>d>0?Math.min(1,Math.max(0,n/d)):null;
  const merchants=new Map();
  for(const e of exposures) merchants.set(e.merchantId,(merchants.get(e.merchantId)??0)+1);
  const counts=[...merchants.values()];
  return {ctr:ratio(clicks,impressions),conversion:ratio(attributedPurchases,clicks),zeroResultRate:ratio(zeroResults,searches),
    merchantConcentrationHHI:exposures.length?counts.reduce((sum,n)=>sum+(n/exposures.length)**2,0):null,
    largestMerchantShare:exposures.length?Math.max(...counts)/exposures.length:null,
    newProductExposure:exposures.length?exposures.filter(e=>e.isNewProduct===true).length/exposures.length:null};
}

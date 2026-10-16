/** Transport contract mirrored by enforce_delivery_job_transition(). Receipt is
 * an additional verified fact, not a dispatcher-selectable transport action. */
export const deliveryTransportTransitions:Record<string,readonly string[]>={
 assigned:['accepted','cancelled'],accepted:['picked_up','failed','cancelled'],
 picked_up:['in_transit','failed'],in_transit:['delivered','failed'],
 delivered:['return_requested'],failed:['return_requested'],return_requested:['returned'],returned:[],cancelled:[],
};
export function operationalDeliveryTransitions(status:string){return (deliveryTransportTransitions[status]??[]).filter(s=>s!=='delivered');}
export function handoverStage(input:{transport:string;arrived:boolean;request?:string|null;verified:boolean}){
 if(input.verified)return 'receipt_confirmed';
 if(['failed','cancelled','returned','return_requested'].includes(input.transport))return input.transport;
 if(input.request==='issuing')return 'challenge_requested';
 if(input.request==='issued')return 'awaiting_verification';
 if(input.arrived)return 'arrived';return input.transport;
}

import type {Sql} from "@/lib/db";
/** Revalidate after acquiring the organization lock; a prior HTTP check alone
 * cannot protect a mutation from concurrent manager revocation. */
export async function lockCompanyOperation(tx:Pick<Sql,'query'>,organizationId:string,userId:string,adminOnly=false){
 if(!(await tx.query(`select id from partner_organizations where id=$1 and status='active' for update`,[organizationId]))[0])throw new Error('Company unavailable');
 const member=(await tx.query<{role:string}>(`select role from partner_organization_users where organization_id=$1 and user_id=$2 and status='active' for update`,[organizationId,userId]))[0];
 if(!member)throw new Error('Active company membership required');
 if(['owner','admin'].includes(member.role))return;
 if(adminOnly)throw new Error('Company administrator required');
 if(member.role==='operator')return;
 const capability=await tx.query(`select user_id from delivery_personnel_capabilities where organization_id=$1 and user_id=$2 and status='active'
   and capability in ('dispatcher','supervisor') order by capability for update`,[organizationId,userId]);
 if(!capability[0])throw new Error('Company operations capability required');
}

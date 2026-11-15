import { randomBytes } from "node:crypto";
import { getSql, withTransaction, type Sql } from "@/lib/db";

/**
 * Marketplace promotions (ELEMARKET-funded) and admin oversight of merchant
 * promotions. Permission checks, fresh-session and rate limits happen in the
 * transport layer (promotions.functions.ts); every mutation here writes its
 * audit event in the same transaction as the change.
 *
 * Money rules live in the database (migration 0228, create_pending_order):
 * a marketplace promotion lowers what the customer pays and ELEMARKET's
 * commission on that order, never merchant_net. The discount per order is
 * capped one pesewa below the order's commission, and the budget is reserved
 * atomically at order creation and released when the order is cancelled or
 * expires unpaid.
 */

export const MONEY_PATTERN = /^\d{1,9}(\.\d{1,2})?$/;
export const PROMO_CODE_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_BUDGET = 10_000_000;
const MAX_FIXED_DISCOUNT = 100_000;
const MAX_WINDOW_DAYS = 366;
const START_GRACE_MS = 5 * 60_000;
const START_LEAD_MS = 60_000;

export type MarketplacePromotionInput = {
  code: string;
  name: string;
  description?: string | null;
  discountType: "percentage" | "fixed";
  discountValue: string;
  maxDiscount?: string | null;
  minSubtotal: string;
  usageLimit?: number | null;
  perCustomerLimit: number;
  startsAt: string;
  endsAt: string;
  budget: string;
  firstOrderOnly: boolean;
  isPublic: boolean;
  categories: string[];
  merchantIds: string[];
};

export type MarketplacePromotionRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  phase: "draft" | "scheduled" | "live" | "paused" | "ended" | "archived";
  discount_type: "percentage" | "fixed";
  discount_value: string;
  max_discount: string | null;
  min_subtotal: string;
  usage_limit: number | null;
  per_customer_limit: number;
  starts_at: string;
  ends_at: string;
  first_order_only: boolean;
  is_public: boolean;
  categories: string[];
  merchant_ids: string[];
  budget: string;
  budget_reserved: string;
  budget_consumed: string;
  budget_remaining: string;
  redemptions_applied: number;
  redemptions_reserved: number;
  redemptions_released: number;
  discount_given: string;
  created_at: string;
};

export type MerchantPromotionRow = {
  kind: "coupon" | "flash_sale";
  id: string;
  merchant_id: string | null;
  merchant_name: string | null;
  name: string;
  code: string | null;
  status: string;
  starts_at: string;
  ends_at: string;
  admin_paused_at: string | null;
  admin_pause_reason: string | null;
  redemptions_applied: number;
  redemptions_reserved: number;
  redemptions_released: number;
  discount_given: string;
};

function money(value: string | null | undefined, label: string, { min = 0, max = MAX_BUDGET, allowZero = false } = {}): number {
  const raw = String(value ?? "").trim();
  if (!MONEY_PATTERN.test(raw)) throw new Error(`${label} must be an amount in GHS with at most 2 decimals`);
  const n = Number(raw);
  if (!Number.isFinite(n) || n > max || n < min || (!allowZero && n <= 0)) throw new Error(`${label} is out of range`);
  return Math.round(n * 100) / 100;
}

function parseDate(value: string, label: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${label} is not a valid date`);
  return d;
}

type NormalizedInput = {
  code: string; name: string; description: string | null; discountType: "percentage" | "fixed";
  discountValue: number; maxDiscount: number | null; minSubtotal: number; usageLimit: number | null;
  perCustomerLimit: number; startsAt: Date; endsAt: Date; budget: number; firstOrderOnly: boolean;
  isPublic: boolean; categories: string[]; merchantIds: string[];
};

/** Validates and normalizes a full marketplace promotion definition. Pure. */
export function normalizeMarketplacePromotion(input: MarketplacePromotionInput, now = new Date()): NormalizedInput {
  const code = String(input.code ?? "").trim().toUpperCase();
  if (!PROMO_CODE_PATTERN.test(code)) throw new Error("Code must be 4–64 letters, numbers, dashes or underscores");
  const name = String(input.name ?? "").trim();
  if (name.length < 2 || name.length > 160) throw new Error("Name must be 2–160 characters");
  const description = input.description?.trim() ? input.description.trim() : null;
  if (description && description.length > 500) throw new Error("Description must be at most 500 characters");
  if (input.discountType !== "percentage" && input.discountType !== "fixed") throw new Error("Choose a discount type");
  const discountValue = input.discountType === "percentage"
    ? money(input.discountValue, "Percentage", { max: 100 })
    : money(input.discountValue, "Discount amount", { max: MAX_FIXED_DISCOUNT });
  const maxDiscount = input.maxDiscount != null && String(input.maxDiscount).trim() !== ""
    ? money(input.maxDiscount, "Maximum discount per order", { max: MAX_FIXED_DISCOUNT }) : null;
  const minSubtotal = money(input.minSubtotal || "0", "Minimum basket", { max: 1_000_000, allowZero: true });
  const usageLimit = input.usageLimit == null ? null : Number(input.usageLimit);
  if (usageLimit != null && (!Number.isInteger(usageLimit) || usageLimit < 1 || usageLimit > 10_000_000)) throw new Error("Usage limit must be a whole number of at least 1");
  const perCustomerLimit = Number(input.perCustomerLimit);
  if (!Number.isInteger(perCustomerLimit) || perCustomerLimit < 1 || perCustomerLimit > 100) throw new Error("Uses per customer must be between 1 and 100");
  const requestedStart = parseDate(input.startsAt, "Start");
  const endsAt = parseDate(input.endsAt, "End");
  if (requestedStart.getTime() < now.getTime() - START_GRACE_MS) throw new Error("Start cannot be in the past");
  // "Start now" begins within a minute. The definition (and its scope rows) is
  // written while the promotion has not started yet, so the database's
  // "started promotions are frozen" guard never trips on its own creation.
  const startsAt = new Date(Math.max(requestedStart.getTime(), now.getTime() + START_LEAD_MS));
  if (endsAt.getTime() <= startsAt.getTime()) throw new Error("End must be after the start");
  if (endsAt.getTime() - startsAt.getTime() > MAX_WINDOW_DAYS * 86_400_000) throw new Error("A promotion can run for at most one year");
  const budget = money(input.budget, "Budget");
  const categories = [...new Set((input.categories ?? []).map((c) => String(c).trim()).filter(Boolean))];
  const merchantIds = [...new Set((input.merchantIds ?? []).map((c) => String(c).trim()).filter(Boolean))];
  if (categories.length > 50) throw new Error("At most 50 categories");
  if (merchantIds.length > 200) throw new Error("At most 200 merchants");
  return {
    code, name, description, discountType: input.discountType, discountValue, maxDiscount, minSubtotal,
    usageLimit, perCustomerLimit, startsAt, endsAt, budget, firstOrderOnly: Boolean(input.firstOrderOnly),
    isPublic: Boolean(input.isPublic), categories, merchantIds,
  };
}

async function audit(sql: Sql, event: string, resourceType: string, resourceId: string, actorId: string, metadata: Record<string, unknown>) {
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [event, resourceType, resourceId, actorId, "admin", null, "success", JSON.stringify(metadata)]);
}

async function assertScope(sql: Sql, categories: string[], merchantIds: string[]) {
  if (categories.length) {
    const rows = await sql.query<{ category_key: string }>(`select category_key from category_taxonomy where category_key = any($1::text[])`, [categories]);
    const known = new Set(rows.map((r) => r.category_key));
    const unknown = categories.filter((c) => !known.has(c));
    if (unknown.length) throw new Error(`Unknown category: ${unknown.slice(0, 3).join(", ")}`);
  }
  if (merchantIds.length) {
    const rows = await sql.query<{ id: string }>(`select id from merchants where id = any($1::text[])`, [merchantIds]);
    const known = new Set(rows.map((r) => r.id));
    const unknown = merchantIds.filter((m) => !known.has(m));
    if (unknown.length) throw new Error(`Unknown merchant: ${unknown.slice(0, 3).join(", ")}`);
  }
}

async function replaceScope(sql: Sql, promotionId: string, categories: string[], merchantIds: string[]) {
  await sql.query(`delete from promotion_categories where promotion_id=$1`, [promotionId]);
  await sql.query(`delete from promotion_merchants where promotion_id=$1`, [promotionId]);
  if (categories.length) await sql.query(`insert into promotion_categories(promotion_id,category) select $1, unnest($2::text[])`, [promotionId, categories]);
  if (merchantIds.length) await sql.query(`insert into promotion_merchants(promotion_id,merchant_id) select $1, unnest($2::text[])`, [promotionId, merchantIds]);
}

function friendlyDbError(error: unknown): never {
  const e = error as { code?: string; constraint?: string; message?: string };
  if (e?.code === "23505" && /promotions_code_uq/.test(String(e.constraint ?? e.message ?? ""))) throw new Error("That promotion code is already in use");
  if (e?.code === "23514" && /promotion_budgets/.test(String(e.constraint ?? e.message ?? ""))) throw new Error("Budget cannot be lower than what has already been used or reserved");
  throw error;
}

const STATS_SELECT = `
  coalesce(r.applied,0)::int as redemptions_applied,
  coalesce(r.reserved,0)::int as redemptions_reserved,
  coalesce(r.released,0)::int as redemptions_released,
  coalesce(r.discount_given,0)::numeric(14,2)::text as discount_given`;
const STATS_JOIN = `
  left join lateral (
    select count(*) filter (where pr.status='applied') as applied,
           count(*) filter (where pr.status='reserved') as reserved,
           count(*) filter (where pr.status='released') as released,
           sum(pr.discount_amount) filter (where pr.status='applied') as discount_given
      from promotion_redemptions pr where pr.promotion_id=p.id
  ) r on true`;

export async function listMarketplacePromotions(sql?: Sql): Promise<MarketplacePromotionRow[]> {
  const db = sql ?? (await getSql());
  return db.query<MarketplacePromotionRow>(
    `select p.id,p.code,p.name,p.description,p.status,
            case when p.status='archived' then 'archived'
                 when p.ends_at<=now() then 'ended'
                 when p.status='paused' then 'paused'
                 when p.status='draft' then 'draft'
                 when p.starts_at>now() then 'scheduled'
                 else 'live' end as phase,
            p.discount_type,p.discount_value::text,p.max_discount::text,p.min_subtotal::text,p.usage_limit,p.per_customer_limit,
            p.starts_at,p.ends_at,p.first_order_only,p.is_public,
            coalesce((select array_agg(c.category order by c.category) from promotion_categories c where c.promotion_id=p.id),'{}') as categories,
            coalesce((select array_agg(m.merchant_id order by m.merchant_id) from promotion_merchants m where m.promotion_id=p.id),'{}') as merchant_ids,
            coalesce(b.max_discount_amount,0)::text as budget,
            coalesce(b.reserved_discount_amount,0)::text as budget_reserved,
            coalesce(b.consumed_discount_amount,0)::text as budget_consumed,
            greatest(coalesce(b.max_discount_amount,0)-coalesce(b.reserved_discount_amount,0)-coalesce(b.consumed_discount_amount,0),0)::numeric(14,2)::text as budget_remaining,
            ${STATS_SELECT},
            p.created_at
       from promotions p
       left join promotion_budgets b on b.promotion_id=p.id
       ${STATS_JOIN}
      where p.funding_source='platform'
      order by (p.ends_at>now()) desc, p.starts_at desc
      limit 200`,
  );
}

export async function listMerchantPromotionsForAdmin(input: { search?: string } = {}, sql?: Sql): Promise<MerchantPromotionRow[]> {
  const db = sql ?? (await getSql());
  const search = input.search?.trim() ? `%${input.search.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  return db.query<MerchantPromotionRow>(
    `select * from (
       select 'coupon'::text as kind,p.id,p.merchant_id,m.name as merchant_name,p.name,p.code,p.status,p.starts_at,p.ends_at,
              p.admin_paused_at,p.admin_pause_reason,${STATS_SELECT}
         from promotions p
         left join merchants m on m.id=p.merchant_id
         ${STATS_JOIN}
        where p.funding_source='merchant'
       union all
       select 'flash_sale'::text,f.id,f.merchant_id,m.name,f.name,null,f.status,f.starts_at,f.ends_at,
              f.admin_paused_at,f.admin_pause_reason,
              coalesce(fr.applied,0)::int,coalesce(fr.reserved,0)::int,coalesce(fr.released,0)::int,coalesce(fr.discount_given,0)::numeric(14,2)::text
         from flash_sales f
         join merchants m on m.id=f.merchant_id
         left join lateral (
           select count(*) filter (where x.status='consumed') as applied,
                  count(*) filter (where x.status='reserved') as reserved,
                  count(*) filter (where x.status='released') as released,
                  sum(x.discount_amount) filter (where x.status='consumed') as discount_given
             from flash_sale_redemptions x where x.flash_sale_id=f.id
         ) fr on true
     ) t
     where ($1::text is null or t.name ilike $1 or coalesce(t.code,'') ilike $1 or coalesce(t.merchant_name,'') ilike $1)
     order by (t.admin_paused_at is not null) desc, (t.ends_at>now()) desc, t.starts_at desc
     limit 200`,
    [search],
  );
}

export async function createMarketplacePromotion(actorId: string, input: MarketplacePromotionInput & { activate: boolean }) {
  const p = normalizeMarketplacePromotion(input);
  const id = `promo_${randomBytes(16).toString("hex")}`;
  try {
    return await withTransaction(async (sql) => {
      await assertScope(sql, p.categories, p.merchantIds);
      await sql.query(
        `insert into promotions(id,merchant_id,code,name,description,discount_type,discount_value,currency,min_subtotal,max_discount,
                                usage_limit,per_customer_limit,starts_at,ends_at,status,first_order_only,new_customer_only,
                                created_by,participation_required,funding_source,is_public)
         values($1,null,$2,$3,$4,$5,$6,'GHS',$7,$8,$9,$10,$11,$12,$13,$14,false,$15,false,'platform',$16)`,
        [id, p.code, p.name, p.description, p.discountType, p.discountValue, p.minSubtotal, p.maxDiscount, p.usageLimit,
          p.perCustomerLimit, p.startsAt.toISOString(), p.endsAt.toISOString(), input.activate ? "active" : "draft",
          p.firstOrderOnly, actorId, p.isPublic],
      );
      await sql.query(`insert into promotion_budgets(promotion_id,max_discount_amount) values($1,$2)`, [id, p.budget]);
      await replaceScope(sql, id, p.categories, p.merchantIds);
      await audit(sql, "admin.promotion.marketplace.created", "promotion", id, actorId, {
        code: p.code, discountType: p.discountType, discountValue: p.discountValue.toFixed(2), maxDiscount: p.maxDiscount?.toFixed(2) ?? null,
        budget: p.budget.toFixed(2), startsAt: p.startsAt.toISOString(), endsAt: p.endsAt.toISOString(),
        status: input.activate ? "active" : "draft", categories: p.categories.length, merchants: p.merchantIds.length,
      });
      return { promotionId: id };
    });
  } catch (error) {
    friendlyDbError(error);
  }
}

type LockedPromotion = {
  id: string; code: string; name: string; description: string | null; status: string; discount_type: string;
  discount_value: string; max_discount: string | null; min_subtotal: string; usage_limit: number | null;
  per_customer_limit: number; starts_at: Date; ends_at: Date; first_order_only: boolean; is_public: boolean;
  funding_source: string; budget: string | null; used: string; categories: string[]; merchant_ids: string[];
};

async function lockMarketplacePromotion(sql: Sql, promotionId: string): Promise<LockedPromotion> {
  const [row] = await sql.query<LockedPromotion>(
    `select p.id,p.code,p.name,p.description,p.status,p.discount_type,p.discount_value::text,p.max_discount::text,p.min_subtotal::text,
            p.usage_limit,p.per_customer_limit,p.starts_at,p.ends_at,p.first_order_only,p.is_public,p.funding_source,
            b.max_discount_amount::text as budget,
            (coalesce(b.reserved_discount_amount,0)+coalesce(b.consumed_discount_amount,0))::text as used,
            coalesce((select array_agg(c.category order by c.category) from promotion_categories c where c.promotion_id=p.id),'{}') as categories,
            coalesce((select array_agg(m.merchant_id order by m.merchant_id) from promotion_merchants m where m.promotion_id=p.id),'{}') as merchant_ids
       from promotions p left join promotion_budgets b on b.promotion_id=p.id
      where p.id=$1 for update of p`,
    [promotionId],
  );
  if (!row || row.funding_source !== "platform") throw new Error("Marketplace promotion not found");
  // Lock the budget row too, after the promotion (same order as checkout).
  await sql.query(`select 1 from promotion_budgets where promotion_id=$1 for update`, [promotionId]);
  return row;
}

const sameMoney = (a: string | number | null | undefined, b: string | number | null | undefined) =>
  (a == null || a === "" ? null : Math.round(Number(a) * 100)) === (b == null || b === "" ? null : Math.round(Number(b) * 100));
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/**
 * Before the start: every field may change. After the start: only a shorter
 * end date (not in the past) and a larger budget. Status changes go through
 * pause/resume. The database enforces the same rule (validate_promotion_definition).
 */
export async function updateMarketplacePromotion(actorId: string, input: MarketplacePromotionInput & { promotionId: string }) {
  try {
    return await withTransaction(async (sql) => {
      const current = await lockMarketplacePromotion(sql, input.promotionId);
      const now = new Date();
      const started = new Date(current.starts_at).getTime() <= now.getTime();
      const budget = money(input.budget, "Budget");
      const used = Number(current.used);
      if (Math.round(budget * 100) < Math.round(used * 100)) throw new Error("Budget cannot be lower than what has already been used or reserved");

      if (!started) {
        const p = normalizeMarketplacePromotion(input, now);
        await assertScope(sql, p.categories, p.merchantIds);
        await sql.query(
          `update promotions set code=$2,name=$3,description=$4,discount_type=$5,discount_value=$6,min_subtotal=$7,max_discount=$8,
                  usage_limit=$9,per_customer_limit=$10,starts_at=$11,ends_at=$12,first_order_only=$13,is_public=$14,updated_at=now()
            where id=$1`,
          [current.id, p.code, p.name, p.description, p.discountType, p.discountValue, p.minSubtotal, p.maxDiscount, p.usageLimit,
            p.perCustomerLimit, p.startsAt.toISOString(), p.endsAt.toISOString(), p.firstOrderOnly, p.isPublic],
        );
        await sql.query(`update promotion_budgets set max_discount_amount=$2,version=version+1,updated_at=now() where promotion_id=$1`, [current.id, budget]);
        await replaceScope(sql, current.id, p.categories, p.merchantIds);
        await audit(sql, "admin.promotion.marketplace.updated", "promotion", current.id, actorId, {
          phase: "before_start", code: p.code, discountType: p.discountType, discountValue: p.discountValue.toFixed(2),
          maxDiscount: p.maxDiscount?.toFixed(2) ?? null, budgetFrom: current.budget, budgetTo: budget.toFixed(2),
          startsAt: p.startsAt.toISOString(), endsAt: p.endsAt.toISOString(),
        });
        return { promotionId: current.id, started: false };
      }

      // Started: reject any change other than end shortening / budget increase.
      const changed: string[] = [];
      if (String(input.code ?? "").trim().toUpperCase() !== current.code.toUpperCase()) changed.push("code");
      if (String(input.name ?? "").trim() !== current.name) changed.push("name");
      if ((input.description?.trim() || null) !== (current.description || null)) changed.push("description");
      if (input.discountType !== current.discount_type) changed.push("discount type");
      if (!sameMoney(input.discountValue, current.discount_value)) changed.push("discount");
      if (!sameMoney(input.maxDiscount, current.max_discount)) changed.push("maximum discount");
      if (!sameMoney(input.minSubtotal || "0", current.min_subtotal)) changed.push("minimum basket");
      if ((input.usageLimit ?? null) !== (current.usage_limit ?? null)) changed.push("usage limit");
      if (Number(input.perCustomerLimit) !== current.per_customer_limit) changed.push("uses per customer");
      if (parseDate(input.startsAt, "Start").getTime() !== new Date(current.starts_at).getTime()) changed.push("start");
      if (Boolean(input.firstOrderOnly) !== current.first_order_only) changed.push("first order only");
      if (Boolean(input.isPublic) !== current.is_public) changed.push("public listing");
      if (!sameSet(input.categories ?? [], current.categories)) changed.push("categories");
      if (!sameSet(input.merchantIds ?? [], current.merchant_ids)) changed.push("merchants");
      if (changed.length) throw new Error(`This promotion has started. Only a shorter end date or a larger budget can change (not: ${changed.join(", ")}).`);

      const endsAt = parseDate(input.endsAt, "End");
      const oldEnd = new Date(current.ends_at);
      const endChanged = endsAt.getTime() !== oldEnd.getTime();
      if (endChanged) {
        if (endsAt.getTime() > oldEnd.getTime()) throw new Error("A started promotion's end date can only be brought forward");
        if (endsAt.getTime() < now.getTime() - 60_000) throw new Error("End cannot be in the past");
      }
      const budgetChanged = !sameMoney(budget, current.budget);
      if (budgetChanged && Math.round(budget * 100) < Math.round(Number(current.budget) * 100)) {
        throw new Error("A started promotion's budget can only be increased");
      }
      if (!endChanged && !budgetChanged) return { promotionId: current.id, started: true, unchanged: true };
      if (endChanged) {
        const end = endsAt.getTime() < now.getTime() ? now : endsAt;
        await sql.query(`update promotions set ends_at=$2,updated_at=now() where id=$1`, [current.id, end.toISOString()]);
      }
      if (budgetChanged) {
        await sql.query(`update promotion_budgets set max_discount_amount=$2,version=version+1,updated_at=now() where promotion_id=$1`, [current.id, budget]);
      }
      await audit(sql, "admin.promotion.marketplace.updated", "promotion", current.id, actorId, {
        phase: "after_start",
        endsAtFrom: endChanged ? oldEnd.toISOString() : undefined, endsAtTo: endChanged ? endsAt.toISOString() : undefined,
        budgetFrom: budgetChanged ? current.budget : undefined, budgetTo: budgetChanged ? budget.toFixed(2) : undefined,
      });
      return { promotionId: current.id, started: true };
    });
  } catch (error) {
    friendlyDbError(error);
  }
}

function reasonText(reason: string) {
  const r = String(reason ?? "").trim();
  if (r.length < 5 || r.length > 500) throw new Error("Give a reason of 5–500 characters");
  return r;
}

export async function setMarketplacePromotionPaused(actorId: string, input: { promotionId: string; paused: boolean; reason: string }) {
  const reason = reasonText(input.reason);
  return withTransaction(async (sql) => {
    const current = await lockMarketplacePromotion(sql, input.promotionId);
    if (current.status === "archived") throw new Error("This promotion is archived");
    if (input.paused) {
      if (current.status === "paused") return { status: "paused", unchanged: true };
      if (current.status !== "active") throw new Error("Only an active promotion can be paused");
    } else {
      if (current.status === "active") return { status: "active", unchanged: true };
      if (new Date(current.ends_at).getTime() <= Date.now()) throw new Error("This promotion has ended");
      if (!current.budget || Number(current.budget) <= 0) throw new Error("Set a budget before activating");
    }
    const next = input.paused ? "paused" : "active";
    await sql.query(`update promotions set status=$2,updated_at=now() where id=$1`, [current.id, next]);
    await audit(sql, input.paused ? "admin.promotion.marketplace.paused" : "admin.promotion.marketplace.resumed", "promotion", current.id, actorId,
      { from: current.status, to: next, reason });
    return { status: next };
  });
}

/**
 * Pause (hold) or resume a merchant-run promotion or flash sale. Admins never
 * edit merchant terms. A held promotion cannot be reactivated except by an
 * admin resume (CHECK promotions_admin_pause_check / flash_sales_admin_pause_check).
 */
export async function setMerchantPromotionHold(actorId: string, input: { kind: "coupon" | "flash_sale"; id: string; paused: boolean; reason: string }) {
  const reason = reasonText(input.reason);
  return withTransaction(async (sql) => {
    if (input.kind === "coupon") {
      const [row] = await sql.query<{ id: string; status: string; funding_source: string; merchant_id: string | null; ends_at: Date; admin_paused_at: Date | null }>(
        `select id,status,funding_source,merchant_id,ends_at,admin_paused_at from promotions where id=$1 for update`, [input.id]);
      if (!row || row.funding_source !== "merchant") throw new Error("Merchant promotion not found");
      if (input.paused) {
        if (row.admin_paused_at) return { status: "paused", unchanged: true };
        if (row.status !== "active") throw new Error("Only an active promotion can be paused");
        await sql.query(
          `update promotions set status='paused',admin_paused_at=now(),admin_paused_by=$2,admin_pause_reason=$3,updated_at=now() where id=$1`,
          [row.id, actorId, reason]);
      } else {
        if (!row.admin_paused_at) throw new Error("This promotion is not paused by ELEMARKET");
        if (new Date(row.ends_at).getTime() <= Date.now()) throw new Error("This promotion has ended; it stays paused");
        await sql.query(
          `update promotions set status='active',admin_paused_at=null,admin_paused_by=null,admin_pause_reason=null,updated_at=now() where id=$1`,
          [row.id]);
      }
      await audit(sql, input.paused ? "admin.promotion.merchant.paused" : "admin.promotion.merchant.resumed", "promotion", row.id, actorId,
        { merchantId: row.merchant_id, reason });
      return { status: input.paused ? "paused" : "active" };
    }
    const [row] = await sql.query<{ id: string; status: string; merchant_id: string; starts_at: Date; ends_at: Date; admin_paused_at: Date | null }>(
      `select id,status,merchant_id,starts_at,ends_at,admin_paused_at from flash_sales where id=$1 for update`, [input.id]);
    if (!row) throw new Error("Flash sale not found");
    let next: string;
    if (input.paused) {
      if (row.admin_paused_at) return { status: "paused", unchanged: true };
      if (row.status !== "active" && row.status !== "scheduled") throw new Error("Only an active or scheduled flash sale can be paused");
      next = "paused";
      await sql.query(
        `update flash_sales set status='paused',admin_paused_at=now(),admin_paused_by=$2,admin_pause_reason=$3,updated_at=now() where id=$1`,
        [row.id, actorId, reason]);
    } else {
      if (!row.admin_paused_at) throw new Error("This flash sale is not paused by ELEMARKET");
      if (new Date(row.ends_at).getTime() <= Date.now()) throw new Error("This flash sale has ended; it stays paused");
      next = new Date(row.starts_at).getTime() > Date.now() ? "scheduled" : "active";
      await sql.query(
        `update flash_sales set status=$2,admin_paused_at=null,admin_paused_by=null,admin_pause_reason=null,updated_at=now() where id=$1`,
        [row.id, next]);
    }
    await audit(sql, input.paused ? "admin.flash_sale.paused" : "admin.flash_sale.resumed", "flash_sale", row.id, actorId,
      { merchantId: row.merchant_id, reason });
    return { status: next };
  });
}

/** Categories and merchants an admin can scope a marketplace promotion to. */
export type PromotionScopeOptions = { categories: Array<{ key: string; name: string }>; merchants: Array<{ id: string; name: string }> };

export async function loadPromotionScopeOptions(sql?: Sql): Promise<PromotionScopeOptions> {
  const db = sql ?? (await getSql());
  const [categories, merchants] = await Promise.all([
    db.query<{ key: string; name: string }>(`select category_key as key,name from category_taxonomy where active order by sort_order,name`),
    db.query<{ id: string; name: string }>(`select id,name from merchants where status='active' and verified order by name limit 500`),
  ]);
  return { categories, merchants };
}

/** Public: active, public marketplace promotions shown on /deals. No budgets or usage. */
export async function listPublicDeals(sql?: Sql) {
  const db = sql ?? (await getSql());
  return db.query<{ code: string; name: string; description: string | null; discount_type: string; discount_value: string;
    max_discount: string | null; min_subtotal: string; ends_at: string; first_order_only: boolean; categories: string[] }>(
    `select p.code,p.name,p.description,p.discount_type,p.discount_value::text,p.max_discount::text,p.min_subtotal::text,p.ends_at,p.first_order_only,
            coalesce((select array_agg(t.name order by t.sort_order) from promotion_categories c join category_taxonomy t on t.category_key=c.category where c.promotion_id=p.id),'{}') as categories
       from promotions p
       join promotion_budgets b on b.promotion_id=p.id
      where p.funding_source='platform' and p.is_public and p.status='active'
        and p.starts_at<=now() and p.ends_at>now()
        and b.max_discount_amount is not null
        and b.reserved_discount_amount+b.consumed_discount_amount < b.max_discount_amount
      order by p.ends_at asc
      limit 50`,
  );
}

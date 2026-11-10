import { createHash } from 'node:crypto';
import { quoteCartCanonical } from '../../src/lib/commerce-guards.mjs';
export async function createPaymentFixture(query) {
  const execStatements = async statements => { for (const statement of statements) await query(statement.sql, statement.params ?? []); };
  const n = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const ids = {
    user: `it_user_${n}`,
    merchant: `it_merch_${n}`,
    quote: `it_quote_${n}`,
    group: `it_group_${n}`,
    product: `it_product_${n}`,
    variant: `it_variant_${n}`,
    order: `it_order_${n}`,
    payment: `it_payment_${n}`,
    idem: `it_idem_${n}`,
    fingerprint: "f".repeat(64),
    quoteFingerprint: null,
    provider: `it-provider-${n}`,
    event: `it_event_${n}`,
    phone: '+2332' + String(Math.floor(Math.random()*1e8)).padStart(8,'0'),
  };
  ids.quoteFingerprint = createHash('sha256').update(quoteCartCanonical({
    merchantId: ids.merchant, address: '1 Test Street', tier: 'same_day',
    items: [{ productId: ids.product, variantId: ids.variant, quantity: 1 }],
  })).digest('hex');
  // Stock is 0 because the single unit is already held by the reservation below,
  // matching what create_pending_order leaves behind.
  await execStatements([
    {
      sql: `
        insert into "user"(
          id, name, email, "emailVerified"
        )
        values(
          $1, 'Integration Customer', $2, true
        )
      `,
      params: [ids.user, `${ids.user}@integration.test`],
    },
    // Simulated phone OTP: SMS challenge verified, then bound via confirm_phone_verification().
    { sql: `insert into profiles(user_id, name, phone) values($1, 'Integration Customer', $2)`, params: [ids.user, ids.phone] },
    { sql: `insert into otp_challenges(id, user_id, destination, purpose, provider, status, expires_at, cooldown_until, verified_at)
             values($1, $2, $3, 'phone_verification', 'mock-sms', 'verified', now() + interval '10 minutes', now(), now())`,
      params: [`it_otp_${n}`, ids.user, ids.phone] },
    { sql: `select confirm_phone_verification($1, $2)`, params: [ids.user, `it_otp_${n}`] },
    {
      sql: `
        insert into merchants(
          id, name, category, status, verified, tier, address, city,
          neighborhood, lat, lon, catalog_categories
        )
        values(
          $1, 'Integration Merchant', 'electronics', 'active', true,
          'merchant', '1 Test Street', 'Accra', 'Test', 5.6037, -0.1870, ARRAY['electronics']
        )
      `,
      params: [ids.merchant],
    },
    {
      sql: `
        insert into delivery_quotes(
          id, user_id, merchant_id, fingerprint, tier, price,
          eta_minutes, distance_km, dest_address, expires_at
        )
        values(
          $1, $2, $3, $4, 'same_day', 15,
          60, 1, '1 Test Street', now() + interval '1 hour'
        )
      `,
      params: [ids.quote, ids.user, ids.merchant, ids.quoteFingerprint],
    },
    {
      sql: `
        insert into order_groups(id, user_id)
        values($1, $2)
      `,
      params: [ids.group, ids.user],
    },
    {
      sql: `
        insert into products(
          id, merchant_id, name, category, price, currency,
          stock, description
        )
        values(
          $1, $2, 'Integration SKU', 'electronics', 100,
          'GHS', 0, 'integration'
        )
      `,
      params: [ids.product, ids.merchant],
    },
    {
      sql: `
        insert into product_variants(
          id, product_id, sku, name, attributes, price, stock, status
        )
        values(
          $1, $2, 'IT-SKU', 'Default', '{}'::jsonb,
          100, 0, 'active'
        )
      `,
      params: [ids.variant, ids.product],
    },
    {
      sql: `
        insert into order_idempotency(
          idem, user_id, fingerprint, group_id
        )
        values($1, $2, $3, $4)
      `,
      params: [ids.idem, ids.user, ids.fingerprint, ids.group],
    },
    {
      sql: `
        insert into orders(
          id, group_id, user_id, merchant_id, status, currency,
          product_total, original_product_total, delivery_total, platform_fee, merchant_net,
          grand_total, delivery_tier, delivery_quote_id, address,
          payment_deadline
        )
        values(
          $1, $2, $3, $4, 'payment_pending', 'GHS',
          100, 100, 15, 0, 100,
          115, 'same_day', $5,
          '1 Test Street', now() + interval '15 minutes'
        )
      `,
      params: [
        ids.order,
        ids.group,
        ids.user,
        ids.merchant,
        ids.quote,
      ],
    },
    {
      sql: `
        insert into order_items(
          order_id, product_id, variant_id, quantity,
          unit_price, currency, product_total
        )
        values($1, $2, $3, 1, 100, 'GHS', 100)
      `,
      params: [ids.order, ids.product, ids.variant],
    },
    {
      sql: `
        insert into order_stock_reservations(
          order_id, order_item_id, product_id, variant_id,
          quantity, status
        )
        select $1, id, $2, $3, 1, 'reserved'
        from order_items
        where order_id = $1
      `,
      params: [ids.order, ids.product, ids.variant],
    },
    {
      sql: `
        insert into payment_providers(
          id, provider_key, name, method, status
        )
        values($1, $2, 'Integration Provider', 'mobile_money', 'active')
      `,
      params: [ids.provider, ids.provider],
    },
    {
      sql: `
        insert into payments(
          id, order_id, user_id, amount, currency,
          method, status, provider_key
        )
        values(
          $1, $2, $3, 115, 'GHS',
          'mobile_money', 'initiated', $4
        )
      `,
      params: [
        ids.payment,
        ids.order,
        ids.user,
        ids.provider,
      ],
    },
  ]);
  return ids;
}

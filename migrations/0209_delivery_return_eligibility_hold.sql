-- Marketplace eligibility only. This neither holds funds nor establishes an
-- external settlement contract. Partial returns conservatively block the order.
CREATE FUNCTION elemarket_delivery_locally_eligible(p_order text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM orders o WHERE o.id=p_order AND o.status IN ('delivered','completed')
  AND elemarket_order_delivered_at(o.id) IS NOT NULL AND now()>=elemarket_order_delivered_at(o.id)+interval '24 hours'
  AND EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.status='completed')
  AND NOT EXISTS(SELECT 1 FROM order_delivery_holds h WHERE h.order_id=o.id AND h.active)
  AND NOT EXISTS(SELECT 1 FROM customer_order_disputes d WHERE d.order_id=o.id AND
    (d.status IN ('open','under_review') OR d.created_at<=elemarket_order_delivered_at(o.id)+interval '24 hours'))
  AND NOT EXISTS(SELECT 1 FROM return_requests r WHERE r.order_id=o.id AND r.status NOT IN ('rejected','cancelled'))
  AND NOT EXISTS(SELECT 1 FROM provider_refund_requests r WHERE r.order_id=o.id AND r.status IN ('requested','processing','needs_attention','processed')))
$$;
CREATE OR REPLACE VIEW merchant_provider_funds_summary AS
SELECT m.id merchant_id,m.name merchant_name,
 coalesce(e.eligible_amount,0)::numeric(12,2) provider_held_eligible_amount,
 coalesce(e.eligible_amount,0)::numeric(12,2) provider_requestable_amount
FROM merchants m LEFT JOIN LATERAL(
 SELECT coalesce(sum(o.merchant_net),0)::numeric(12,2) eligible_amount FROM orders o
 WHERE o.merchant_id=m.id AND elemarket_delivery_locally_eligible(o.id)
) e ON true;
COMMENT ON FUNCTION elemarket_delivery_locally_eligible(text) IS 'Conservative whole-order marketplace eligibility; never proof of an external hold or permission for partial payout.';

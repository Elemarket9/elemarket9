-- Cancellation frees allocation but never creates receipt. A fully verified
-- replacement must cover every required item quantity before aggregate receipt.
CREATE OR REPLACE FUNCTION elemarket_order_delivered_at(p_order_id text)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM shipments WHERE order_id=p_order_id) THEN
  CASE WHEN
   NOT EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=p_order_id
    AND i.quantity<>coalesce((SELECT sum(si.quantity) FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id
      WHERE si.order_item_id=i.id AND s.order_id=p_order_id AND s.status='delivered'),0))
   AND NOT EXISTS(SELECT 1 FROM shipments s WHERE s.order_id=p_order_id AND s.status<>'cancelled'
    AND (s.status<>'delivered' OR NOT EXISTS(SELECT 1 FROM delivery_jobs j
      JOIN order_delivery_handover h ON h.job_id=j.id AND h.order_id=j.order_id
      JOIN delivery_otp_verifiers v ON v.challenge_id=h.challenge_id AND v.job_id=j.id AND v.consumed_at IS NOT NULL
      WHERE j.shipment_id=s.id AND j.order_id=p_order_id AND j.status='delivered' AND h.verified_at IS NOT NULL)))
   AND EXISTS(SELECT 1 FROM shipments WHERE order_id=p_order_id AND status='delivered')
   AND NOT EXISTS(SELECT 1 FROM delivery_jobs WHERE order_id=p_order_id AND shipment_id IS NULL)
  THEN (SELECT max(h.verified_at) FROM order_delivery_handover h WHERE h.order_id=p_order_id AND h.verified_at IS NOT NULL)
  ELSE NULL END
 ELSE coalesce((SELECT max(h.verified_at) FROM order_delivery_handover h
   JOIN delivery_jobs j ON j.id=h.job_id AND j.order_id=h.order_id
   JOIN delivery_otp_verifiers v ON v.challenge_id=h.challenge_id AND v.job_id=j.id AND v.consumed_at IS NOT NULL
   WHERE h.order_id=p_order_id AND h.verified_at IS NOT NULL AND j.status='delivered'),
  (SELECT customer_received_at FROM orders WHERE id=p_order_id AND delivery_confirmation_source IN ('customer_confirmation','delivery_otp')))
 END
$$;

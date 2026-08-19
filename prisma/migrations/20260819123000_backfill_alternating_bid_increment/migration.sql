WITH bid_steps AS (
  SELECT
    bid.lot_id,
    bid.amount_cents,
    ROW_NUMBER() OVER (
      PARTITION BY bid.lot_id
      ORDER BY bid.lot_sequence ASC, bid.id ASC
    ) AS bid_number,
    LAG(bid.amount_cents) OVER (
      PARTITION BY bid.lot_id
      ORDER BY bid.lot_sequence ASC, bid.id ASC
    ) AS previous_amount_cents
  FROM effective_bid AS bid
  WHERE bid.voided_at IS NULL
),
increment_states AS (
  SELECT
    step.lot_id,
    (SUM(
      CASE
        WHEN step.bid_number = 1
          AND step.amount_cents > CASE
            WHEN lot.starting_bid_cents > 0 THEN lot.starting_bid_cents
            ELSE lot.increment_cents
          END
          THEN 1
        WHEN step.bid_number > 1
          AND step.amount_cents > step.previous_amount_cents
          THEN 1
        ELSE 0
      END
    ) % 2 = 1) AS next_increment_is_secondary
  FROM bid_steps AS step
  INNER JOIN auction_lot_execution AS lot ON lot.id = step.lot_id
  GROUP BY step.lot_id
)
UPDATE auction_lot_execution AS lot
SET next_increment_is_secondary = state.next_increment_is_secondary
FROM increment_states AS state
WHERE state.lot_id = lot.id;

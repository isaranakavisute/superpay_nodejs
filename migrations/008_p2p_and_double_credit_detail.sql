-- Detail the P2P and double-credit pages show. Additive / own tables only (004).

-- P2P pairs use the lifecycle the console shows: reserved → settled, or
-- released (paid nothing); disputed when the two sides disagree.
ALTER TABLE p2p_matches DROP CONSTRAINT p2p_matches_status_check;
UPDATE p2p_matches SET status = CASE status
  WHEN 'pending' THEN 'reserved' WHEN 'matched' THEN 'disputed'
  WHEN 'released' THEN 'settled' WHEN 'cancelled' THEN 'released' ELSE status END;
ALTER TABLE p2p_matches ADD CONSTRAINT p2p_matches_status_check
  CHECK (status IN ('reserved', 'settled', 'disputed', 'released'));
ALTER TABLE p2p_matches
  ADD COLUMN receiver_account text,
  ADD COLUMN dispute_reason   text,
  ADD COLUMN settled_at       timestamptz,
  ADD COLUMN released_at      timestamptz;

-- Double credits: how sure the detector is, how a case was closed, and who
-- approved the order that got the money twice.
ALTER TABLE double_credits
  ADD COLUMN confidence      text NOT NULL DEFAULT 'review'
    CHECK (confidence IN ('confirmed', 'likely', 'review')),
  ADD COLUMN resolution_kind text CHECK (resolution_kind IN ('clawback', 'not_duplicate')),
  ADD COLUMN approved_by     text,
  ADD COLUMN approved_at     timestamptz,
  ADD COLUMN bank_ref        text,
  ADD COLUMN resolved_at     timestamptz;

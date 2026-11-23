-- The home marker only existed to queue the retired referral reward flow.
ALTER TABLE users DROP COLUMN home_at;

-- Remove the retired referral rewards and wallet balance columns.
DROP TABLE IF EXISTS referrals;
ALTER TABLE users DROP COLUMN balance;
ALTER TABLE users DROP COLUMN balance_inr;
ALTER TABLE users DROP COLUMN referred_by;
ALTER TABLE users DROP COLUMN referral_earnings_inr;
ALTER TABLE users DROP COLUMN last_bonus_at;

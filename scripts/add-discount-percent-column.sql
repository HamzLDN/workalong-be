-- Migration: Add subscription_discount_percent column to users table
-- This stores the discount percentage (0-100) applied to subscriptions
-- NULL means no discount, 100 means 100% free

-- Add the column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'users' 
        AND column_name = 'subscription_discount_percent'
    ) THEN
        ALTER TABLE users 
        ADD COLUMN subscription_discount_percent INTEGER CHECK (subscription_discount_percent >= 0 AND subscription_discount_percent <= 100);
        
        COMMENT ON COLUMN users.subscription_discount_percent IS 'Discount percentage (0-100) applied to subscription. NULL = no discount, 100 = 100% free';
        
        RAISE NOTICE 'Column subscription_discount_percent added successfully';
    ELSE
        RAISE NOTICE 'Column subscription_discount_percent already exists';
    END IF;
END $$;


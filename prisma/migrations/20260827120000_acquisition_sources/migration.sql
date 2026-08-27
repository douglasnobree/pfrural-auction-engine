CREATE TYPE "AcquisitionSource" AS ENUM ('DIRECT', 'WHATSAPP', 'FACEBOOK', 'INSTAGRAM', 'GOOGLE', 'TIKTOK', 'REFERRAL', 'ORGANIC', 'OTHER', 'UNKNOWN');

ALTER TABLE "auction_registration"
ADD COLUMN "acquisition_source" "AcquisitionSource" NOT NULL DEFAULT 'UNKNOWN';

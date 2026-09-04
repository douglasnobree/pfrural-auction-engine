ALTER TABLE "auction_registration"
ADD COLUMN "whatsapp_opt_in" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "whatsapp_consent_at" TIMESTAMP(3),
ADD COLUMN "whatsapp_consent_version" TEXT;

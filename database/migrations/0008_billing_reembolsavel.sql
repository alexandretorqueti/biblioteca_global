ALTER TABLE `assinaturas`
  MODIFY COLUMN `status` enum('pending','active','past_due','canceled','expired','reembolsavel') NOT NULL DEFAULT 'pending';

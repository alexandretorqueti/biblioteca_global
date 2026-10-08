-- Estado terminal administrativo para pedidos de deploy dispensados.
ALTER TABLE `deploy_requests`
  MODIFY COLUMN `status` ENUM('pending','running','succeeded','failed','cancelled') NOT NULL DEFAULT 'pending';

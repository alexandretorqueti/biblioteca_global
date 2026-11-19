-- Lease único por banco para o conjunto de consumidores duráveis do Motor.
CREATE TABLE IF NOT EXISTS `motor_queue_leadership` (
  `leadership_key` varchar(100) NOT NULL,
  `holder_id` varchar(255) NOT NULL,
  `lease_expires_at` timestamp(3) NOT NULL,
  `acquired_at` timestamp(3) NOT NULL,
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`leadership_key`),
  KEY `motor_queue_leadership_expiry_idx` (`lease_expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Realocação do script de deploy blue-green para fora do motor-v2.
-- O script foi movido de projects/gerenteagentes/motor-v2/scripts/deploy-blue-green.sh
-- para projects/gerenteagentes/scripts/deploy-blue-green.sh (fase 1 da remoção do motor-v2).
-- Idempotente: só atualiza quando o valor ainda aponta para o caminho antigo.
UPDATE `motor_configuracoes`
SET `valor` = '"projects/gerenteagentes/scripts/deploy-blue-green.sh"'
WHERE `chave` = 'motor.deploy_script'
  AND `valor` != '"projects/gerenteagentes/scripts/deploy-blue-green.sh"';

-- O valor inicial foi criado pela 0046 antes do deploy blue-green.
-- Atualiza instalações existentes sem depender de INSERT IGNORE.
UPDATE motor_configuracoes
SET valor = '"projects/gerenteagentes/motor-v2/scripts/deploy-blue-green.sh"',
    valor_padrao = '"projects/gerenteagentes/motor-v2/scripts/deploy-blue-green.sh"'
WHERE chave = 'motor.deploy_script';

-- O gate do projeto GerenteAgentes deve validar o motor e as telas customizadas.
-- O primeiro comando roda com a configuração do motor; o segundo usa a
-- configuração Vitest da raiz, que inclui projects/gerenteagentes/screens.
UPDATE projeto_motor_config
SET unit_test_command = 'cd projects/gerenteagentes/motor-v2 && npx vitest run && cd ../../.. && npx vitest run projects/gerenteagentes/screens'
WHERE projeto_id = 2;

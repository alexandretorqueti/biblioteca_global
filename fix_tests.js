const fs = require('fs');

const f = 'projects/gerenteagentes/screens/__tests__/DashboardScreen.test.tsx';
if(fs.existsSync(f)) {
  let code = fs.readFileSync(f, 'utf8');
  code = code.replace(/\{getCustomScreen\(([^)]+)\)!\(\)\}/g, '{(() => { const Comp = getCustomScreen($1)!; return <Comp />; })()}');
  fs.writeFileSync(f, code);
}

const m = 'packages/ui/src/components/SistemaMenu.tsx';
if(fs.existsSync(m)) {
  let code = fs.readFileSync(m, 'utf8');
  code = code.replace(/<ListSubheader/g, '<ListSubheader component="div"');
  fs.writeFileSync(m, code);
}

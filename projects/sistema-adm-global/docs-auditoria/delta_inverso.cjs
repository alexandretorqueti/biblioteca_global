// READ-ONLY: divergências na direção schema=NOT NULL vs legado=nullável (e defaults ausentes no schema)
const fs=require("fs");const {createDecipheriv}=require("crypto");
const env=fs.readFileSync(".env","utf8");
const key=env.match(/DB_CREDENTIALS_ENCRYPTION_KEY=(.+)$/m)[1].trim();
const root=env.match(/MYSQL_ROOT_PASSWORD=(.+)$/m)[1].trim();
const mysql=require("mysql2/promise");
const keyBuf=/^[0-9a-f]{64}$/i.test(key)?Buffer.from(key,"hex"):Buffer.from(key,"base64");
const schema=fs.readFileSync(".motor-v3-worktrees/task-p6-1001/1365/a1/projects/sistema-adm-global/schema.ts","utf8");
// parsing simples: tabelas e colunas com .notNull()
const tabelas={};let cur=null;
for(const linha of schema.split("\n")){
  const mT=linha.match(/mysqlTable\("([^"]+)"/);if(mT){cur=mT[1];tabelas[cur]={};continue}
  const mC=linha.match(/^\s*([A-Za-z_]+):\s*\w+\("([^"]+)"/);
  if(mC&&cur){tabelas[cur][mC[2]]={notNull:/\.notNull\(\)/.test(linha),temDefault:/\.default\(/.test(linha)||/\.defaultNow\(\)/.test(linha)}}
}
(async()=>{
 const c=await mysql.createConnection({host:"host.docker.internal",port:3308,user:"root",password:root});
 const [r]=await c.query("SELECT db_password_criptografado FROM core.projetos WHERE id=6241");await c.end();
 const [iv,tag,ct]=r[0].db_password_criptografado.split(":").map(p=>Buffer.from(p,"base64"));
 const d=createDecipheriv("aes-256-gcm",keyBuf,iv);d.setAuthTag(tag);
 const senha=Buffer.concat([d.update(ct),d.final()]).toString("utf8");
 const l=await mysql.createConnection({host:"bdportalemp.mysql.dbaas.com.br",port:3306,user:"bdportalemp",password:senha,database:"bdportalemp",connectTimeout:15000});
 const [cols]=await l.query("SELECT TABLE_NAME t, COLUMN_NAME c, IS_NULLABLE n, COLUMN_DEFAULT df, EXTRA x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='bdportalemp'");
 const mapa={};cols.forEach(x=>{(mapa[x.t]=mapa[x.t]||{})[x.c]=x});
 for(const [t,cs] of Object.entries(tabelas)){
   const leg=mapa[t];if(!leg){console.log(t,": AUSENTE NO LEGADO");continue}
   for(const [col,sc] of Object.entries(cs)){
     const lc=leg[col];if(!lc){console.log(`${t}.${col}: no schema, FALTANDO no legado`);continue}
     if(sc.notNull&&lc.n==="YES")console.log(`${t}.${col}: schema=NOT NULL, legado=ANULAVEL (sem default no schema: ${!sc.temDefault})`);
     if(!sc.notNull&&lc.n==="NO"&&lc.df===null&&!/auto_increment/.test(lc.x))console.log(`${t}.${col}: schema=anulavel, legado=NOT NULL sem default → INSERT sem valor falha`);
   }
 }
 console.log("EXTRA legado: circular.id =",JSON.stringify(mapa.circular.id), "| config_empresa.id =",JSON.stringify(mapa.config_empresa.id));
 await l.end();
})().catch(e=>{console.error("ERR",e.code||e.message);process.exit(1)})

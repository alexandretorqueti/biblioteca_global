# Guia de Uso do VNC - WebAI Provider

## O que é VNC?

VNC (Virtual Network Computing) permite que você veja e controle remotamente o desktop do container onde o Chrome está rodando. Com isso, você pode:

- ✅ Logar manualmente nas IAs web (Gemini, GPT, Claude)
- ✅ Ver o que o Chrome está fazendo em tempo real
- ✅ Debugar problemas de automação
- ✅ Tirar screenshots para documentação

---

## Acesso via noVNC (navegador)

### 1. Subir o container

```bash
cd /data/workspace/projects/agentes/gerenteagentes/chrome-gemini-runner
docker-compose up -d
```

### 2. Acessar via navegador

De **qualquer máquina na rede**, abra o navegador e acesse:

```
http://192.168.1.8:6080/vnc.html
```

**Substitua `192.168.1.8` pelo IP do seu host ServerIA.**

### 3. Conectar

- **Senha:** `global` (ou a senha configurada em `VNC_PASSWORD` no docker-compose.yml)
- **Resolução:** 1280x1024 (configurável em `RESOLUTION`)

Você verá um desktop com o Chrome aberto.

---

## Logando nas IAs Web

### Gemini

1. No Chrome do VNC, navegue para: `https://gemini.google.com/`
2. Faça login com sua conta Google
3. **Perfil é salvo automaticamente** em `/tmp/webai-chrome-profile`
4. O WebAI Provider reutiliza o login nas próximas execuções

### ChatGPT

1. Navegue para: `https://chat.openai.com/`
2. Faça login com sua conta OpenAI
3. Perfil salvo automaticamente

### Claude

1. Navegue para: `https://claude.ai/`
2. Faça login com sua conta Anthropic
3. Perfil salvo automaticamente

---

## Persistência do Perfil

O perfil do Chrome é salvo em um **volume Docker persistente**:

```yaml
volumes:
  - webai-chrome-profile:/tmp/webai-chrome-profile
```

**O que isso significa:**
- ✅ Login persiste entre restarts do container
- ✅ Login persiste entre recriações do container (enquanto o volume existir)
- ❌ Se você remover o volume (`docker-compose down -v`), o login é perdido

**Para ver os volumes:**
```bash
docker volume ls | grep webai
```

**Para backup do perfil:**
```bash
docker run --rm -v webai-provider_webai-chrome-profile:/data -v $(pwd):/backup \
  alpine tar czf /backup/chrome-profile-backup.tar.gz /data
```

**Para restaurar:**
```bash
docker run --rm -v webai-provider_webai-chrome-profile:/data -v $(pwd):/backup \
  alpine tar xzf /backup/chrome-profile-backup.tar.gz -C /
```

---

## Configurações

### Senha do VNC

Edite `docker-compose.yml`:

```yaml
environment:
  - VNC_PASSWORD=sua_senha_aqui
```

Reinicie o container:
```bash
docker-compose restart
```

### Resolução do Desktop

Edite `docker-compose.yml`:

```yaml
environment:
  - RESOLUTION=1920x1080x24  # Full HD
```

Reinicie o container.

### Desabilitar VNC (modo headless)

Se não precisa de VNC, edite `docker-compose.yml`:

```yaml
environment:
  - HEADLESS=true  # Chrome roda sem display
```

E remova a porta `6080`:

```yaml
ports:
  - "3100:3100"  # Apenas API
  # - "6080:6080"  # Remova ou comente esta linha
```

---

## Troubleshooting

### Não consigo acessar o noVNC

1. **Verifique se o container está rodando:**
   ```bash
   docker ps | grep webai-provider
   ```

2. **Verifique se a porta 6080 está exposta:**
   ```bash
   docker port webai-provider
   ```
   Deve mostrar: `6080/tcp -> 0.0.0.0:6080`

3. **Verifique firewall:**
   ```bash
   sudo ufw status
   ```
   Se necessário, libere a porta:
   ```bash
   sudo ufw allow 6080/tcp
   ```

4. **Teste do próprio host:**
   ```bash
   curl http://localhost:6080/vnc.html
   ```

### Chrome não abre no VNC

1. **Verifique os logs:**
   ```bash
   docker logs webai-provider
   ```

2. **Procure por erros de Xvfb ou VNC:**
   ```bash
   docker logs webai-provider | grep -i "xvfb\|vnc"
   ```

3. **Reinicie o container:**
   ```bash
   docker-compose restart
   ```

### Login não persiste

1. **Verifique se o volume está montado:**
   ```bash
   docker inspect webai-provider | grep -A5 Mounts
   ```

2. **Verifique se o diretório existe:**
   ```bash
   docker exec webai-provider ls -la /tmp/webai-chrome-profile
   ```

3. **Se o volume foi removido, recrie:**
   ```bash
   docker-compose down
   docker-compose up -d
   ```

### VNC muito lento

1. **Reduza a resolução:**
   ```yaml
   environment:
     - RESOLUTION=1024x768x24
   ```

2. **Use compressão no cliente VNC** (se usar cliente nativo)

3. **Acesse do próprio host** (evita overhead de rede)

---

## Segurança

### ⚠️ Atenção

O VNC expõe o desktop do container para a rede. Medidas de segurança:

1. **Use senha forte** em `VNC_PASSWORD`
2. **Não exponha a porta 6080 para internet** (apenas rede local)
3. **Considere usar VPN** (Tailscale) para acesso remoto seguro
4. **Desabilite VNC** quando não estiver usando (modo headless)

### Firewall

Se quiser restringir acesso por IP:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 6080
sudo ufw deny 6080
```

---

## Fluxo Completo

1. **Subir container:**
   ```bash
   docker-compose up -d
   ```

2. **Acessar VNC:**
   ```
   http://192.168.1.8:6080/vnc.html
   ```

3. **Logar nas IAs web:**
   - Gemini, GPT, Claude, etc.

4. **Fechar VNC** (não precisa fechar o Chrome)

5. **Usar WebAI Provider via API:**
   ```bash
   curl -X POST http://192.168.1.8:3100/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{
       "model": "gemini",
       "messages": [...]
     }'
   ```

6. **O WebAI Provider reutiliza o login salvo automaticamente**

---

## Próximos Passos

- [ ] Testar login no Gemini
- [ ] Testar login no ChatGPT
- [ ] Testar login no Claude
- [ ] Validar persistência após restart
- [ ] Testar tarefa real via API
- [ ] Integrar com Motor-v2

---

## Referências

- [noVNC Documentation](https://github.com/novnc/noVNC)
- [Xvfb Manual](https://www.x.org/releases/X11R7.6/doc/man/man1/Xvfb.1.xhtml)
- [Puppeteer Documentation](https://pptr.dev/)

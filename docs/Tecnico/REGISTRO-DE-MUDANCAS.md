# Registro de Mudanças

Histórico técnico do **Cipher**. Cobre o que **foi ao ar**: decisões de
arquitetura, correções e mudanças de contrato da API.

Este documento é público. Conteúdo do vault, caminho de arquivo pessoal e
qualquer coisa que o modo documentos indexe não entram aqui.

Versionamento pelo `version` de `/api/info` em `app/backend/server.js`, que é de
onde o `deploy-cipher.sh` lê a versão publicada.

⚠️ **Este arquivo nasceu em 2026-11-03 e começa vazio de propósito.** O projeto
publicou no Sentinel entre 31/10 e 03/11 **sem registro nenhum**: o hook
`registrar-publicacao.js` só reconhece `fly deploy` e `vercel --prod`, e aqui a
publicação é por `~/Dev/Sentinel/scripts/deploy-cipher.sh`. As publicações
anteriores a esta data estão no `DIARIO-SESSOES.local.md` e nos commits, não
aqui — recriar à mão seria inventar horário.

---

<!-- AUTO:INSERIR-APOS — publicacoes bem-sucedidas sao gravadas logo abaixo desta linha; nao remova este marcador -->

### 2026-11-03 15:21 — Servidor Sentinel (Cipher v2.2.0)
- Publicado pelo deploy-cipher.sh.
- Commits recentes:
  - `0736b08` fix(contexto): o prompt estourava o contexto e a mensagem culpava o modelo
  - `50e900c` docs(readme): os dois READMEs descreviam software que nao existe mais
  - `087f3a9` fix(relatorio): laco de leitura precisa rodar quando a escrita vem no mesmo turno

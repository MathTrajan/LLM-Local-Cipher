<div align="center">

# 🤖 Cipher

**Chat com LLM 100% offline.** O modelo roda na sua máquina. Nenhum dado sai dela.

![Node.js](https://img.shields.io/badge/Node.js_20-339933?style=flat-square&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=flat-square&logo=express&logoColor=white)
![llama.cpp](https://img.shields.io/badge/llama.cpp-local-7c3aed?style=flat-square)
![Sem banco](https://img.shields.io/badge/banco_de_dados-nenhum-64748b?style=flat-square)

</div>

---

## Visão geral

Backend Express enxuto + SPA em HTML/CSS/JS puro, sem framework e sem build.
Não há banco de dados, cadastro nem estado de conversa no servidor.

O único provedor é o **modelo local** servido por `llama-server` (llama.cpp),
falado pelo protocolo OpenAI. **Não existe fallback de nuvem**, e isso é
proposital: sem o modelo de pé o chat responde 503 com mensagem clara, em vez de
mandar a sua pergunta para fora. Provedores de nuvem foram removidos por decisão
de privacidade em agosto de 2026.

## O que ele faz

| Recurso | Como funciona |
|---|---|
| **Chat com streaming** | SSE token a token. Fechar a aba aborta a inferência, em vez de deixar o modelo gerando para ninguém |
| **Memória persistente** | Fatos que valem em qualquer conversa, extraídos em segundo plano. Vivem no `localStorage`, teto de 60 |
| **Modo documentos** | Busca BM25 offline em `.md` locais (vault, docs de projeto). Sem serviço externo, sem processo extra |
| **Acesso a arquivos** | Cinco ferramentas via tool calling nativo, numa sandbox de pasta única |
| **Índice automático** | Cada pasta da sandbox ganha um `CIPHER.md` com o que existe nela, regerado do disco |
| **Conversas** | Só no navegador. O servidor recebe o histórico e esquece |

### O chat nunca executa ferramenta sozinho

Quando o modelo propõe criar, editar ou apagar arquivo, o servidor **guarda a
intenção** e devolve um id. Quem escreve é uma rota separada, chamada **depois
do clique** no card. Sem id existente não há escrita.

A sandbox é uma pasta única: caminho absoluto, `~` e `..` são recusados, symlink
é checado no ancestral existente mais próximo (e não no alvo, que pode ainda não
existir), há whitelist de extensão e teto de tamanho. `criar_arquivo` nunca
sobrescreve em silêncio, `editar_arquivo` grava backup antes, e `apagar_arquivo`
move para a Lixeira em vez de dar `unlink`.

## Rodar localmente

Precisa de **Node 20**, do runtime do llama.cpp (`brew install llama.cpp`) e de
um GGUF instruct qualquer. Em máquina de 8 GB, um 3B quantizado (`q4_k_m`).

```bash
git clone https://github.com/MathTrajan/LLM-Local-Cipher.git
cd LLM-Local-Cipher/app/backend
npm install
cp .env.example .env    # aponte LOCAL_LLM_GGUF para o seu .gguf
```

São **dois processos**, e os dois morrem com o shell:

```bash
npm run modelo   # sobe o llama-server; obrigatório, senão todo chat é 503
npm start        # noutro terminal
```

Acesse **http://localhost:3100**.

> ⚠️ **3100, não 3000.** `http://localhost:<porta>` é uma *origin*: favicon,
> cache e `localStorage` são compartilhados por qualquer projeto na mesma porta.
> Rodar aqui numa porta já usada por outro projeto faz o navegador servir ícone
> e assets do outro, e o sintoma parece bug de front.

## Comandos

Todos em `app/backend/`:

```bash
npm run modelo   # sobe o llama-server
npm start        # produção
npm run dev      # nodemon
npm run indexar  # (re)gera o índice do modo documentos
npm run testar   # 4 scripts de smoke test
npm run senha    # gera o hash de senha, para quando o app fica exposto
```

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `LOCAL_LLM_GGUF` | Sim | Caminho do `.gguf` que o `npm run modelo` carrega |
| `LOCAL_LLM_BASE_URL` | Não | Padrão `http://127.0.0.1:8080/v1` |
| `LOCAL_LLM_TIMEOUT_MS` | Não | Padrão 120000. No streaming conta **inatividade entre tokens**, não a resposta inteira |
| `RAG_FONTES` | Para o modo documentos | Pastas com `.md`, separadas por `:`. Aceita `~` |
| `CIPHER_ARQUIVOS_RAIZ` | Não | Única pasta onde o modelo pode escrever. Padrão `~/Cipher-Arquivos` |
| `PORT` | Não | **Use 3100** (o padrão do código é 3000) |
| `ALLOWED_ORIGIN` | Não | CORS, padrão `*` |

Lista completa em `app/backend/.env.example`.

## Endpoints

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/api/chat/stream` | Mensagem, resposta em SSE. É a que o front usa |
| `POST` | `/api/chat` | Mensagem, resposta completa em JSON |
| `POST` | `/api/memoria/extrair` | Mensagem, fatos duráveis |
| `POST` | `/api/arquivos/executar` | Executa uma proposta pelo id. **Único ponto que escreve em disco** |
| `POST` | `/api/arquivos/cancelar` | Descarta a proposta |
| `GET` | `/api/health` | Status do modelo local e do índice de documentos |
| `GET` | `/api/info` | Versão |

Qualquer outro caminho cai no fallback da SPA e devolve o `index.html`. Por isso
rota inexistente responde **200 com HTML** em vez de 404.

## Índice de documentos

O índice do modo documentos é **derivado** do conteúdo local e fica fora do
versionamento (`app/backend/data/`). Regerar é rodar `npm run indexar`.

---

<div align="center">

Desenvolvido por **Matheus Trajano** · [LinkedIn](https://www.linkedin.com/in/matheus-trajano)

</div>

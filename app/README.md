# Cipher - Agente de Observabilidade para Automacoes Windows

Agente operacional que recebe logs estruturados de automacoes PowerShell, armazena eventos em SQLite/Postgres e responde perguntas com base em evidencias reais de execucao.

**URL publica alvo:** [https://cipher-observability.vercel.app](https://cipher-observability.vercel.app)

> Revalide `/api/health`, `/api/info` e `/api/logs-debug` antes de depender do ambiente publico para testes.

---

## Estrutura do Projeto

```text
app/
|-- backend/
|   |-- server.js
|   |-- agent.js
|   |-- config.js
|   |-- log-context.js
|   |-- log-ingest-store.js
|   |-- providers/
|   |   `-- groq.js
|   |-- public/
|   |   |-- index.html
|   |   |-- css/style.css
|   |   `-- js/app.js
|   |-- .env.example
|   `-- package.json
|-- frontend/
|   |-- index.html
|   |-- css/style.css
|   `-- js/app.js
`-- .gitignore
```

---

## Instalacao Local

### Pre-requisitos

- Node.js v18+
- Chave de API Groq valida

### Passos

```bash
cd app/backend
cp .env.example .env
# preencha ao menos GROQ_API_KEY_1 e LOG_INGEST_API_TOKEN
npm install
npm start
```

Acesse: `http://localhost:3000`

---

## Variaveis de Ambiente

Todas as variaveis sao lidas via `config.js`, com trim automatico para evitar erros de `\r\n`.

```env
# Servidor
PORT=3000
AGENT_ROUTING_STRATEGY=auto
ALLOWED_ORIGIN=*

# Groq
GROQ_API_KEY_1=
GROQ_API_KEY_2=
GROQ_MODEL_1=llama-3.3-70b-versatile
GROQ_MODEL_2=llama-3.1-8b-instant

# HTTP Ingest
LOG_INGEST_ENABLED=true
LOG_INGEST_API_TOKEN=troque-por-um-token-seguro
LOG_INGEST_MAX_CONTEXT_EVENTS=60

# Banco de dados em producao
DATABASE_URL=postgresql://user:password@host/db?sslmode=require

# Banco local opcional
# LOG_DB_FILE=C:\caminho\cipher-logs.db

# Fallback de logs
GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_SERVICE_ACCOUNT_JSON=
LOG_LOCAL_DIR=G:\Meu Drive\Log
```

> Nunca commite o arquivo `.env`.

---

## Deploy em Producao

Recomendado: `Vercel + Neon`

1. Criar banco no Neon
2. Configurar no painel da Vercel:
   - `DATABASE_URL`
   - `LOG_INGEST_API_TOKEN`
   - `GROQ_API_KEY_1`
   - `GROQ_API_KEY_2`
   - `AGENT_ROUTING_STRATEGY=auto`
3. Fazer redeploy
4. Validar:

```bash
curl https://cipher-observability.vercel.app/api/health
curl https://cipher-observability.vercel.app/api/info
curl https://cipher-observability.vercel.app/api/logs-debug
```

Esperado:

- `/api/info` com `logs.mode = "postgres"`

---

## Integracao com Automacoes Windows

Os scripts operacionais sao locais e nao devem subir para o Git. Eles seguem um padrao unico:

- mantem o `.txt` original
- mantem a saida visual no console
- acumulam eventos estruturados em memoria
- enviam o lote para `POST /api/log-ingest` ao final da execucao

### Variaveis no servidor Windows

```powershell
[Environment]::SetEnvironmentVariable("CIPHER_INGEST_URL", "https://cipher-observability.vercel.app/api/log-ingest", "Machine")
[Environment]::SetEnvironmentVariable("CIPHER_INGEST_API_TOKEN", "<mesmo token configurado no backend>", "Machine")
Get-ChildItem Env:CIPHER*
```

### Formato do payload

```json
{
  "events": [
    {
      "timestamp": "2026-05-07T14:00:00.000Z",
      "automation": "Programacao_de_Pedidos",
      "level": "INFO",
      "message": "[STATUS] RefreshAll concluido.",
      "runId": "ProgramacaoPedidos-20260507-140000",
      "status": "running",
      "tags": ["excel", "powerquery"],
      "meta": {
        "host": "SERVIDOR-WIN",
        "user": "automacao",
        "script": "Programacao de Pedidos"
      }
    }
  ]
}
```

---

## Endpoints da API

| Metodo | Endpoint | Descricao |
|---|---|---|
| POST | `/api/chat` | Conversa operacional com o Cipher |
| GET | `/api/health` | Status do provedor LLM |
| POST | `/api/log-ingest` | Ingestao de logs estruturados |
| GET | `/api/logs/query` | Consulta protegida de eventos |
| GET | `/api/logs-debug` | Diagnostico da fonte de logs e ingestao |
| GET | `/api/info` | Configuracao atual do backend |

---

## Comportamento do Cipher

Quando a pergunta menciona uma automacao, o backend tenta detectar esse nome a partir dos eventos ingeridos e prioriza o contexto dessa rotina.

Exemplos:

- `o que aconteceu na Programacao de Pedidos hoje?`
- `como foi a automacao Pedidos em Carga?`

Se nenhuma automacao for identificada na pergunta, Cipher cai para busca textual geral e depois para eventos mais recentes.

Se nao houver evidencia suficiente, a resposta correta e dizer que nao encontrou isso nos logs disponiveis.

---

## Seguranca

- chaves de API apenas em variaveis de ambiente
- `LOG_INGEST_API_TOKEN` obrigatorio para ingestao
- `.env` protegido pelo `.gitignore`
- scripts de automacao sao de uso interno e nao devem subir para o Git

---

## Licenca

MIT License

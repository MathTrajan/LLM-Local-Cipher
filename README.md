<div align="center">

# 🤖 Cipher — Assistente Virtual Inteligente

Interface de chat com LLM: pergunte qualquer coisa e receba resposta direta, em português.

![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=flat-square&logo=express&logoColor=white)
![Groq](https://img.shields.io/badge/Groq_LLM-F55036?style=flat-square)
![Vercel](https://img.shields.io/badge/Deploy-Vercel-000000?style=flat-square&logo=vercel&logoColor=white)

</div>

---

## Visão geral

O **Cipher** é uma interface de conversa com LLM, servida por um backend Express enxuto. O front é HTML/CSS/JS puro, sem framework nem build: uma SPA de tela única com identidade visual própria — esfera holográfica animada em canvas, partículas de fundo e painel de status do provedor.

Sem banco de dados, sem cadastro, sem estado no servidor. O histórico da conversa vive no `localStorage` do navegador (validade de 24h) e vai junto em cada requisição, o que dá continuidade ao diálogo sem persistir nada fora da máquina do usuário.

## Funcionalidades

- **Chat com LLM** via Groq, com histórico de contexto das últimas 20 trocas
- **Groq em cascata**: até 3 chaves/modelos, com fallback automático quando uma falha
- **Markdown nas respostas**: títulos, listas, blocos de código, negrito e itálico
- **Conversa restaurável**: recarregar a página não perde o diálogo (24h de validade)
- **Botão de copiar** em cada resposta
- **Rate limit** de 30 mensagens por minuto por IP
- **Status do provedor** em tempo real no painel lateral, com latência e uptime da sessão

## Arquitetura

```
┌──────────────────────────┐    POST /api/chat     ┌────────────────────────────┐
│  SPA (HTML/CSS/JS puro)  │ ────────────────────▶ │  Backend Node.js/Express   │
│  historico no            │                       │                            │
│  localStorage            │ ◀──────────────────── │  ┌──────────────────────┐  │
└──────────────────────────┘    resposta do LLM    │  │ agent                │  │
                                                    │  │ system prompt +      │  │
                                                    │  │ roteamento           │  │
                                                    │  └──────────┬───────────┘  │
                                                    │  ┌──────────▼───────────┐  │
                                                    │  │ providers/groq       │  │
                                                    │  │ cascata de 3 chaves  │  │
                                                    │  └──────────────────────┘  │
                                                    └────────────────────────────┘
```

## Stack

| Camada | Tecnologia |
|---|---|
| Backend | Node.js + Express |
| LLM | Groq API |
| Frontend | HTML/CSS/JS puro (sem build) |
| Deploy | Vercel |

## Como rodar localmente

```bash
git clone https://github.com/MathTrajan/Cipher-Chat-Assistente-Virtual-Inteligente.git
cd Cipher-Chat-Assistente-Virtual-Inteligente/app/backend

cp .env.example .env
# preencha GROQ_API_KEY_1 no .env

npm install
npm start
```

Acesse: **http://localhost:3000**

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `GROQ_API_KEY_1` | Sim | Chave da API Groq |
| `GROQ_MODEL_1` | Não | Modelo primário (padrão: `llama-3.3-70b-versatile`) |
| `GROQ_API_KEY_2`, `GROQ_API_KEY_3` | Não | Chaves de fallback |
| `PORT` | Não | Porta do servidor (padrão: `3000`) |
| `ALLOWED_ORIGIN` | Não | Origem liberada no CORS (padrão: `*`) |

> Lista completa em `app/backend/.env.example`.

## Endpoints

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/api/chat` | Envia mensagem e recebe a resposta do LLM |
| `GET`  | `/api/health` | Status do provedor LLM |
| `GET`  | `/api/info` | Versão e configuração de roteamento |

---

<div align="center">

Desenvolvido por **Matheus Trajano** · [LinkedIn](https://www.linkedin.com/in/matheus-trajano-5179a7378/)

</div>

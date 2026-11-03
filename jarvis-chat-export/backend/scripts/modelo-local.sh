#!/usr/bin/env bash
#
# Sobe o llama-server com o modelo local do Jarvis.
#
# Este processo e SEPARADO do servidor Node e morre quando o shell fecha —
# mesma armadilha do odysseus-dev. Sem ele de pe, a estrategia "auto" cai para o
# Groq (precisa de internet) e a estrategia "local" devolve 503.
#
set -euo pipefail

cd "$(dirname "$0")/.."

# Le o .env sem executa-lo (evita surpresa com valores contendo espaco/aspas).
if [ -f .env ]; then
  GGUF=$(grep -E '^LOCAL_LLM_GGUF=' .env | head -1 | cut -d= -f2-)
  BASE=$(grep -E '^LOCAL_LLM_BASE_URL=' .env | head -1 | cut -d= -f2-)
fi

GGUF="${GGUF:-}"
BASE="${BASE:-http://127.0.0.1:8080/v1}"
# Extrai a porta da base URL; cai para 8080 se nao der.
PORTA=$(printf '%s' "$BASE" | sed -nE 's#.*://[^:]+:([0-9]+).*#\1#p')
PORTA="${PORTA:-8080}"
# ⚠️ 8192 e nao 4096. Medido em 31/10/2026: o system prompt fixo (identidade +
# perfil + arvore de arquivos) ocupa ~1.600 tokens e o painel mostrava 2.408 de
# 4.096 — 59% do contexto gasto ANTES da primeira pergunta, sobrando menos de
# 1.700 tokens para a conversa inteira. Conversa de poucas trocas ja estourava,
# e estourar contexto nao da erro: o llama.cpp descarta o inicio em silencio e o
# modelo "esquece" o comeco da conversa no meio dela.
#
# Custo: o KV cache dobra, de ~150 MB para ~300 MB. Com --flash-attn on o
# aumento e menor ainda. Num Mac de 8 GB com o modelo de 2 GB, cabe.
CONTEXTO="${LOCAL_LLM_CTX:-8192}"

BIN="${LLAMA_SERVER_BIN:-/opt/homebrew/bin/llama-server}"

if [ ! -x "$BIN" ]; then
  echo "erro: llama-server nao encontrado em $BIN" >&2
  echo "instale com: brew install llama.cpp" >&2
  exit 1
fi

if [ -z "$GGUF" ] || [ ! -f "$GGUF" ]; then
  echo "erro: modelo GGUF nao encontrado." >&2
  echo "defina LOCAL_LLM_GGUF no .env apontando para o arquivo .gguf" >&2
  [ -n "$GGUF" ] && echo "valor atual: $GGUF" >&2
  exit 1
fi

if lsof -ti:"$PORTA" >/dev/null 2>&1; then
  echo "ja existe algo escutando na porta $PORTA — nada a fazer."
  exit 0
fi

# Host de escuta. O padrao continua sendo SO o loopback.
#
# Com JARVIS_MODELO_NA_TAILNET=1 escuta no IP da tailnet, que e como o Jarvis
# publicado no Sentinel alcanca a inferencia daqui: o Celeron N2807 do servidor
# nao tem AVX nem AVX2 (medido em /proc/cpuinfo: so sse4_1/sse4_2), e um 3B la
# levaria de 3 a 9 minutos por mensagem contra 1 a 6 segundos aqui.
#
# ⚠️ Nunca 0.0.0.0: o llama-server NAO tem autenticacao nenhuma. Na tailnet quem
# autentica e o WireGuard do Tailscale; em 0.0.0.0 qualquer aparelho da rede de
# casa (ou da rede de um cafe) teria inferencia livre.
#
# ⚠️ O llama.cpp aceita UM endereco de escuta, nao uma lista: ligado o modo
# tailnet ele NAO responde mais em 127.0.0.1. Entao o Jarvis rodando aqui no Mac
# tambem precisa apontar LOCAL_LLM_BASE_URL para o IP da tailnet — o Mac se
# alcanca pelo proprio IP de tailnet sem sair da maquina. Consequencia: com o
# Tailscale desligado, o Jarvis local tambem para. Para trabalhar offline de
# verdade, rode sem a variavel e deixe tudo no loopback.
HOST_ESCUTA=127.0.0.1
if [ "${JARVIS_MODELO_NA_TAILNET:-}" = 1 ]; then
  # O CLI do Tailscale instalado pelo cask NAO entra no PATH no macOS.
  TS_CLI="${TAILSCALE_CLI:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"
  if [ ! -x "$TS_CLI" ]; then
    echo "erro: CLI do Tailscale nao encontrado em $TS_CLI" >&2
    exit 1
  fi
  IP_TAILNET=$("$TS_CLI" ip -4 2>/dev/null | head -1 || true)
  # Sem Tailscale no ar a interface nem existe e o bind falharia com EADDRNOTAVAIL,
  # que e um erro opaco. Melhor recusar com motivo.
  if [ -z "$IP_TAILNET" ]; then
    echo "erro: Tailscale fora do ar — sem IP da tailnet para escutar." >&2
    echo "ligue o Tailscale, ou rode sem JARVIS_MODELO_NA_TAILNET para ficar so no loopback." >&2
    exit 1
  fi
  HOST_ESCUTA="$IP_TAILNET"
fi

echo "modelo:   $(basename "$GGUF")"
echo "escuta:   $HOST_ESCUTA:$PORTA"
echo "contexto: $CONTEXTO tokens"
echo

exec "$BIN" \
  -m "$GGUF" \
  --host "$HOST_ESCUTA" \
  --port "$PORTA" \
  -c "$CONTEXTO" \
  -ngl 99 \
  --parallel 1 \
  --flash-attn on \
  --cache-reuse 256 \
  --threads-batch -1

# ─── Por que cada flag acima ───
#
# --parallel 1
#   O padrao reparte o contexto entre varios slots de atendimento simultaneo.
#   O Jarvis tem UM usuario e o llama-server atende uma requisicao por vez de
#   qualquer forma (e por isso que a extracao de memoria roda DEPOIS da
#   resposta, nao junto). Com 1 slot, todo o contexto e o KV cache ficam para a
#   unica conversa em andamento, que e o que faz o reaproveitamento de prompt
#   chegar a 100%.
#
# --flash-attn on
#   Atencao com menos leitura e escrita de memoria. No Metal reduz o uso de RAM
#   do KV cache e acelera o prefill, que e a parte cara aqui: o system prompt
#   tem ~1.600 tokens fixos (identidade + perfil + arvore de arquivos) e e
#   reprocessado toda vez que o cache nao casa.
#
# --cache-reuse 256
#   Reaproveita pedaco do KV cache mesmo quando o prefixo NAO bate byte a byte,
#   deslocando o que ja foi calculado. Importa porque o system prompt do Jarvis
#   carrega a arvore de arquivos e a memoria, que MUDAM quando o usuario cria um
#   arquivo ou ensina um fato: sem isto, qualquer mudanca de uma linha joga fora
#   os 1.600 tokens inteiros e o prefill e refeito do zero.
#
# --threads-batch -1
#   Deixa o llama.cpp escolher os threads do prefill (o padrao herda o de
#   geracao, que e conservador). Prefill paraleliza bem; geracao nao.

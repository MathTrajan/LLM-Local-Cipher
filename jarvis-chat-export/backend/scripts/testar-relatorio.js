#!/usr/bin/env node
/**
 * ============================================================
 * Smoke test do fluxo de relatorio A2O
 * ============================================================
 * Cobre as tres decisoes que fizeram o pedido de um cliente terminar sem
 * arquivo em 2026-11-03, todas invisiveis sem o modelo de pe:
 *
 *   1. reconhecer o pedido (`ehSobreRelatorio`, `devoForcarGeracao`)
 *   2. classificar ficha contra listagem (`jrxml.classificarLayout`)
 *   3. desmentir a resposta que afirma ter gerado arquivo
 *      (`avisoDeArquivoNaoGerado`, `resolverConversa`)
 *
 * ⚠️ Nao usa arquivo de cliente. Os .jrxml daqui sao minimos e sinteticos, com
 * so os sinais que a classificacao le, porque suite que depende de arquivo real
 * da empresa quebra em outra maquina e vaza dado para o repositorio publico.
 * Os numeros dos casos "espelho" vem da medicao nos arquivos reais e estao
 * anotados caso a caso.
 */

const path = require("path");

// Aponta a raiz para /tmp ANTES de carregar arquivos.js: o modulo le a variavel
// no carregamento. Mesmo preparo do testar-indice.js.
process.env.JARVIS_ARQUIVOS_RAIZ = path.join("/tmp", "jarvis-teste-relatorio");

const arquivos = require("../arquivos");
const jrxml = require("../jrxml");
const agent = require("../agent");

// `garantirRaiz` e quem sabe criar a raiz, e e idempotente. Criar com mkdirSync
// aqui faria o estado inicial divergir dos outros dois smoke tests.
arquivos.garantirRaiz();

let ok = 0;
let falhas = 0;

function checar(nome, condicao, detalhe = "") {
  if (condicao) {
    ok++;
    console.log(`  ok   ${nome}`);
  } else {
    falhas++;
    console.log(`  FALHA ${nome}${detalhe ? `\n       ${detalhe}` : ""}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

/** Monta N bandas `<text>` com rotulo, que e o que a classificacao conta. */
function rotulos(n) {
  return Array.from({ length: n }, (_, i) => `<staticText><text>Rotulo ${i}</text></staticText>`).join("");
}

function campos(n) {
  return Array.from({ length: n }, (_, i) => `<field name="campo${i}" class="java.lang.String"/>`).join("");
}

/* Espelha o relconhecimento_7.jrxml: columnHeader com 6 rotulos, detail vazio
   (o dado sai nos groupFooter), 13 totalizadores, 2 grupos, 75 campos. */
const LISTAGEM = `<?xml version="1.0"?>
<jasperReport name="listagem" pageWidth="595" pageHeight="842" columnWidth="557">
${campos(75)}
${Array.from({ length: 13 }, (_, i) => `<variable name="SUM${i}" calculation="Sum"/>`).join("")}
<group name="grupo1"/><group name="CFOP"/>
<columnHeader><band height="11">${rotulos(6)}</band></columnHeader>
<detail><band height="0"/></detail>
<groupFooter><band height="13"><textField><textFieldExpression>$V{SUM0}</textFieldExpression></textField></band></groupFooter>
</jasperReport>`;

/* Espelha o pessoa_imprimir_3.jrxml: sem columnHeader, detail com 89 rotulos
   empilhados, nenhum totalizador, nenhum grupo, 73 campos. */
const FICHA = `<?xml version="1.0"?>
<jasperReport name="ficha" pageWidth="595" pageHeight="842" columnWidth="557">
${campos(73)}
<detail><band height="56">${rotulos(89)}</band></detail>
</jasperReport>`;

/* Caso que o limiar antigo (campos > 20) errava nos dois sentidos: listagem
   pequena, com cabecalho de tabela e poucos campos. */
const LISTAGEM_PEQUENA = `<?xml version="1.0"?>
<jasperReport name="pequena" pageWidth="595" pageHeight="842">
${campos(4)}
<columnHeader><band height="11">${rotulos(4)}</band></columnHeader>
<detail><band height="12"><textField><textFieldExpression>$F{campo0}</textFieldExpression></textField></band></detail>
</jasperReport>`;

/* Ficha curta: 6 campos, nenhum columnHeader, 10 rotulos no detail. O limiar
   antigo chamaria de listagem por ter menos de 20 campos. */
const FICHA_CURTA = `<?xml version="1.0"?>
<jasperReport name="ficha-curta" pageWidth="595" pageHeight="842">
${campos(6)}
<detail><band height="60">${rotulos(10)}</band></detail>
</jasperReport>`;

// ─────────────────────────────────────────────────────────────
// 1. Classificacao de layout
// ─────────────────────────────────────────────────────────────
console.log("\nClassificacao ficha / listagem");

{
  const c = jrxml.classificarLayout(LISTAGEM);
  checar("listagem com 75 campos nao e confundida com ficha", c.tipo === "listagem", `veio "${c.tipo}"`);
  checar("sinais da listagem conferem",
    c.sinais.rotulosColHeader === 6 && c.sinais.totalizadores === 13 && c.sinais.grupos === 2,
    JSON.stringify(c.sinais));
}
{
  const c = jrxml.classificarLayout(FICHA);
  checar("ficha com 73 campos e reconhecida", c.tipo === "ficha", `veio "${c.tipo}"`);
  checar("conta os rotulos empilhados do detail", c.sinais.rotulosDetail === 89, JSON.stringify(c.sinais));
}
{
  /* O teste que prova que a contagem de campo nao decide nada: 75 campos e
     listagem, 73 campos e ficha, e os dois casos abaixo invertem o tamanho. */
  checar("listagem de 4 campos continua listagem",
    jrxml.classificarLayout(LISTAGEM_PEQUENA).tipo === "listagem");
  checar("ficha de 6 campos continua ficha",
    jrxml.classificarLayout(FICHA_CURTA).tipo === "ficha");
}
{
  const vazio = jrxml.classificarLayout('<jasperReport name="x"/>');
  checar("arquivo sem sinal nenhum fica indefinido, nao palpita", vazio.tipo === "indefinido");
}

// ─────────────────────────────────────────────────────────────
// 2. A instrucao que vai junto do resumo
// ─────────────────────────────────────────────────────────────
console.log("\nSecao \"O que fazer\" no resumo");

{
  const r = jrxml.resumir(LISTAGEM, { caminho: "relatorio.jrxml" });
  checar("listagem manda chamar a ferramenta", /ISTO E LISTAGEM/.test(r));
  checar("listagem entrega o herdarDe pronto", /herdarDe: "relatorio\.jrxml"/.test(r), r.slice(-400));
  checar("listagem avisa que campo nao e coluna", /NAO 75 colunas/.test(r));
}
{
  const r = jrxml.resumir(FICHA, { caminho: "ficha.jrxml" });
  checar("ficha recusa a ferramenta e aponta o _ficha.py",
    /ISTO E FICHA CADASTRAL/.test(r) && /_ficha\.py/.test(r));
  checar("ficha proibe afirmar geracao", /NAO diga que gerou/.test(r));
  checar("ficha nao manda chamar gerar_relatorio_a2o", !/Chame a ferramenta AGORA/.test(r));
}
{
  /* ⚠️ A instrucao e colada depois dos dois truncamentos. Sem isso ela seria o
     primeiro pedaco perdido num arquivo grande, que e exatamente o caso em que
     o modelo mais precisa dela. */
  const r = jrxml.resumir(LISTAGEM, { caminho: "gigante.jrxml", tetoTokens: 60 });
  checar("corte por teto de contexto aconteceu de fato",
    r.includes("[resumo cortado no teto de contexto]"),
    `fim do resumo: ${JSON.stringify(r.slice(-120))}`);
  checar("instrucao sobrevive ao corte",
    r.includes("## O que fazer") && /ISTO E LISTAGEM/.test(r),
    `fim do resumo: ${JSON.stringify(r.slice(-200))}`);
}
{
  const semCaminho = jrxml.resumir(LISTAGEM);
  checar("sem caminho a instrucao nao inventa um",
    /herdarDe: o caminho do arquivo que voce leu/.test(semCaminho));
}

// ─────────────────────────────────────────────────────────────
// 3. Reconhecer o pedido
// ─────────────────────────────────────────────────────────────
console.log("\nReconhecimento do pedido");

const ARVORE_COM_JRXML = ["relconhecimento_7.jrxml", "JARVIS.md"];
const ARVORE_SEM_JRXML = ["notas.md"];

const PEDIDOS_QUE_DEVEM_FORCAR = [
  // O ticket real de 2026-11-03, que passou batido e custou a sessao.
  "Por favor inserir no relatorio G os tomadores.",
  "incluir a coluna de tomador na listagem",
  "adicione o campo de CFOP no relatorio",
  "acrescentar o tomador na tabela",
  "ajusta esse relatorio para o padrao",
  "corrige a coluna de valor no arquivo",
  "troca o campo de remetente pelo de tomador",
  "atualizar o grupo do relatorio",
  "migra esse relatorio para o padrao a2o",
  "refazer a listagem com menos colunas",
  // Os que ja funcionavam antes: a regra nova nao pode ter quebrado nenhum.
  "gere o relatorio no padrao a2o",
  "cria um arquivo jrxml novo",
  "monta a listagem pronta para baixar",
  "profissionaliza esse relatorio",
];

const PEDIDOS_QUE_NAO_DEVEM_FORCAR = [
  "bom dia, tudo bem?",
  "me explica o que e um relatorio jasper",
  "qual o status do modelo?",
  // Pergunta SOBRE o relatorio nao e pedido para gerar.
  "esse relatorio tem quantas colunas?",
];

(async () => {
  for (const msg of PEDIDOS_QUE_DEVEM_FORCAR) {
    const forca = await agent.devoForcarGeracao(msg, { listagemArquivos: ARVORE_COM_JRXML });
    checar(`forca a ferramenta: "${msg.slice(0, 44)}"`, forca === true);
  }
  for (const msg of PEDIDOS_QUE_NAO_DEVEM_FORCAR) {
    const forca = await agent.devoForcarGeracao(msg, { listagemArquivos: ARVORE_COM_JRXML });
    checar(`NAO forca: "${msg.slice(0, 44)}"`, forca === false);
  }

  /* Sem .jrxml na sandbox nao forca nada: obrigar a ferramenta sem arquivo de
     origem so faria o modelo inventar campos. */
  checar("sem .jrxml na sandbox nao forca",
    (await agent.devoForcarGeracao("gere o relatorio no padrao a2o", {
      listagemArquivos: ARVORE_SEM_JRXML,
    })) === false);

  checar("no modo documentos nao forca",
    (await agent.devoForcarGeracao("gere o relatorio no padrao a2o", {
      docs: true, listagemArquivos: ARVORE_COM_JRXML,
    })) === false);

  // ─── manual ───
  console.log("\nCarregamento do manual");

  checar("mensagem com jrxml carrega pelo gatilho direto",
    agent.ehSobreRelatorio("o que falta nesse arquivo jrxml?", {}) === true);
  checar("pedido de ticket carrega pelo inventario da sandbox",
    agent.ehSobreRelatorio("Por favor inserir no relatorio G os tomadores.", {
      listagemArquivos: ARVORE_COM_JRXML,
    }) === true);
  checar("o mesmo pedido sem .jrxml na sandbox nao carrega o manual",
    agent.ehSobreRelatorio("Por favor inserir no relatorio G os tomadores.", {
      listagemArquivos: ARVORE_SEM_JRXML,
    }) === false);
  checar("conversa comum nao carrega o manual",
    agent.ehSobreRelatorio("bom dia, tudo bem?", {
      listagemArquivos: ARVORE_COM_JRXML,
    }) === false);

  // ─────────────────────────────────────────────────────────────
  // 4. Guarda do arquivo que nao existe
  // ─────────────────────────────────────────────────────────────
  console.log("\nGuarda contra arquivo que nao foi gerado");

  // A resposta literal de 2026-11-03, que o usuario viu e acreditou.
  const RESPOSTA_REAL =
    "Preparei o relatório A2O com base nos dados e especificações fornecidos. " +
    "Aqui está o arquivo gerado com o nome relconhecimento_7_ajustado.jrxml:\n\n" +
    "# Relatorio: ReportXML\n\n# Gerado por: relconhecimento_7_ajustado.jrxml";

  checar("desmente a resposta real de 2026-11-03",
    agent.avisoDeArquivoNaoGerado({ text: RESPOSTA_REAL, toolCalls: [] }) !== null);

  for (const frase of [
    "Aqui está o arquivo pronto para baixar.",
    "Gerei o relatório no padrão A2O.",
    "O arquivo foi criado com sucesso.",
    "# Gerado por: saida.jrxml",
    "Você pode baixar o arquivo agora.",
  ]) {
    checar(`desmente: "${frase.slice(0, 40)}"`,
      agent.avisoDeArquivoNaoGerado({ text: frase, toolCalls: [] }) !== null);
  }

  checar("cala quando a ferramenta de escrita foi chamada",
    agent.avisoDeArquivoNaoGerado({
      text: "Gerei o relatório no padrão A2O.",
      toolCalls: [{ nome: "criar_arquivo" }],
    }) === null);

  checar("leitura nao conta como escrita",
    agent.avisoDeArquivoNaoGerado({
      text: "Gerei o relatório no padrão A2O.",
      toolCalls: [{ nome: "ler_arquivo" }],
    }) !== null);

  /* ⚠️ O caso que a negacao protege. Esta e a resposta CERTA para uma ficha, e
     sem o teste de negacao o proprio sistema a desmentiria. */
  for (const frase of [
    "Não gerei o arquivo porque isto é ficha cadastral e o montador faz tabela.",
    "Nenhum arquivo foi criado: o layout precisa do _ficha.py.",
    "Não é possível gerar o relatório com essas colunas.",
    "O arquivo não foi criado porque falta a coluna de tomador no contrato.",
  ]) {
    checar(`respeita a negacao: "${frase.slice(0, 40)}"`,
      agent.avisoDeArquivoNaoGerado({ text: frase, toolCalls: [] }) === null);
  }

  checar("resposta sem afirmacao nenhuma passa limpa",
    agent.avisoDeArquivoNaoGerado({
      text: "Esse relatório tem 6 colunas e agrupa por CFOP.",
      toolCalls: [],
    }) === null);

  /* A negacao vale pela FRASE: uma negativa sobre outro assunto na frase
     anterior nao pode calar o aviso. */
  checar("negacao de outra frase nao cala o aviso",
    agent.avisoDeArquivoNaoGerado({
      text: "Não consegui ler a pasta inteira. Gerei o relatório no padrão A2O.",
      toolCalls: [],
    }) !== null);

  checar("resposta vazia nao vira aviso",
    agent.avisoDeArquivoNaoGerado({ text: "", toolCalls: [] }) === null);

  /* ─── Sinal ESTRUTURAL: vale mais que a lista de frases ───
     O pedido era para gerar e nada foi escrito. Nao depende de o modelo
     escrever a afirmacao de um jeito previsto, que e o ponto fraco de
     reconhecer intencao por regex. */
  {
    const semAfirmar = {
      text: "Esse relatório agrupa por CFOP e tem 6 colunas visíveis.",
      toolCalls: [],
    };
    checar("pedido de geracao sem escrita avisa mesmo sem o modelo afirmar nada",
      agent.avisoDeArquivoNaoGerado(semAfirmar, { forcar: true }) !== null);
    checar("a mensagem do caso estrutural fala de expectativa, nao de contradicao",
      /O pedido era para produzir um arquivo/.test(
        agent.avisoDeArquivoNaoGerado(semAfirmar, { forcar: true })));
    checar("sem pedido de geracao a mesma resposta passa limpa",
      agent.avisoDeArquivoNaoGerado(semAfirmar, { forcar: false }) === null);
    checar("com escrita no fim, o sinal estrutural tambem cala",
      agent.avisoDeArquivoNaoGerado(
        { ...semAfirmar, toolCalls: [{ nome: "gerar_relatorio_a2o" }] },
        { forcar: true }
      ) === null);
    checar("leitura no fim nao satisfaz o pedido de geracao",
      agent.avisoDeArquivoNaoGerado(
        { ...semAfirmar, toolCalls: [{ nome: "ler_arquivo" }] },
        { forcar: true }
      ) !== null);
  }
  {
    /* Ficha: o modelo recusa com motivo, e o aviso ainda aparece porque o
       usuario pediu arquivo e nao tem arquivo. Mas a redacao nao pode
       desmenti-lo, senao o sistema vira ruido. */
    const recusaHonesta = {
      text: "Não gerei o arquivo: isto é ficha cadastral e o montador faz tabela. Use o _ficha.py.",
      toolCalls: [],
    };
    const aviso = agent.avisoDeArquivoNaoGerado(recusaHonesta, { forcar: true });
    checar("recusa honesta ainda avisa que nao ha arquivo", aviso !== null);
    checar("recusa honesta nao e acusada de afirmar o que nao fez",
      !/A resposta acima diz/.test(aviso || ""));
  }

  // ─────────────────────────────────────────────────────────────
  // 5. resolverConversa: a ordem que era o bug
  // ─────────────────────────────────────────────────────────────
  console.log("\nresolverConversa (laco, forcamento e aviso na mesma ordem)");

  {
    /* ⚠️ O caso exato que escapava: o modelo LE o arquivo e so depois responde
       em texto. O forcamento ficava antes do laco de leitura e nunca via esta
       segunda resposta. */
    const chamadas = [];
    const respostas = [
      { text: "", toolCalls: [{ id: "1", nome: "ler_arquivo", argumentos: { caminho: "x.jrxml" } }] },
      { text: "Aqui está o arquivo gerado com o nome novo.jrxml", toolCalls: [] },
      { text: "", toolCalls: [{ id: "2", nome: "criar_arquivo", argumentos: {} }] },
    ];
    const chamar = async (msgs, extras) => {
      chamadas.push(extras);
      return respostas[chamadas.length - 1];
    };
    const r = await agent.resolverConversa(chamar, [{ role: "user", content: "x" }], { forcar: true });
    checar("forca DEPOIS da leitura, nao so na primeira resposta",
      chamadas.length === 3 && chamadas[2].toolChoice === "required",
      `chamadas: ${JSON.stringify(chamadas)}`);
    checar("com a ferramenta chamada no fim, nao gruda aviso",
      !/Aviso do sistema/.test(r.text || ""));
  }

  {
    // Modelo insiste em texto mesmo forcado: o usuario tem que ser avisado.
    const avisado = [];
    const chamar = async () => ({ text: "Aqui está o arquivo gerado.", toolCalls: [] });
    const r = await agent.resolverConversa(chamar, [{ role: "user", content: "x" }], {
      forcar: true,
      aoAvisar: (t) => avisado.push(t),
    });
    checar("aviso entra no texto final", /Aviso do sistema/.test(r.text));
    checar("aviso tambem vai pelo onDelta (o texto ja esta na tela)",
      avisado.length === 1 && /Aviso do sistema/.test(avisado[0]));
  }

  // ─────────────────────────────────────────────────────────────
  // 6. Guardas de gravacao do montador
  // ─────────────────────────────────────────────────────────────
  console.log("\nGuardas de gravacao (gerar_relatorio_a2o)");

  const fs = require("fs");
  const RAIZ = process.env.JARVIS_ARQUIVOS_RAIZ;

  /* Entra pelo `executarFerramenta`, que e o caminho que a rota usa, e nao pela
     funcao interna: guarda que so vale chamando direto nao protege nada. */
  async function gerar(spec) {
    try {
      const r = await arquivos.executarFerramenta("gerar_relatorio_a2o", spec);
      return { codigo: "OK", r };
    } catch (erro) {
      return { codigo: erro.codigo || erro.code || erro.name, mensagem: erro.message };
    }
  }

  const CONTRATO = Array.from({ length: 20 }, (_, i) => ({
    nome: `campo${i}`, classe: "java.lang.String",
  }));
  const COLUNAS_OK = [
    { titulo: "Remetente", campo: "campo0" },
    { titulo: "Tomador", campo: "campo1" },
    { titulo: "Valor", campo: "campo2" },
  ];

  {
    /* ⚠️ O caso que destruiu o arquivo de um cliente em 2026-11-03: a saida leva
       o nome de um .jrxml que o usuario enviou. Sem `herdarDe` explicito, a
       checagem de nomes nao roda e so esta guarda segura. */
    fs.writeFileSync(path.join(RAIZ, "origem-do-usuario.jrxml"),
      '<?xml version="1.0"?>\n<jasperReport name="origem"><field name="campo0" class="java.lang.String"/></jasperReport>');
    const res = await gerar({
      saida: "origem-do-usuario.jrxml", nome: "x", campos: CONTRATO, colunas: COLUNAS_OK,
    });
    checar("recusa gravar sobre .jrxml que o montador nao gerou",
      res.codigo === "SOBRESCREVERIA_ORIGEM", `veio ${res.codigo}: ${res.mensagem || ""}`);
    checar("a recusa sugere um nome concreto",
      /origem-do-usuario-a2o\.jrxml/.test(res.mensagem || ""), res.mensagem);
    checar("o arquivo de origem continua intacto",
      fs.readFileSync(path.join(RAIZ, "origem-do-usuario.jrxml"), "utf8").includes('name="origem"'));
  }
  {
    // Saida nova: grava normalmente e devolve o caminho para o botao de baixar.
    const res = await gerar({
      saida: "origem-do-usuario-a2o.jrxml", nome: "x", campos: CONTRATO, colunas: COLUNAS_OK,
    });
    checar("saida com nome novo grava", res.codigo === "OK", `${res.codigo}: ${res.mensagem || ""}`);
    checar("o resultado traz caminho, colunas e campos (o card mostra isso)",
      res.r && res.r.caminho && res.r.colunas === 3 && res.r.campos === 20,
      JSON.stringify(res.r));

    // Regerar POR CIMA da propria saida e permitido: tem o marcador.
    const denovo = await gerar({
      saida: "origem-do-usuario-a2o.jrxml", nome: "x", campos: CONTRATO, colunas: COLUNAS_OK,
    });
    checar("regerar sobre a propria saida e permitido", denovo.codigo === "OK",
      `${denovo.codigo}: ${denovo.mensagem || ""}`);
  }
  {
    /* Piso de colunas: 1 coluna num contrato largo foi o que saiu no pedido do
       cliente, e o arquivo era valido e inutil. */
    const res = await gerar({
      saida: "uma-coluna-a2o.jrxml", nome: "x", campos: CONTRATO,
      colunas: [{ titulo: "Remetente", campo: "campo0" }],
    });
    checar("recusa 1 coluna num contrato de 20 campos",
      res.codigo === "COLUNAS_DE_MENOS", `veio ${res.codigo}`);

    // Contrato estreito continua podendo ter 1 coluna.
    const estreito = await gerar({
      saida: "estreito-a2o.jrxml", nome: "x",
      campos: [{ nome: "campo0", classe: "java.lang.String" }],
      colunas: [{ titulo: "Unica", campo: "campo0" }],
    });
    checar("contrato de 1 campo ainda pode ter 1 coluna", estreito.codigo === "OK",
      `${estreito.codigo}: ${estreito.mensagem || ""}`);
  }
  {
    const res = await gerar({
      saida: "sem-colunas-a2o.jrxml", nome: "x", campos: CONTRATO, colunas: [],
    });
    checar("sem coluna nenhuma continua recusado", res.codigo === "SEM_COLUNAS");
  }

  console.log(`\nRESULTADO: ${ok} ok, ${falhas} falha(s)`);
  process.exit(falhas ? 1 : 0);
})();

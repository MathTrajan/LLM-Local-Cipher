/**
 * ============================================================
 * JARVIS — Validacao de .jrxml (JasperReports)
 * ============================================================
 * Roda ANTES de gravar, no mesmo ponto em que a sandbox valida extensao e
 * tamanho. Arquivo que nao passa nao chega ao disco.
 *
 * Por que isto existe: o modelo e um Qwen 3B. Medido em 2026-11-01, ele produz
 * fragmento de JasperReports correto em ~6 s, mas erra o que um XML exige e uma
 * prosa nao: fecha tag na ordem errada, repete uuid, esquece atributo de cor e
 * devolve `uuid="your-uuid-here"` como placeholder. Nenhum desses erros aparece
 * ao ler a resposta; todos quebram na hora de compilar no JasperSoft Studio.
 *
 * ⚠️ Isto NAO e compilar. O teste real continua sendo emitir no servidor, como
 * diz o CLAUDE.md dos relatorios. O que esta aqui pega o erro barato antes de
 * custar uma ida ao cliente.
 *
 * Sem dependencia nova de proposito: o projeto tem 5 e todas puro JS, o que e o
 * que permite `npm ci` rodar em segundos no Celeron do servidor. Um parser XML
 * de verdade resolveria mais casos, mas o balanceamento de tags cobre o modo de
 * falha que o 3B realmente produz.
 * ============================================================
 */

/** Tags que se fecham sozinhas no padrao JasperReports (`<tag .../>`). */
const AUTO_FECHAVEIS = /\/>\s*$/;

/**
 * Ordem obrigatoria das secoes dentro de <jasperReport>. O JasperReports recusa
 * o arquivo quando elas vem fora desta sequencia, e a mensagem que ele devolve
 * aponta a linha errada: ela cita a secao que veio depois, nao a que estava no
 * lugar errado.
 */
const ORDEM_SECOES = [
  "property", "import", "template", "style", "subDataset", "parameter",
  "queryString", "field", "sortField", "variable", "filterExpression", "group",
  "background", "title", "pageHeader", "columnHeader", "detail", "columnFooter",
  "pageFooter", "lastPageFooter", "summary", "noData",
];

class ErroJrxml extends Error {
  constructor(mensagem, linha = null) {
    super(mensagem);
    this.name = "ErroJrxml";
    this.linha = linha;
  }
}

/**
 * Verifica se as tags abrem e fecham na ordem certa.
 * Devolve array de problemas (vazio = ok).
 */
function conferirBalanceamento(xml) {
  const problemas = [];
  const pilha = [];
  // Ignora comentarios, CDATA, declaracao e DOCTYPE: tudo que pode conter `<`
  // sem ser tag e produziria falso positivo.
  const limpo = xml
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<\?[\s\S]*?\?>/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!DOCTYPE[^>]*>/gi, (m) => m.replace(/[^\n]/g, " "));

  const re = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*)>/g;
  let m;
  while ((m = re.exec(limpo)) !== null) {
    const fechando = m[1] === "/";
    const nome = m[2];
    const autoFecha = AUTO_FECHAVEIS.test(m[0]);
    const linha = limpo.slice(0, m.index).split("\n").length;

    if (autoFecha) continue;
    if (!fechando) {
      pilha.push({ nome, linha });
      continue;
    }
    const aberta = pilha.pop();
    if (!aberta) {
      problemas.push(`linha ${linha}: </${nome}> fecha uma tag que nunca foi aberta`);
    } else if (aberta.nome !== nome) {
      problemas.push(
        `linha ${linha}: </${nome}> fecha fora de ordem. A tag aberta era <${aberta.nome}> na linha ${aberta.linha}`
      );
    }
  }
  for (const sobrou of pilha) {
    problemas.push(`linha ${sobrou.linha}: <${sobrou.nome}> foi aberta e nunca fechada`);
  }
  return problemas;
}

/** Confere a ordem das secoes de primeiro nivel dentro de <jasperReport>. */
function conferirOrdemDasSecoes(xml) {
  const problemas = [];
  const vistas = [];
  /* ⚠️ Remove os <subDataset> antes de olhar a ordem. Um subDataset tem
     `queryString`, `parameter` e `field` PROPRIOS, com indentacao que a regex
     de primeiro nivel nao distingue dos de fora. Sem isto, todo relatorio com
     subDataset era acusado de ordem errada: 59 dos 169 arquivos reais da
     empresa, todos funcionando em producao. Substitui por espacos para os
     numeros de linha continuarem corretos. */
  xml = xml.replace(/<subDataset\b[\s\S]*?<\/subDataset>/g, (m) => m.replace(/[^\n]/g, " "));
  // `[\s/>]` e nao `[\s>]`: secao auto-fechavel (`<title/>`) tem `/` logo
  // depois do nome e escapava da deteccao.
  const re = /^\s{0,4}<(\w+)[\s/>]/gm;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const idx = ORDEM_SECOES.indexOf(m[1]);
    if (idx === -1) continue;
    vistas.push({ nome: m[1], idx, linha: xml.slice(0, m.index).split("\n").length });
  }
  /* ⚠️ `property` fica FORA da checagem de ordem. O JasperReports aceita
     <property> em quase todo elemento (band, textField, reportElement), e a
     regex de primeiro nivel nao distingue a do topo das aninhadas. Validar a
     posicao dela acusava 31 dos 169 arquivos reais, todos corretos: o padrao
     era sempre "property veio depois de summary", que e uma property dentro da
     ultima banda. A ordem das OUTRAS secoes continua valendo. */
  const relevantes = vistas.filter((v) => v.nome !== "property");

  for (let i = 1; i < relevantes.length; i++) {
    const vistas = relevantes;   // mantem o resto do laco legivel
    // Secao repetida (varios <field>, varios <parameter>) e normal e nao conta.
    if (vistas[i].idx < vistas[i - 1].idx && vistas[i].nome !== vistas[i - 1].nome) {
      problemas.push(
        `linha ${vistas[i].linha}: <${vistas[i].nome}> veio depois de <${vistas[i - 1].nome}>. ` +
          `A ordem exigida e: ${ORDEM_SECOES.join(", ")}`
      );
    }
  }
  return problemas;
}

/**
 * Regras do padrao A2O que o 3B erra com frequencia.
 * Cada uma nasceu de uma armadilha ja paga, documentada no CLAUDE.md dos
 * relatorios.
 */
function conferirPadraoA2O(xml) {
  const problemas = [];

  // 1. `style` fora do <reportElement>. O JasperReports ignora em silencio e o
  //    layout sai sem formatacao nenhuma, sem erro em lugar nenhum.
  const styleForaDoLugar = xml.match(/<(textField|staticText|rectangle|line|image)\s[^>]*\bstyle=/g);
  if (styleForaDoLugar) {
    problemas.push(
      `${styleForaDoLugar.length} elemento(s) com \`style\` fora do <reportElement>. ` +
        `O atributo vai no <reportElement>, senao o estilo e ignorado SEM erro.`
    );
  }

  // 2. UUID placeholder. O modelo adora devolver "your-uuid-here" ou "uuid".
  const placeholders = xml.match(/uuid="(?!([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")[^"]*"/gi);
  if (placeholders) {
    problemas.push(
      `${placeholders.length} uuid invalido (ex.: ${placeholders[0]}). ` +
        `Use UUID v4 de verdade, no formato 8-4-4-4-12 hexadecimal.`
    );
  }

  // 3. UUID repetido. O Studio abre, mas o comportamento fica imprevisivel.
  const uuids = [...xml.matchAll(/uuid="([0-9a-f-]{36})"/gi)].map((m) => m[1].toLowerCase());
  const repetidos = uuids.filter((u, i) => uuids.indexOf(u) !== i);
  if (repetidos.length) {
    problemas.push(`uuid repetido ${repetidos.length} vez(es): ${[...new Set(repetidos)].slice(0, 3).join(", ")}`);
  }

  // 4. Caracteres que nao existem na Helvetica do PDF: saem como quadrado vazio.
  const foraDaHelvetica = [...new Set((xml.match(/[−➜✂]/g) || []))];
  if (foraDaHelvetica.length) {
    problemas.push(
      `caractere(s) que a Helvetica do PDF nao tem: ${foraDaHelvetica.join(" ")}. ` +
        `Troque por - ou por texto.`
    );
  }

  // 5. isIgnorePagination. Reprovado pelo conferidor de padrao da A2O.
  if (/isIgnorePagination\s*=\s*"true"/.test(xml)) {
    problemas.push(`isIgnorePagination="true" nao e aceito no padrao A2O.`);
  }

  // 6. Pagina fora do A4 retrato (595x842) ou paisagem (842x595).
  const larg = xml.match(/pageWidth="(\d+)"/);
  const alt = xml.match(/pageHeight="(\d+)"/);
  if (larg && alt) {
    const w = Number(larg[1]), h = Number(alt[1]);
    const ehA4 = (w === 595 && h === 842) || (w === 842 && h === 595);
    if (!ehA4) {
      problemas.push(`pagina ${w}x${h} nao e A4. Use 595x842 (retrato) ou 842x595 (paisagem).`);
    }
  }

  // 7. A cor recusada pelo usuario em 2026-10-16.
  if (/#4C537B/i.test(xml)) {
    problemas.push(`cor #4C537B foi recusada ("nao ficou no azul"). O azul A2O e #415F83.`);
  }

  return problemas;
}

/**
 * Valida o conteudo de um .jrxml. Lanca ErroJrxml com TODOS os problemas
 * juntos, nao so o primeiro: o modelo precisa ver a lista inteira para corrigir
 * numa tentativa, e cada nova tentativa custa segundos de inferencia.
 */
/**
 * @param {string} conteudo
 * @param {{ padraoA2O?: boolean }} opcoes
 *
 * ⚠️ `padraoA2O` e FALSO por padrao, e essa escolha vem de um erro medido.
 * A primeira versao checava o padrao sempre, inclusive no upload. Mas o arquivo
 * que o usuario sobe e justamente o que esta FORA do padrao: e o que vai ser
 * migrado. Resultado: 81% dos 169 .jrxml reais da empresa eram recusados no
 * upload (83 por pagina fora do A4, 35 pela cor recusada, 27 por
 * isIgnorePagination), e o fluxo inteiro de migracao ficava bloqueado.
 *
 * Estrutura (XML bem formado, ordem das secoes) vale SEMPRE: arquivo quebrado
 * nao serve nem para ser lido. Padrao A2O vale so para o que o Jarvis CRIA.
 */
function validar(conteudo, { padraoA2O = false } = {}) {
  const xml = String(conteudo || "");

  if (!/<jasperReport[\s>]/.test(xml)) {
    throw new ErroJrxml("o arquivo nao tem <jasperReport>. Um .jrxml precisa da raiz jasperReport.");
  }

  const problemas = [
    ...conferirBalanceamento(xml),
    ...conferirOrdemDasSecoes(xml),
    ...(padraoA2O ? conferirPadraoA2O(xml) : []),
  ];

  if (problemas.length) {
    throw new ErroJrxml(
      `O .jrxml tem ${problemas.length} problema(s):\n` +
        problemas.map((p, i) => `  ${i + 1}. ${p}`).join("\n")
    );
  }
  return true;
}

module.exports = { validar, ErroJrxml, ORDEM_SECOES };

/* ═══════════════════════════════════════════════════════════
   RESUMIR: de .jrxml existente para especificacao compacta
   ═══════════════════════════════════════════════════════════
   O caso de uso e "pegue este relatorio e ponha no padrao A2O". O arquivo
   enviado tem, em media, 17 mil tokens (medido nos 175 .jrxml da empresa) e o
   contexto do modelo e de 8.192. Mandar o XML inteiro e impossivel, e truncar
   seria pior: o modelo veria metade do arquivo e inventaria o resto.

   A saida daqui e o CONTRATO e o INVENTARIO do relatorio: o que ele recebe
   (parametros), o que ele le (fields), o que ele escreve (textos e expressoes),
   e como esta dividido (bandas). Com isso o modelo escreve o gerador Python; o
   XML velho nunca precisa ser lido por ele.

   ⚠️ Isto NAO preserva layout (x, y, largura, cor). E deliberado: o objetivo e
   justamente refazer o visual no padrao A2O. Guardar as coordenadas antigas
   empurraria o modelo a reproduzir o layout fora do padrao, que e o oposto do
   pedido.
*/

/** Tira CDATA e normaliza espaco de uma expressao, para caber numa linha. */
function limparExpr(txt) {
  return String(txt || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Decodifica as cinco entidades XML, para o texto sair legivel. */
function desescapar(txt) {
  return String(txt || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Le um .jrxml e devolve a especificacao em markdown compacto.
 * `limiteTextos` corta a lista de rotulos: num relatorio com 53 staticText, os
 * primeiros ja mostram o padrao de nomenclatura e o resto e repeticao.
 */
function resumir(conteudo, { limiteTextos = 40, limiteExpr = 30, tetoTokens = 2600 } = {}) {
  const xml = String(conteudo || "");

  /* ⚠️ Teto DURO de tamanho. Medido em 2026-11-03 com o pessoa_imprimir_3.jrxml
     (313 KB, 100 mil tokens): o resumo saiu com 12.187 tokens, MAIOR que o
     contexto inteiro do modelo (8.192). Comprimir 92% nao basta quando o
     arquivo e grande o suficiente, e o sintoma seria o pior possivel: o
     llama.cpp descarta o inicio do prompt em silencio e o modelo responde sobre
     a metade do arquivo que sobrou, sem nada indicando a perda.
     Arquivo grande entra em modo enxuto: so o contrato e a contagem por secao,
     sem rotulo nem expressao. */
  const enxuto = xml.length / 3.2 > 40000;
  if (enxuto) { limiteTextos = 0; limiteExpr = 0; }

  const linhas = [];

  const nome = xml.match(/<jasperReport[^>]*\bname="([^"]+)"/);
  const pw = xml.match(/pageWidth="(\d+)"/);
  const ph = xml.match(/pageHeight="(\d+)"/);
  const cw = xml.match(/columnWidth="(\d+)"/);

  linhas.push(`# Relatorio: ${nome ? nome[1] : "(sem nome)"}`);
  if (pw && ph) {
    const orient = Number(pw[1]) > Number(ph[1]) ? "paisagem" : "retrato";
    const ehA4 = (pw[1] === "595" && ph[1] === "842") || (pw[1] === "842" && ph[1] === "595");
    linhas.push(`Pagina: ${pw[1]}x${ph[1]} (${orient})${ehA4 ? "" : " [FORA DO A4, corrigir]"}`);
  }
  if (cw) linhas.push(`Largura util: ${cw[1]}`);

  // ─── Contrato: o que nao pode mudar ───
  const params = [...xml.matchAll(/<parameter name="([^"]+)"[^>]*class="([^"]+)"/g)]
    .map((m) => `${m[1]}: ${m[2].replace(/^java\.lang\./, "")}`);
  if (params.length) {
    linhas.push(`\n## Parametros (${params.length}) - copiar intactos do padrao`);
    linhas.push(params.join(", "));
  }

  const fields = [...xml.matchAll(/<field name="([^"]+)"[^>]*class="([^"]+)"/g)]
    .map((m) => `${m[1]}: ${m[2].replace(/^java\.lang\./, "").replace(/^java\.util\./, "")}`);
  if (fields.length) {
    linhas.push(`\n## Campos (${fields.length}) - copiar intactos do padrao`);
    linhas.push(fields.join(", "));
  }

  const vars = [...xml.matchAll(/<variable name="([^"]+)"[^>]*calculation="([^"]+)"/g)]
    .map((m) => `${m[1]} (${m[2]})`);
  if (vars.length) linhas.push(`\n## Variaveis (${vars.length})\n${vars.join(", ")}`);

  const grupos = [...xml.matchAll(/<group name="([^"]+)"/g)].map((m) => m[1]);
  if (grupos.length) linhas.push(`\n## Grupos\n${grupos.join(", ")}`);

  // ─── Inventario por banda: e o que diz o que o relatorio MOSTRA ───
  const bandas = [...xml.matchAll(
    /<(title|pageHeader|columnHeader|detail|columnFooter|pageFooter|summary|background|groupHeader|groupFooter)\b[\s\S]*?<\/\1>/g
  )];
  if (bandas.length) {
    linhas.push(`\n## Secoes`);
    for (const b of bandas) {
      const secao = b[1];
      const corpo = b[0];
      const textos = [...corpo.matchAll(/<text>([\s\S]*?)<\/text>/g)]
        .map((m) => desescapar(limparExpr(m[1]))).filter(Boolean);
      const exprs = [...corpo.matchAll(/<textFieldExpression>([\s\S]*?)<\/textFieldExpression>/g)]
        .map((m) => desescapar(limparExpr(m[1]))).filter(Boolean);
      const alt = corpo.match(/<band height="(\d+)"/);
      linhas.push(`\n### ${secao}${alt ? ` (altura ${alt[1]})` : ""}`);
      if (textos.length) {
        linhas.push(`Rotulos: ${textos.slice(0, limiteTextos).join(" | ")}` +
          (textos.length > limiteTextos ? ` ... +${textos.length - limiteTextos}` : ""));
      }
      if (exprs.length) {
        linhas.push(`Expressoes: ${exprs.slice(0, limiteExpr).join(" | ")}` +
          (exprs.length > limiteExpr ? ` ... +${exprs.length - limiteExpr}` : ""));
      }
      if (!textos.length && !exprs.length) linhas.push("(sem texto)");
    }
  }

  // ─── Sinais de problema, para o modelo saber o que corrigir ───
  const alertas = [];

  /* ⚠️ Ficha ou listagem? Decide pela contagem de campos e avisa em primeiro
     lugar. Em 2026-11-03 o modelo leu uma ficha de 73 campos e propos uma
     TABELA DE 18 COLUNAS: cada coluna ficaria com ~30 pontos, menos do que cabe
     a palavra "Razao Social". Ficha quer campo empilhado, listagem quer tabela,
     e os dois nao se convertem um no outro. */
  const qtdCampos = fields.length;
  if (qtdCampos > 20) {
    alertas.unshift(
      `ISTO E FICHA CADASTRAL, nao listagem: tem ${qtdCampos} campos. ` +
        `O gerar_relatorio_a2o faz TABELA e nao serve aqui. Diga isso ao usuario ` +
        `e aponte o _ficha.py, que monta campo empilhado em secoes. ` +
        `Se ele quiser mesmo uma listagem, escolha no maximo 8 colunas que importem.`
    );
  }
  if (/<subreport\b/.test(xml)) {
    alertas.push("USA SUBRELATORIO: na base A2O isso falha com Resource not found. Troque por tabela() com jr:list.");
  }
  if (/isIgnorePagination\s*=\s*"true"/.test(xml)) alertas.push("isIgnorePagination=true: remover.");
  if (/language="groovy"/.test(xml)) alertas.push('language="groovy": trocar para java.');
  if (/#4C537B/i.test(xml)) alertas.push("usa #4C537B, que foi recusado. O azul A2O e #415F83.");
  const fontes = [...new Set([...xml.matchAll(/fontName="([^"]+)"/g)].map((m) => m[1]))];
  if (fontes.length) alertas.push(`declara fontName (${fontes.join(", ")}): o padrao A2O nao declara fonte.`);
  if (alertas.length) linhas.push(`\n## Corrigir ao migrar\n` + alertas.map((a, i) => `${i + 1}. ${a}`).join("\n"));

  let saida = linhas.join("\n");

  /* Ultimo corte: se mesmo enxuto passar do teto, trunca pela metade das listas
     de campo e parametro, que sao o que mais cresce. */
  const tokens = () => saida.length / 3.2;
  if (tokens() > tetoTokens) {
    saida = saida.replace(/^(## (?:Campos|Parametros)[^\n]*\n)([^\n]+)$/gm, (m, cab, lista) => {
      const itens = lista.split(", ");
      const metade = itens.slice(0, Math.max(12, Math.floor(itens.length / 3)));
      return cab + metade.join(", ") + ` ... +${itens.length - metade.length} (lista cortada)`;
    });
  }
  if (tokens() > tetoTokens) {
    saida = saida.slice(0, Math.floor(tetoTokens * 3.2))
      + "\n\n[resumo cortado no teto de contexto]";
  }
  return saida;
}

module.exports.resumir = resumir;

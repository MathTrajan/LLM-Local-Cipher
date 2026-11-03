/**
 * ============================================================
 * JARVIS — Montador de relatorio no padrao A2O
 * ============================================================
 * Gera um .jrxml COMPLETO a partir de uma especificacao em JSON.
 *
 * Por que existe: o fluxo pedido e "envio um arquivo, recebo outro pronto para
 * baixar". Para isso o XML nao pode ser escrito pelo modelo. Medido em
 * 2026-11-01, ao longo de quatro rodadas de treino, o Qwen 3B acerta a FORMA
 * (import, estrutura, chamada) e erra o CONTEUDO (copia caminho do exemplo,
 * omite linha obrigatoria, deixa variavel sem definir). Para um arquivo que
 * precisa abrir no JasperSoft Studio, "quase certo" e igual a quebrado.
 *
 * A divisao de trabalho que funciona:
 *   modelo  -> especificacao em JSON (~300 tokens, tarefa que ele faz bem)
 *   codigo  -> o XML inteiro, sempre valido, sempre no padrao
 *
 * ⚠️ Isto e um SUBCONJUNTO do _ficha.py, que continua sendo a fonte da verdade
 * do padrao visual. Aqui estao so as pecas necessarias para gerar listagem e
 * ficha simples automaticamente: cabecalho, tabela, grade e rodape. Layout que
 * precise de jr:list aninhado, grafico ou imagem continua indo pelo _ficha.py.
 *
 * ⚠️ Duas copias do padrao divergem, e a licao do bug v1.7.1 do Capital vale
 * aqui. A mitigacao e que as constantes de cor e tamanho estao num bloco so,
 * declaradas com a origem anotada, e o `_conferir_padrao.py` reprova qualquer
 * saida que escape delas.
 * ============================================================
 */

const crypto = require("crypto");

/* ─── Paleta, medida na barra do CFAWeb (2026-10-16) ───
   Copiada de _ficha.py linha 16-17. Nao inventar tom novo: o #4C537B dos
   layouts antigos foi recusado ("nao ficou no azul"). */
const AZUL = "#415F83";
const AZUL_CLARO = "#CBD6E3";
const ZEBRA = "#EDF1F6";
const FUNDO = "#F2F5F9";
const ROTULO = "#5B6675";
const BORDA = "#9AA5B1";
const SEP = "#C9D0D8";
const TEXTO = "#1E2329";

/* ─── Escala de fontes. So estes tamanhos, nada entre eles. ─── */
const F_ROTULO = 5.5;
const F_NOTA = 6.5;
const F_TEXTO = 7;
const F_VALOR = 8;
const F_SUBTITULO = 10;
const F_DESTAQUE = 12;
const F_DOCUMENTO = 15;

const L_FINO = 0.25;
const L_MEDIO = 0.5;
const L_FORTE = 1.0;

const W = 555;              // A4 retrato com margens de 20
const W_PAISAGEM = 802;

const u = () => crypto.randomUUID();

/** Escapa o que vai como ATRIBUTO ou texto fora de CDATA. */
function esc(txt) {
  return String(txt ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * ⚠️ `]]>` dentro de CDATA fecha a secao no meio e quebra o XML. Acontece de
 * verdade com expressao Java que compara arrays. A quebra em duas secoes e a
 * forma canonica de escapar.
 */
function cdata(txt) {
  return `<![CDATA[${String(txt ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function reportElement(x, y, w, h, extra = {}) {
  const attrs = [`x="${Math.round(x)}"`, `y="${Math.round(y)}"`, `width="${Math.round(w)}"`, `height="${Math.round(h)}"`];
  if (extra.forecolor) attrs.push(`forecolor="${extra.forecolor}"`);
  if (extra.backcolor) { attrs.push(`backcolor="${extra.backcolor}"`, `mode="Opaque"`); }
  attrs.push(`uuid="${u()}"`);
  return `<reportElement ${attrs.join(" ")}/>`;
}

function textElement(al = "Left", va = "Middle", size = F_TEXTO, bold = false) {
  return `<textElement textAlignment="${al}" verticalAlignment="${va}">`
    + `<font size="${size}"${bold ? ' isBold="true"' : ""}/></textElement>`;
}

/** Texto fixo. */
function st(x, y, w, h, txt, o = {}) {
  return `<staticText>${reportElement(x, y, w, h, o)}`
    + `${textElement(o.al, o.va, o.size ?? F_TEXTO, o.bold)}`
    + `<text>${cdata(txt)}</text></staticText>`;
}

/** Campo calculado. `expr` e expressao Java, nao texto. */
function tf(x, y, w, h, expr, o = {}) {
  /* `isBlankWhenNull` evita a palavra "null" impressa no PDF, que e o defeito
     mais visivel de layout gerado sem cuidado. */
  return `<textField isBlankWhenNull="true"${o.stretch ? ' isStretchWithOverflow="true"' : ""}>`
    + `${reportElement(x, y, w, h, o)}`
    + `${textElement(o.al, o.va, o.size ?? F_TEXTO, o.bold)}`
    + `<textFieldExpression>${cdata(expr)}</textFieldExpression></textField>`;
}

function line(x, y, w, cor = AZUL, lw = L_MEDIO) {
  return `<line>${reportElement(x, y, w, 1)}`
    + `<graphicElement><pen lineWidth="${lw}" lineColor="${cor}"/></graphicElement></line>`;
}

function rect(x, y, w, h, back) {
  /* ⚠️ `<pen lineWidth="0">` explicito: sem ele o Jasper traca a borda na cor
     de frente e todo retangulo sai com contorno preto. */
  return `<rectangle>${reportElement(x, y, w, h, { backcolor: back })}`
    + `<graphicElement><pen lineWidth="0"/></graphicElement></rectangle>`;
}

/* ─── Formatadores: as mesmas regras do _ficha.py ─── */
const BR = 'new java.text.DecimalFormat("%s", new java.text.DecimalFormatSymbols(new java.util.Locale("pt","BR")))';

const FMT = {
  texto: (e) => `${e} == null ? "" : String.valueOf(${e})`,
  data: (e) => `${e} == null ? "" : java.time.format.DateTimeFormatter.ofPattern("dd/MM/yyyy").format(${e})`,
  datahora: (e) => `${e} == null ? "" : java.time.format.DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm").format(${e})`,
  numero: (e) => `${e} == null ? "" : ${BR.replace("%s", "#,##0.00")}.format(${e})`,
  inteiro: (e) => `${e} == null ? "" : ${BR.replace("%s", "#,##0")}.format(${e})`,
  // Zero vira vazio: no cadastro, 0 quase sempre significa "nao informado".
  dinheiro: (e) => `${e} == null || ${e}.doubleValue() == 0 ? "" : ${BR.replace("%s", "#,##0.00")}.format(${e})`,
  simnao: (e) => `${e} == null ? "" : (${e} ? "Sim" : "Nao")`,
};

/** Resolve a expressao de uma coluna a partir do campo e do formato. */
function exprDaColuna(col) {
  if (col.expr) return col.expr;                 // expressao crua, quando dada
  const campo = `$F{${col.campo}}`;
  const fmt = FMT[col.formato] || FMT.texto;
  return fmt(campo);
}

/**
 * Cabecalho padrao (a "top bar"): filial a esquerda, identificacao a direita,
 * filete azul embaixo. Equivale ao `cabecalho_faixa_lateral` do _ficha.py.
 */
function cabecalho(titulo, subtitulo, w = W) {
  const el = [];
  el.push(`<image scaleImage="RetainShape" hAlign="Center" vAlign="Middle" isUsingCache="true" onErrorType="Blank">`
    + `${reportElement(0, 0, 90, 56)}`
    + `<imageExpression>${cdata("$P{LOGO_FILIAL}")}</imageExpression></image>`);

  const cx = 98, cw = 242;
  el.push(tf(cx, 0, cw, 14, "$P{RAZAOSOCIAL_FILIAL}", { size: F_SUBTITULO, bold: true, forecolor: AZUL }));
  el.push(tf(cx, 15, cw, 10, FMT.texto("$P{ENDERECO_FILIAL}"), { size: F_TEXTO, forecolor: ROTULO }));
  el.push(tf(cx, 25, cw, 10,
    '($P{BAIRRO_FILIAL} == null ? "" : $P{BAIRRO_FILIAL}) + ($P{CIDADE} == null ? "" : " - " + $P{CIDADE})',
    { size: F_TEXTO, forecolor: ROTULO }));
  el.push(tf(cx, 35, cw, 10,
    '($P{CNPJ_FILIAL} == null ? "" : "CNPJ: " + $P{CNPJ_FILIAL})',
    { size: F_TEXTO, forecolor: ROTULO }));

  // Bloco de identificacao, encostado a direita.
  const bx = w - 205, bw = 205;
  el.push(line(bx - 6, 2, 1, SEP, L_FINO));
  el.push(st(bx, 13, bw, 8, String(titulo).toUpperCase(), { size: F_ROTULO, bold: true, al: "Right", forecolor: ROTULO }));
  el.push(st(bx, 21, bw, 21, subtitulo, { size: F_DESTAQUE, bold: true, al: "Right", va: "Bottom", forecolor: AZUL }));
  el.push(line(w - 28, 45, 28, AZUL, L_FORTE));
  el.push(tf(bx, 47, bw, 9, '$P{FILTROS} == null ? "" : $P{FILTROS}', { size: F_NOTA, al: "Right", forecolor: ROTULO }));
  el.push(line(0, 61, w, AZUL, L_FORTE));
  return { elementos: el, altura: 66 };
}

/** Rodape padrao: emissao a esquerda, identificacao e pagina a direita. */
function rodape(direita, w = W) {
  const d = w - W;
  return [
    line(0, 2, w, BORDA, L_FINO),
    tf(0, 4, 300, 10,
      '"Emitido em " + ($P{DATAPESQUISA} == null ? "" : $P{DATAPESQUISA}) + ($P{HORAPESQUISA} == null ? "" : " as " + $P{HORAPESQUISA}) + ($P{NOME_USUARIO} == null ? "" : " por " + $P{NOME_USUARIO})',
      { size: F_NOTA, forecolor: ROTULO }),
    tf(300 + d, 4, 175, 10, `"${esc(direita)}"`, { size: F_NOTA, al: "Right", forecolor: ROTULO }),
    tf(475 + d, 4, 80, 10, '"Pagina " + $V{PAGE_NUMBER}', { size: F_NOTA, al: "Right", forecolor: ROTULO }),
  ];
}

/**
 * Cabecalho de tabela (faixa azul) e a linha de detalhe.
 * `colunas` = [{titulo, largura, campo, formato, al}]
 *
 * ⚠️ As larguras sao NORMALIZADAS para somar a largura util. Coluna que o
 * modelo dimensionou errado sairia cortada ou deixaria vao; aqui a soma sempre
 * fecha, independente do que ele mandou.
 */
function normalizarLarguras(colunas, w) {
  const soma = colunas.reduce((s, c) => s + (Number(c.largura) || 0), 0);
  if (!soma) {
    const igual = Math.floor(w / colunas.length);
    return colunas.map((c, i) => ({ ...c, _w: i === colunas.length - 1 ? w - igual * (colunas.length - 1) : igual }));
  }
  let acc = 0;
  return colunas.map((c, i) => {
    const prop = Math.round(((Number(c.largura) || 0) / soma) * w);
    const largura = i === colunas.length - 1 ? w - acc : prop;
    acc += largura;
    return { ...c, _w: largura };
  });
}

function faixaDeColunas(colunas, w) {
  const el = [rect(0, 0, w, 14, AZUL)];
  let x = 0;
  for (const c of colunas) {
    el.push(st(x + 3, 0, c._w - 6, 14, c.titulo, {
      size: F_ROTULO, bold: true, al: c.al || "Left", forecolor: "#FFFFFF",
    }));
    x += c._w;
  }
  return { elementos: el, altura: 14 };
}

function linhaDeDetalhe(colunas, w) {
  // Zebra: o Jasper nao tem alternancia nativa, entao sai por printWhenExpression
  // no retangulo de fundo, avaliando a paridade da linha.
  const el = [`<rectangle><reportElement x="0" y="0" width="${w}" height="12" backcolor="${ZEBRA}" mode="Opaque" uuid="${u()}">`
    + `<printWhenExpression>${cdata("$V{REPORT_COUNT} % 2 == 0")}</printWhenExpression></reportElement>`
    + `<graphicElement><pen lineWidth="0"/></graphicElement></rectangle>`];
  let x = 0;
  for (const c of colunas) {
    el.push(tf(x + 3, 0, c._w - 6, 12, exprDaColuna(c), {
      size: F_TEXTO, al: c.al || "Left", forecolor: TEXTO,
    }));
    x += c._w;
  }
  el.push(line(0, 12, w, SEP, L_FINO));
  return { elementos: el, altura: 13 };
}

function banda(altura, elementos) {
  return `<band height="${Math.round(altura)}" splitType="Stretch">\n      ${elementos.join("\n      ")}\n    </band>`;
}


/* ═══════════════════════════════════════════════════════════
   KPIs, GRUPOS, TOTAIS E GRAFICOS
   ═══════════════════════════════════════════════════════════
   O que entra aqui saiu do inventario dos 175 .jrxml da empresa, medido em
   2026-11-01, e nao de suposicao sobre o que seria util:

     variable com Sum .... 81 arquivos   -> totais e KPI
     <group> ............. 52 arquivos   -> agrupamento com subtotal
     printWhenExpression . 63 arquivos   -> ja usado na zebra
     pieChart ............  3 arquivos
     barChart ............  1 arquivo

   Por isso total e agrupamento vem antes de grafico na ordem de importancia,
   embora grafico seja o que mais chama atencao num pedido.
*/

/** Variavel de relatorio. `calculo` e Sum, Count, Average, Highest, Lowest. */
function variavel(nome, expr, calculo = "Sum", classe = "java.math.BigDecimal", reset = "Report", grupo = null) {
  const resetAttr = grupo
    ? ` resetType="Group" resetGroup="${esc(grupo)}"`
    : ` resetType="${reset}"`;
  return `  <variable name="${esc(nome)}" class="${esc(classe)}" calculation="${calculo}"${resetAttr}>`
    + `<variableExpression>${cdata(expr)}</variableExpression></variable>`;
}

/**
 * Cartoes de indicador no topo (KPI).
 *
 * ⚠️ Os cartoes ficam no SUMMARY e nao no title, e isso e deliberado: variavel
 * com calculation Sum so tem o valor final depois que todas as linhas passaram.
 * Num KPI no title o Jasper imprime zero, sem erro nenhum, e o defeito so
 * aparece quando alguem confere o numero.
 */
function cartoesKpi(kpis, w) {
  if (!kpis.length) return { elementos: [], altura: 0 };
  const gap = 8;
  const larg = Math.floor((w - gap * (kpis.length - 1)) / kpis.length);
  const el = [];
  let x = 0;
  for (const k of kpis) {
    el.push(rect(x, 0, larg, 38, FUNDO));
    el.push(line(x, 0, larg, AZUL, L_FORTE));
    el.push(st(x + 8, 5, larg - 16, 8, k.rotulo, { size: F_ROTULO, bold: true, forecolor: ROTULO }));
    el.push(tf(x + 8, 14, larg - 16, 18, `$V{${k._var}}`, {
      size: F_DESTAQUE, bold: true, forecolor: AZUL, al: k.al || "Left",
    }));
    x += larg + gap;
  }
  return { elementos: el, altura: 44 };
}

/** Cabecalho de grupo: faixa clara com o valor que agrupa. */
function cabecalhoDeGrupo(campo, w) {
  return [
    rect(0, 2, w, 14, AZUL_CLARO),
    tf(6, 2, w - 12, 14, FMT.texto(`$F{${campo}}`), { size: F_VALOR, bold: true, forecolor: AZUL }),
  ];
}

/** Rodape de grupo: subtotais alinhados com as colunas. */
function rodapeDeGrupo(colunas, totais, w) {
  const el = [line(0, 0, w, AZUL, L_MEDIO)];
  let x = 0;
  let rotulouSubtotal = false;
  for (const c of colunas) {
    const t = totais.find((t) => t.coluna === c.campo);
    if (t) {
      el.push(tf(x + 3, 2, c._w - 6, 11, `$V{${t._varGrupo}}`, {
        size: F_TEXTO, bold: true, al: c.al || "Right", forecolor: AZUL,
      }));
    } else if (!rotulouSubtotal) {
      el.push(st(x + 3, 2, c._w - 6, 11, "Subtotal", { size: F_ROTULO, bold: true, forecolor: ROTULO }));
      rotulouSubtotal = true;
    }
    x += c._w;
  }
  return el;
}

/** Rodape da tabela: totais gerais, em faixa. */
function faixaDeTotais(colunas, totais, w) {
  const el = [rect(0, 0, w, 15, FUNDO), line(0, 0, w, AZUL, L_FORTE)];
  let x = 0;
  let rotulou = false;
  for (const c of colunas) {
    const t = totais.find((t) => t.coluna === c.campo);
    if (t) {
      el.push(tf(x + 3, 0, c._w - 6, 15, `$V{${t._var}}`, {
        size: F_VALOR, bold: true, al: c.al || "Right", forecolor: AZUL,
      }));
    } else if (!rotulou) {
      el.push(st(x + 3, 0, c._w - 6, 15, "Total", { size: F_ROTULO, bold: true, forecolor: ROTULO }));
      rotulou = true;
    }
    x += c._w;
  }
  return { elementos: el, altura: 17 };
}

/**
 * Grafico de barras ou pizza.
 *
 * ⚠️ Vai no SUMMARY pelo mesmo motivo dos KPIs: o dataset do grafico precisa de
 * todas as linhas processadas. E `<chart>` NAO aceita `<reportElement>` solto:
 * a ordem interna (chart > reportElement > dataset > plot) e exigida pelo DTD, e
 * trocar faz o Studio recusar o arquivo com erro que aponta outra linha.
 */
function grafico(spec, w) {
  const tipo = spec.tipo === "pizza" ? "pieChart" : "barChart";
  const altura = spec.altura || 180;
  const categoria = FMT.texto(`$F{${spec.categoria}}`);
  const valor = `$F{${spec.valor}}`;

  const serie = tipo === "pieChart"
    ? `<pieDataset>`
      + `<keyExpression>${cdata(categoria)}</keyExpression>`
      + `<valueExpression>${cdata(valor)}</valueExpression>`
      + `</pieDataset><piePlot><plot/></piePlot>`
    : `<categoryDataset><categorySeries>`
      + `<seriesExpression>${cdata(`"${esc(spec.titulo || "Total")}"`)}</seriesExpression>`
      + `<categoryExpression>${cdata(categoria)}</categoryExpression>`
      + `<valueExpression>${cdata(valor)}</valueExpression>`
      + `</categorySeries></categoryDataset>`
      + `<barPlot><plot/><itemLabel/><categoryAxisFormat><axisFormat/></categoryAxisFormat>`
      + `<valueAxisFormat><axisFormat/></valueAxisFormat></barPlot>`;

  const el = [];
  if (spec.titulo) {
    el.push(st(0, 0, w, 12, spec.titulo, { size: F_VALOR, bold: true, forecolor: AZUL }));
    el.push(line(0, 13, w, AZUL, L_MEDIO));
  }
  const y = spec.titulo ? 18 : 0;
  el.push(`<${tipo}><chart><reportElement x="0" y="${y}" width="${w}" height="${altura}" uuid="${u()}"/>`
    + `<chartTitle/><chartSubtitle/><chartLegend/></chart>${serie}</${tipo}>`);
  return { elementos: el, altura: y + altura + 6 };
}

/**
 * Monta o .jrxml completo.
 *
 * @param {object} spec
 *   nome        {string}  nome do relatorio
 *   titulo      {string}  rotulo pequeno do cabecalho (ex.: "LISTAGEM")
 *   subtitulo   {string}  linha principal (ex.: "Notas Fiscais de Servico")
 *   paisagem    {boolean}
 *   parametros  [{nome, classe}]   contrato, copiado do original
 *   campos      [{nome, classe}]   contrato, copiado do original
 *   colunas     [{titulo, largura, campo, formato, al}]
 *   rodape      {string}
 */
function montar(spec = {}) {
  const paisagem = spec.paisagem === true;
  const pw = paisagem ? 842 : 595;
  const ph = paisagem ? 595 : 842;
  const w = paisagem ? W_PAISAGEM : W;

  const nome = esc(spec.nome || "Relatorio");
  const colunas = normalizarLarguras(
    (spec.colunas || []).filter((c) => c && (c.campo || c.expr)),
    w
  );

  const agruparPor = spec.agruparPor || null;
  const nomeGrupo = agruparPor ? `g_${String(agruparPor).replace(/\W/g, "")}` : null;

  /* ─── Variaveis: KPI e totais ───
     Cada KPI e cada total vira uma `<variable>`. Nomear aqui, e nao deixar o
     modelo escolher, evita nome repetido e nome com caractere que o Jasper
     recusa. */
  const variaveis = [];
  const kpis = (spec.kpis || []).map((k, i) => {
    const v = `kpi${i}`;
    const classe = k.calculo === "Count" ? "java.lang.Integer" : "java.math.BigDecimal";
    const expr = k.calculo === "Count" ? "1" : `$F{${k.campo}}`;
    variaveis.push(variavel(v, expr, k.calculo || "Sum", classe));
    return { ...k, _var: v, _fmt: k.formato || (k.calculo === "Count" ? "inteiro" : "dinheiro") };
  });

  const totais = (spec.totais || []).map((t, i) => {
    const v = `tot${i}`;
    variaveis.push(variavel(v, `$F{${t.coluna}}`, t.calculo || "Sum"));
    const saida = { ...t, _var: v };
    /* Total por grupo precisa de uma variavel SEPARADA com resetType=Group: a
       mesma variavel nao pode zerar por grupo e acumular no relatorio. */
    if (nomeGrupo) {
      const vg = `sub${i}`;
      variaveis.push(variavel(vg, `$F{${t.coluna}}`, t.calculo || "Sum", "java.math.BigDecimal", "Group", nomeGrupo));
      saida._varGrupo = vg;
    }
    return saida;
  });

  /* ⚠️ Ordem das secoes conforme o DTD do JasperReports. Fora dela o arquivo
     nao compila, e a mensagem de erro aponta a secao seguinte, nao a errada. */
  const partes = [];
  partes.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  partes.push(`<jasperReport xmlns="http://jasperreports.sourceforge.net/jasperreports"`
    + ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`
    + ` xsi:schemaLocation="http://jasperreports.sourceforge.net/jasperreports http://jasperreports.sourceforge.net/xsd/jasperreport.xsd"`
    + ` name="${nome}" language="java" pageWidth="${pw}" pageHeight="${ph}" columnWidth="${w}"`
    + ` leftMargin="20" rightMargin="20" topMargin="20" bottomMargin="20" uuid="${u()}">`);

  /* ⚠️ Marcador de origem. Existe para o palpite de `herdarDe` NAO escolher um
     arquivo que o proprio montador gerou: em 2026-11-03 o palpite pegou a saida
     do teste anterior (2 campos) em vez do original (61), e o relatorio novo
     nasceu com 59 campos a menos. Arquivo gerado nao serve de contrato: o
     contrato mora no .jrxml que veio do sistema. */
  partes.push(`  <property name="br.com.a2o.gerado.por" value="jarvis-montador-a2o"/>`);

  for (const p of spec.parametros || []) {
    partes.push(`  <parameter name="${esc(p.nome)}" class="${esc(p.classe || "java.lang.String")}"/>`);
  }
  for (const f of spec.campos || []) {
    partes.push(`  <field name="${esc(f.nome)}" class="${esc(f.classe || "java.lang.String")}"/>`);
  }

  /* ⚠️ `sortField` antes do grupo, e nao e opcional: grupo NAO agrupa sem
     ordenacao pelo mesmo campo. O relatorio sai com o cabecalho repetindo a
     cada troca de valor, sem erro nenhum, e o defeito so aparece olhando o PDF.
     Esta e uma das armadilhas documentadas no SHALON. */
  if (agruparPor) {
    partes.push(`  <sortField name="${esc(agruparPor)}"/>`);
  }
  partes.push(...variaveis);

  if (agruparPor) {
    const cab = cabecalhoDeGrupo(agruparPor, w);
    const rod = totais.length ? rodapeDeGrupo(colunas, totais, w) : [];
    partes.push(`  <group name="${nomeGrupo}">`);
    partes.push(`    <groupExpression>${cdata(`$F{${agruparPor}}`)}</groupExpression>`);
    partes.push(`    <groupHeader>\n      ${banda(18, cab)}\n    </groupHeader>`);
    if (rod.length) partes.push(`    <groupFooter>\n      ${banda(16, rod)}\n    </groupFooter>`);
    partes.push(`  </group>`);
  }

  const cab = cabecalho(spec.titulo || "LISTAGEM", spec.subtitulo || spec.nome || "", w);
  partes.push(`  <pageHeader>\n    ${banda(cab.altura, cab.elementos)}\n  </pageHeader>`);

  if (colunas.length) {
    const faixa = faixaDeColunas(colunas, w);
    partes.push(`  <columnHeader>\n    ${banda(faixa.altura, faixa.elementos)}\n  </columnHeader>`);
    const det = linhaDeDetalhe(colunas, w);
    partes.push(`  <detail>\n    ${banda(det.altura, det.elementos)}\n  </detail>`);
    if (totais.length) {
      const tot = faixaDeTotais(colunas, totais, w);
      partes.push(`  <columnFooter>\n    ${banda(tot.altura, tot.elementos)}\n  </columnFooter>`);
    }
  } else {
    partes.push(`  <detail>\n    ${banda(12, [])}\n  </detail>`);
  }

  partes.push(`  <pageFooter>\n    ${banda(16, rodape(spec.rodape || spec.subtitulo || nome, w))}\n  </pageFooter>`);

  /* KPI e grafico vao no SUMMARY: variavel de soma so tem o valor final depois
     que todas as linhas passaram. No title sairiam zerados, sem erro. */
  const resumo = [];
  let alturaResumo = 0;
  if (kpis.length) {
    const cards = cartoesKpi(kpis, w);
    resumo.push(...cards.elementos);
    alturaResumo += cards.altura;
  }
  if (spec.grafico && spec.grafico.categoria && spec.grafico.valor) {
    const g = grafico(spec.grafico, w);
    // Desloca o grafico para baixo dos cartoes.
    const deslocado = g.elementos.map((e) =>
      e.replace(/y="(\d+)"/g, (_, y) => `y="${Number(y) + alturaResumo}"`));
    resumo.push(...deslocado);
    alturaResumo += g.altura;
  }
  if (resumo.length) {
    partes.push(`  <summary>\n    ${banda(alturaResumo, resumo)}\n  </summary>`);
  }

  partes.push(`</jasperReport>`);
  return partes.join("\n");
}

module.exports = { montar, AZUL, W, W_PAISAGEM, FMT };

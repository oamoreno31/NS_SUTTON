<?xml version="1.0"?>
<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">
<#--
    ============================================================================
    All Raw Materials Projection Report — Hardgoods (R3)
    Plantilla FreeMarker / Advanced PDF (BFO) para prbk_lib_r3_hardgoods_raw_materials_report.js

    Contrato de datos (inyectado desde crearPDF):
      record        -> customrecord_sgp_prebook (acceso: ${record.<campo>})
      data.headers  -> Array de encabezados (mismo orden que el Excel, 13 columnas:
                       CAT, PRODUCT CODE, PRODUCT DESCRIPTION, PACK PKxSTM,
                       UNITS NEEDED, BUNCHES NEEDED, CASES NEEDED, QUANTITY ONHAND,
                       PO RECVD LOC1, UNIT PREP COMP, IN BOUND LOC1,
                       CASES SHORT LOC1, CASES OVER LOC1)
      data.metadata -> { prebookId, prebookName, historicalStart, historicalEnd,
                         currentStart, currentEnd, loc1Label, view,
                         generatedAt, generatedAtDisplay, totalRows }
      data.metadata.view = "MAIN" | "CATEGORY" | "VENDOR"

      Si view == "MAIN":
        data.report -> Array plano de filas (sort Vendor → Subcategory → Product Code)
      Si view == "CATEGORY" | "VENDOR":
        data.groups -> Array de { label, rows: [...] }, ya ordenado y agrupado
                       (CATEGORY: por printing_seq; VENDOR: alfabético; label="/"
                       significa "sin dato" — ver BLANK_LABEL en la librería,
                       se pinta como "Vendor:"/"Category:" sin nada después)

    DISEÑO (confirmado por Omar contra el PDF de referencia legacy "WO720.RH by
    vendor", 2026-07-24):
      - Vista MAIN: grid con bordes, encabezado gris (igual que antes).
      - Vistas CATEGORY/VENDOR: estilo "reporte de sistema legacy" — fuente
        monoespaciada, sin bordes de celda, header de grupo en texto plano
        ("Vendor:25112 (7 items)") seguido de una línea de asteriscos, y una
        línea punteada separando cada grupo del siguiente. "End of Report" al
        final. Ver <table class="report-plain">.
    ============================================================================
-->
<#setting number_format="computer">
<pdf>
<head>
    <macrolist>
        <macro id="nlfooter">
            <table class="footer-table">
                <tr>
                    <td align="left">Generated: ${(data.metadata.generatedAtDisplay!data.metadata.generatedAt)!""}</td>
                    <td align="right">Page <pagenumber/> of <totalpages/></td>
                </tr>
            </table>
        </macro>
    </macrolist>

    <style type="text/css">
        body {
            font-family: Helvetica, sans-serif;
            font-size: 6.5pt;
            color: #000000;
        }

        /* ── Bloque de título ─────────────────────────────────────────── */
        table.title-block { width: 100%; margin-bottom: 6px; }
        .report-no    { font-size: 9pt; font-weight: bold; }
        .report-title { font-size: 8.5pt; font-weight: bold; }
        .meta-line    { font-size: 7.5pt; }

        /* ── Vista MAIN: grid con bordes ──────────────────────────────── */
        table.report {
            width: 100%;
            border-collapse: collapse;
            font-size: 6.5pt;
        }
        table.report th {
            border: 0.5px solid #000000;
            background-color: #d9d9d9;
            font-weight: bold;
            padding: 2px;
            text-align: center;
        }
        table.report td {
            border: 0.5px solid #000000;
            padding: 2px;
            vertical-align: top;
        }

        /* ── Vistas CATEGORY/VENDOR: estilo legacy monoespaciado, sin bordes ── */
        table.report-plain {
            width: 100%;
            border-collapse: collapse;
            font-family: Courier, monospace;
            font-size: 6.5pt;
        }
        table.report-plain th {
            border: none;
            border-bottom: 0.75px solid #000000;
            font-weight: bold;
            padding: 2px;
            text-align: center;
            background: transparent;
        }
        table.report-plain td {
            border: none;
            padding: 1px 2px;
            vertical-align: top;
        }
        tr.group-header-row td.group-header {
            font-family: Courier, monospace;
            font-weight: normal;
            padding: 5px 2px 0 2px;
        }
        tr.group-rule-row td.group-rule,
        tr.group-sep-row td.group-sep {
            font-family: Courier, monospace;
            padding: 0 2px;
            line-height: 1;
            overflow: hidden;
            white-space: nowrap;
        }
        tr.end-of-report-row td {
            font-family: Courier, monospace;
            font-weight: bold;
            text-align: center;
            padding-top: 8px;
        }

        .num { text-align: right; }
        .ctr { text-align: center; }

        /* ── Footer ───────────────────────────────────────────────────── */
        table.footer-table { width: 100%; font-size: 6pt; color: #555555; }

        .empty-msg { font-size: 9pt; font-style: italic; padding-top: 20px; }
    </style>
</head>

<body size="A4-landscape" footer="nlfooter" footer-height="18px"
      padding="0.4in 0.4in 0.4in 0.4in">

    <#-- Líneas de relleno para separadores de grupo (ver group-rule/group-sep);
         160/220 caracteres alcanzan el ancho de la página en A4-landscape a
         6.5pt Courier — el overflow:hidden de la celda recorta el sobrante. -->
    <#assign STAR_LINE><#list 1..170 as i>*</#list></#assign>
    <#assign DASH_LINE><#list 1..220 as i>-</#list></#assign>

    <#-- ===================== BLOQUE DE TÍTULO ===================== -->
    <table class="title-block">
        <tr>
            <td width="60%" class="report-no">WO720.RH&nbsp;&nbsp;&nbsp;# ${(data.metadata.prebookId!"")?xml}&nbsp;&nbsp;&nbsp;ALL RAW MATERIALS PROJECTION REPORT FOR ALL RECIPES</td>
            <td width="40%" align="right" class="report-title">${(data.metadata.generatedAtDisplay!data.metadata.generatedAt)!""}&nbsp;&nbsp;&nbsp;&nbsp;PAGE <pagenumber/></td>
        </tr>
        <tr>
            <td colspan="2" class="meta-line">PREPARED FOR: ${(data.metadata.prebookName!"")?xml}<#if (data.metadata.view!"MAIN") != "MAIN">&nbsp;&nbsp;&nbsp;&nbsp;(View: <#if (data.metadata.view!"") == "CATEGORY">By Category<#else>By Vendor</#if>)</#if></td>
        </tr>
        <tr>
            <td colspan="2" class="meta-line">ALL SUB CATS&nbsp;&nbsp;&nbsp;-&nbsp;HISTORY PERIOD: ${(data.metadata.historicalStart!"")?xml} - ${(data.metadata.historicalEnd!"")?xml}&nbsp;&nbsp;&nbsp;RELATING TO CURRENT PERIOD: ${(data.metadata.currentStart!"")?xml} - ${(data.metadata.currentEnd!"")?xml}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;INVENTORY FROZEN ON:</td>
        </tr>
        <tr>
            <td colspan="2" class="meta-line">PREEBOOK or PO DEADLINE:</td>
        </tr>
    </table>

    <#-- ===================== TABLA DEL REPORTE ==================== -->
    <#assign isMainView = (data.metadata.view!"MAIN") == "MAIN">
    <#assign tableClass = isMainView?then("report", "report-plain")>
    <table class="${tableClass}">
        <#-- Anchos de columna (13 columnas: CAT, PRODUCT CODE, PRODUCT DESCRIPTION,
             PACK PKxSTM, UNITS NEEDED, BUNCHES NEEDED, CASES NEEDED, QUANTITY ONHAND,
             PO RECVD LOC1, UNIT PREP COMP, IN BOUND LOC1, CASES SHORT LOC1, CASES OVER LOC1) -->
        <colgroup>
            <col width="4%"/>   <#-- CAT -->
            <col width="8%"/>   <#-- PRODUCT CODE -->
            <col width="18%"/>  <#-- PRODUCT DESCRIPTION -->
            <col width="7%"/>   <#-- PACK PKxSTM -->
            <col width="8%"/>   <#-- UNITS NEEDED -->
            <col width="8%"/>   <#-- BUNCHES NEEDED -->
            <col width="8%"/>   <#-- CASES NEEDED -->
            <col width="8%"/>   <#-- QUANTITY ONHAND -->
            <col width="7%"/>   <#-- PO RECVD LOC1 -->
            <col width="7%"/>   <#-- UNIT PREP COMP -->
            <col width="7%"/>   <#-- IN BOUND LOC1 -->
            <col width="9%"/>   <#-- CASES SHORT LOC1 -->
            <col width="9%"/>   <#-- CASES OVER LOC1 -->
        </colgroup>

        <#-- Encabezados (se repiten en cada página gracias a thead) -->
        <thead>
            <tr>
                <#list (data.headers)![] as h>
                    <th>${(h!"")?xml}</th>
                </#list>
            </tr>
        </thead>

        <tbody>
            <#macro dataRow row>
                <tr>
                    <td>${(row.cat!"")?xml}</td>
                    <td>${(row.productCode!"")?xml}</td>
                    <td>${(row.description!"")?xml}</td>
                    <td class="ctr">${(row.pkstm!"")?xml}</td>
                    <td class="num">${(row.unitsNeeded)!0}</td>
                    <td class="num">${(row.bunchesNeeded)!0}</td>
                    <td class="num">${(row.casesNeeded!"")?xml}</td>
                    <td class="num">${(row.qtyOnHand)!0}</td>
                    <td class="num">${(row.poReceived)!0}</td>
                    <td class="num">${(row.unitprepcomp)!0}</td>
                    <td class="num">${(row.inBound)!0}</td>
                    <td class="num">${(row.casesShort!"")?xml}</td>
                    <td class="num">${(row.casesOver!"")?xml}</td>
                </tr>
            </#macro>

            <#if isMainView>
                <#if (data.report?? && data.report?size > 0)>
                    <#list data.report as row>
                        <@dataRow row=row/>
                    </#list>
                <#else>
                    <tr><td colspan="13" class="empty-msg" align="center">No hardgoods data to display for this Prebook.</td></tr>
                </#if>
            <#else>
                <#if (data.groups?? && data.groups?size > 0)>
                    <#list data.groups as g>
                        <#-- Línea punteada ANTES de cada grupo salvo el primero (que arranca justo debajo del header de columnas). -->
                        <#if g?index gt 0>
                            <tr class="group-sep-row"><td class="group-sep" colspan="13">${DASH_LINE}</td></tr>
                        </#if>
                        <tr class="group-header-row">
                            <td class="group-header" colspan="13">
                                <#if (data.metadata.view!"") == "CATEGORY">Category:<#else>Vendor:</#if><#if (g.label!"") != "/">${(g.label!"")?xml}</#if>&nbsp;(${(g.rows?size)!0} item<#if (g.rows?size)!0 != 1>s</#if>)
                            </td>
                        </tr>
                        <tr class="group-rule-row"><td class="group-rule" colspan="13">${STAR_LINE}</td></tr>
                        <#list g.rows as row>
                            <@dataRow row=row/>
                        </#list>
                    </#list>
                    <tr class="group-sep-row"><td class="group-sep" colspan="13">${DASH_LINE}</td></tr>
                    <tr class="end-of-report-row"><td colspan="13">End of Report</td></tr>
                <#else>
                    <tr><td colspan="13" class="empty-msg" align="center">No hardgoods data to display for this Prebook.</td></tr>
                </#if>
            </#if>
        </tbody>
    </table>

</body>
</pdf>

<?xml version="1.0"?>
<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">
<#--
    ============================================================================
    All Raw Materials Projection Report — Greens (R2)
    Plantilla FreeMarker / Advanced PDF (BFO) para prbk_lib_r2_greens_projection_report.js

    No existía copia local de este archivo (solo vivía en el File Cabinet de
    NetSuite) — creada 2026-07-24 a partir del PDF de referencia legacy
    "WO720.R" (reporte plano, sin agrupar) que Omar compartió. Mismo estilo
    visual que la vista MAIN de R3 (report-plain): fuente Courier, sin bordes
    de celda, título con número de página.

    Contrato de datos (inyectado desde crearPDF):
      record        -> customrecord_sgp_prebook (acceso: ${record.<campo>})
      data.report   -> Array plano de filas (una por item; el reporte agrega
                       "para todas las recetas", sin sub-filas ni agrupación)
      data.headers  -> Array de encabezados (13 columnas, mismo orden que el
                       Excel: CAT, PRODUCT CODE, PRODUCT DESCRIPTION,
                       PACK PK/STM, STEMS NEEDED, BUNCHES NEEDED, CASES NEEDED,
                       QUANTITY ONHAND, UNIT PREP COMP, PO RECVD LOC1,
                       IN BOUND LOC1, CASES SHORT LOC1, CASES OVER LOC1).
                       NOTA: el PDF de referencia de Omar solo muestra 11 de
                       estas 13 columnas (sin PACK PK/STM ni UNIT PREP COMP) —
                       confirmado explícitamente mantenerlas igual (no son
                       parte del legacy pero sí del reporte actual).
      data.metadata -> { prebookId, prebookName, historicalStart, historicalEnd,
                         currentStart, currentEnd, loc1Label, generatedAt,
                         generatedAtDisplay, totalRows }
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
            font-family: Courier, monospace;
            font-size: 6.8pt;
            color: #000000;
        }

        /* ── Bloque de título ─────────────────────────────────────────── */
        table.title-block { width: 100%; margin-bottom: 6px; }
        .report-no    { font-size: 9pt; font-weight: bold; }
        .report-title { font-size: 8.5pt; font-weight: bold; }
        .meta-line    { font-size: 7.5pt; }

        /* ── Tabla del reporte: plana, sin bordes de celda (igual al legacy) ── */
        table.report-plain {
            width: 100%;
            border-collapse: collapse;
            font-family: Courier, monospace;
            font-size: 6.8pt;
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
        .num { text-align: right; }
        .ctr { text-align: center; }
        .txt { text-align: left; }

        /* ── Footer ───────────────────────────────────────────────────── */
        table.footer-table { width: 100%; font-size: 6pt; color: #555555; }

        .empty-msg { font-size: 9pt; font-style: italic; padding-top: 20px; }
    </style>
</head>

<body size="A4-landscape" footer="nlfooter" footer-height="18px"
      padding="0.4in 0.4in 0.4in 0.4in">

    <#-- ===================== BLOQUE DE TÍTULO ===================== -->
    <table class="title-block">
        <tr>
            <td width="60%" class="report-no">WO720.R&nbsp;&nbsp;&nbsp;# ${(data.metadata.prebookId!"")?xml}&nbsp;&nbsp;&nbsp;ALL RAW MATERIALS PROJECTION REPORT FOR ALL RECIPES</td>
            <td width="40%" align="right" class="report-title">${(data.metadata.generatedAtDisplay!data.metadata.generatedAt)!""}&nbsp;&nbsp;&nbsp;&nbsp;PAGE <pagenumber/></td>
        </tr>
        <tr>
            <td colspan="2" class="meta-line">PREPARED FOR: ${(data.metadata.prebookName!"")?xml}</td>
        </tr>
        <tr>
            <td colspan="2" class="meta-line">ALL SUB CATS&nbsp;&nbsp;&nbsp;-&nbsp;HISTORY PERIOD: ${(data.metadata.historicalStart!"")?xml} - ${(data.metadata.historicalEnd!"")?xml}&nbsp;&nbsp;&nbsp;RELATING TO CURRENT PERIOD: ${(data.metadata.currentStart!"")?xml} - ${(data.metadata.currentEnd!"")?xml}</td>
        </tr>
    </table>

    <#-- ===================== TABLA DEL REPORTE ==================== -->
    <table class="report-plain">
        <#-- Anchos de columna (13: CAT, PRODUCT CODE, PRODUCT DESCRIPTION,
             PACK PK/STM, STEMS NEEDED, BUNCHES NEEDED, CASES NEEDED,
             QUANTITY ONHAND, UNIT PREP COMP, PO RECVD LOC1, IN BOUND LOC1,
             CASES SHORT LOC1, CASES OVER LOC1) -->
        <colgroup>
            <col width="4%"/>   <#-- CAT -->
            <col width="9%"/>   <#-- PRODUCT CODE -->
            <col width="19%"/>  <#-- PRODUCT DESCRIPTION -->
            <col width="7%"/>   <#-- PACK PK/STM -->
            <col width="8%"/>   <#-- STEMS NEEDED -->
            <col width="8%"/>   <#-- BUNCHES NEEDED -->
            <col width="8%"/>   <#-- CASES NEEDED -->
            <col width="8%"/>   <#-- QUANTITY ONHAND -->
            <col width="7%"/>   <#-- UNIT PREP COMP -->
            <col width="7%"/>   <#-- PO RECVD LOC1 -->
            <col width="7%"/>   <#-- IN BOUND LOC1 -->
            <col width="8%"/>   <#-- CASES SHORT LOC1 -->
            <col width="8%"/>   <#-- CASES OVER LOC1 -->
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
            <#if (data.report?? && data.report?size > 0)>
                <#list data.report as row>
                    <tr>
                        <td class="txt">${(row.cat!"")?xml}</td>
                        <td class="txt">${(row.productCode!"")?xml}</td>
                        <td class="txt">${(row.description!"")?xml}</td>
                        <td class="ctr">${(row.pkstm!"")?xml}</td>
                        <td class="num">${(row.stemsNeeded)!0}</td>
                        <td class="num">${(row.bunchesNeeded)!0}</td>
                        <td class="num">${(row.casesNeeded!"")?xml}</td>
                        <td class="num">${(row.qtyOnHand)!0}</td>
                        <td class="num">${(row.unitprepcomp)!0}</td>
                        <td class="num">${(row.poReceived)!0}</td>
                        <td class="num">${(row.inBound)!0}</td>
                        <td class="num">${(row.casesShort!"")?xml}</td>
                        <td class="num">${(row.casesOver!"")?xml}</td>
                    </tr>
                </#list>
            <#else>
                <tr><td colspan="13" class="empty-msg" align="center">No greens data to display for this Prebook.</td></tr>
            </#if>
        </tbody>
    </table>

</body>
</pdf>

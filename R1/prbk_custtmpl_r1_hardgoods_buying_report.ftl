<?xml version="1.0"?>
<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">
<#--
    ============================================================================
    Hardgoods Buying Report  (Where Used Reporting)
    Plantilla FreeMarker / Advanced PDF (BFO) para prbk_lib_r1_hardgoods_buying_report.js

    Contrato de datos (inyectado desde crearPDF):
      record        -> customrecord_sgp_prebook (acceso: ${record.<campo>})
      data.report   -> Array de filas (bomRows), cada una con su arreglo anidado .recipes
      data.headers  -> Array de encabezados (mismo orden que el Excel)
      data.metadata -> { prebookId, prebookName, historicalStart, historicalEnd,
                         currentStart, currentEnd, generatedAt, totalRows }

    Diseño espejo del Excel (crearExcel):
      - Bloque de título de 3 filas
      - Fila de encabezados con borde fino en los 4 lados
      - Fila principal por item (item-level + 1ra receta), sub-filas por receta adicional
      - Items sin recetas: solo las 5 primeras columnas con datos, resto en blanco
    ============================================================================
-->
<#setting number_format="computer">
<pdf>
<head>
    <macrolist>
        <macro id="nlfooter">
            <table class="footer-table">
                <tr>
                    <td align="left">Generado: ${(data.metadata.generatedAt!"")?xml}</td>
                    <td align="right">Página <pagenumber/> de <totalpages/></td>
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
        .report-title { font-size: 11pt; font-weight: bold; }
        .meta-line    { font-size: 8pt; }

        /* ── Tabla principal del reporte ──────────────────────────────── */
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
        .num { text-align: right; }
        .ctr { text-align: center; }

        /* ── Footer ───────────────────────────────────────────────────── */
        table.footer-table { width: 100%; font-size: 6pt; color: #555555; }

        .empty-msg { font-size: 9pt; font-style: italic; padding-top: 20px; }
    </style>
</head>

<body size="A4-landscape" footer="nlfooter" footer-height="18px"
      padding="0.4in 0.4in 0.4in 0.4in">

    <#-- 2026-07-24: se sacó el formateo con ?string/?is_number — dejaba las
         celdas en 0 o en blanco cuando el valor no calzaba exactamente con
         lo que FreeMarker espera como "number" (aunque llegara bien desde
         JS). Ahora se imprime el valor tal cual llega del JSON (crearPDF).
         fmtNum/fmtCost quedan solo como pass-through (no tocan el valor) —
         se dejan los nombres/llamados para no reescribir cada celda. Si se
         necesita separador de miles o decimales fijos, formatear en JS
         antes de armar el JSON, no acá. -->
    <#function fmtNum n>
        <#return n!"">
    </#function>
    <#function fmtCost n>
        <#return n!"">
    </#function>

    <#-- ===================== BLOQUE DE TÍTULO ===================== -->
    <table class="title-block">
        <tr>
            <td width="35%" class="report-no">WO720 Report # ${(data.metadata.prebookId!"")?xml}</td>
            <td width="30%" align="center" class="report-title">${(data.metadata.prebookName!"")?xml}</td>
            <td width="35%">&nbsp;</td>
        </tr>
        <tr>
            <td colspan="3" class="meta-line">History: ${(data.metadata.historicalStart!"")?xml} - ${(data.metadata.historicalEnd!"")?xml}</td>
        </tr>
        <tr>
            <td colspan="3" class="meta-line">Current: ${(data.metadata.currentStart!"")?xml} - ${(data.metadata.currentEnd!"")?xml}</td>
        </tr>
    </table>

    <#-- ===================== TABLA DEL REPORTE ==================== -->
    <table class="report">
        <#-- Anchos de columna (proporcionales a las del Excel) -->
        <colgroup>
            <col width="2%"/>    <#-- CAT -->
            <col width="4.3%"/>  <#-- PRODUCT -->
            <col width="12.3%"/> <#-- DESCRIPTION -->
            <col width="9%"/>    <#-- TYPE -->
            <col width="4.3%"/>  <#-- # RECIPES -->
            <col width="10.5%"/> <#-- CODE DESCRIPTION -->
            <col width="2.5%"/>  <#-- CUST -->
            <col width="7.6%"/>  <#-- CUSTOMER NAME -->
            <col width="5.6%"/>  <#-- TOTAL UNITS -->
            <col width="2.1%"/>  <#-- + - -->
            <col width="4.3%"/>  <#-- FOB COST -->
            <col width="5.9%"/>  <#-- LANDED COST -->
            <col width="6.5%"/>  <#-- LOC1 OH UNITS -->
            <col width="6.5%"/>  <#-- LOC2 OH UNITS -->
            <col width="3.3%"/>  <#-- PO QTY -->
            <col width="8%"/>    <#-- PO RECEIVED -->
            <col width="5.3%"/>  <#-- PREP PRODUCTION -->
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
            <#if (data.report?size > 0)>
                <#list data.report as row>
                    <#-- ───── Fila principal del item ───── -->
                    <tr>
                        <td>${(row.cat!"")?xml}</td>
                        <td>${(row.product!"")?xml}</td>
                        <td>${(row.description!"")?xml}</td>
                        <td>${(row.type!"")?xml}</td>
                        <td class="ctr">${fmtNum(row.num_recipes)}</td>

                        <#if (row.recipes?size > 0)>
                            <#assign r0 = row.recipes[0]>
                            <td>${(r0.recipe_code!"")?xml}<#if (r0.recipedescription!"")?has_content> - ${(r0.recipedescription!"")?xml}</#if></td>
                            <td>${(r0.customer_code!"")?xml}</td>
                            <td>${(r0.customer_name!"")?xml}</td>
                            <td class="num">${fmtNum(row.totalUnits)}</td>
                            <#-- "+ -" = LOC1 OH UNITS + PO QTY - TOTAL UNITS (igual que el Excel) -->
                            <td class="num">${fmtNum(row.plus_minus)}</td>
                            <td class="num">${fmtCost(row.fob_cost)}</td>
                            <td class="num">${fmtCost(row.landed_cost)}</td>
                            <td class="num">${fmtNum(row.loc_1_oh)}</td>
                            <td class="num">${fmtNum(row.loc_2_oh)}</td>
                            <#-- OJO: orden espejo del Excel. Bajo "PO QTY" va po_received y
                                 bajo "PO RECEIVED" va po_qty. Para corregir, intercambiar las
                                 dos celdas siguientes. -->
                            <td class="num">${fmtNum(row.po_received)}</td>
                            <td class="num">${fmtNum(row.po_qty)}</td>
                            <td>&nbsp;</td><#-- PREP PRODUCTION (TBD) -->
                        <#else>
                            <#-- Item sin recetas: 12 columnas en blanco -->
                            <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                            <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                            <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                            <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                        </#if>
                    </tr>

                    <#-- ───── Sub-filas para recetas adicionales (índice > 0) ───── -->
                    <#if (row.recipes?size > 1)>
                        <#list row.recipes as recipe>
                            <#if (recipe?index > 0)>
                                <tr>
                                    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                                    <td>&nbsp;</td><td>&nbsp;</td>
                                    <td>${(recipe.recipe_code!"")?xml}<#if (recipe.recipedescription!"")?has_content> - ${(recipe.recipedescription!"")?xml}</#if></td>
                                    <td>${(recipe.customer_code!"")?xml}</td>
                                    <td>${(recipe.customer_name!"")?xml}</td>
                                    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                                    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                                    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                                </tr>
                            </#if>
                        </#list>
                    </#if>
                </#list>
            <#else>
                <tr>
                    <td colspan="17" class="empty-msg" align="center">
                        No hardgoods data to display for this Prebook.
                    </td>
                </tr>
            </#if>
        </tbody>
    </table>

</body>
</pdf>

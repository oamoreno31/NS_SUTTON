<?xml version="1.0"?>
<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">
<#--
    ============================================================================
    Hardgoods Buying Report  (Where Used Reporting)
    Plantilla FreeMarker / Advanced PDF (BFO) para prbk_lib_r1_hardgoods_buying_report.js

    Contrato de datos (inyectado desde crearPDF):
      record        -> customrecord_sgp_prebook (acceso: ${record.<campo>})
      data.report   -> Array de filas (bomRows), cada una con su arreglo anidado .recipes
      data.headers  -> Array de encabezados (ya filtrado según showItemCost)
      data.metadata -> { prebookId, prebookName, historicalStart, historicalEnd,
                         currentStart, currentEnd, generatedAt, totalRows, showItemCost }

    Diseño espejo del Excel (crearExcel):
      - Bloque de título de 3 filas
      - Fila de encabezados con borde fino en los 4 lados
      - Fila principal por item (item-level + 1ra receta), sub-filas por receta adicional
      - Items sin recetas: solo las 5 primeras columnas con datos, resto en blanco
      - FOB COST / LANDED COST se omiten por completo (colgroup + celdas) cuando
        data.metadata.showItemCost es false (checkbox "Show item cost" del preview).
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
            font-size: 5.5pt;
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
            font-size: 5.5pt;
        }
        table.report th {
            border: 0.5px solid #000000;
            background-color: #d9d9d9;
            font-weight: bold;
            padding: 2px;
            text-align: center;
            vertical-align: middle;
            font-size: 5.3pt;
            line-height: 7pt;
            white-space: normal;
        }
        table.report td {
            border: 0.5px solid #000000;
            padding: 1.5px 2px;
            vertical-align: top;
            text-align: left;
        }
        <#-- El motor BFO (Advanced PDF) envuelve el contenido de cada <td> en un
             <p> implícito con alineación "justify" por defecto. text-align en el
             <td> no tiene efecto sobre ese <p> interno, por eso .num/.ctr nunca
             se veían alineados (en texto de una sola línea "justify" se ve igual
             que "left", por eso el resto de columnas parecía correcto). Hay que
             apuntar el selector al <p> interno, no al <td>. -->
        table.report td p { text-align: left; }
        table.report td.num p { text-align: right; }
        table.report td.ctr p { text-align: center; }
        .trunc { white-space: nowrap; overflow: hidden; }

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

    <#-- Límites de caracteres para evitar salto de línea en columnas de texto largo. -->
    <#assign DESC_LIMIT = 40>
    <#assign CODEDESC_LIMIT = 35>
    <#assign CUSTNAME_LIMIT = 25>

    <#-- Comparación por string ('T'/'F'), no boolean: un JSON boolean llegado por el
         data source de FreeMarker no garantiza tipo, y <#if showItemCost> con false
         podía fallar/evaluar mal, dejando de pintar TODO el <tbody> (el <thead> ya se
         había renderizado antes del loop) — mismo tipo de bug que ?string/?is_number
         ya resuelto para los números. Ver crearPDF (prbk_lib_r1_hardgoods_buying_report.js). -->
    <#assign showItemCost = (data.metadata.showItemCost!'T') == 'T'>

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
            <col width="4.3%"/>  <#-- RECP. -->
            <col width="10.5%"/> <#-- CODE DESCRIPTION -->
            <col width="2.5%"/>  <#-- CUST -->
            <col width="7.6%"/>  <#-- CUSTOMER NAME -->
            <col width="5.6%"/>  <#-- TOTAL UNITS -->
            <col width="2.1%"/>  <#-- + - -->
            <#if showItemCost>
            <col width="4.3%"/>  <#-- FOB COST -->
            <col width="5.9%"/>  <#-- LANDED COST -->
            </#if>
            <col width="6.5%"/>  <#-- LOC1 OH UNITS -->
            <col width="6.5%"/>  <#-- LOC2 OH UNITS -->
            <col width="3.3%"/>  <#-- PO QTY -->
            <col width="8%"/>    <#-- PO RCVD -->
            <col width="5.3%"/>  <#-- PREP PROD. -->
        </colgroup>

        <#-- Encabezados (se repiten en cada página gracias a thead) -->
        <thead>
            <tr>
                <#-- CODE DESCRIPTION / CUSTOMER NAME / "+ -" quedan en una sola línea
                     (sin <br/> por espacio); el resto de headers multi-palabra sigue
                     partiéndose para no ensanchar esas columnas. -->
                <#list (data.headers)![] as h>
                    <#assign hStr = h!"">
                    <#if hStr == "CODE DESCRIPTION" || hStr == "CUSTOMER NAME" || hStr == "+ -">
                        <th align="center" valign="middle">${hStr?xml}</th>
                    <#else>
                        <th align="center" valign="middle">${hStr?xml?replace(" ", "<br/>")}</th>
                    </#if>
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
                        <td class="trunc">${(row.description!"")?truncate(DESC_LIMIT, "")?xml}</td>
                        <td>${(row.type!"")?xml}</td>
                        <td align="right">${fmtNum(row.num_recipes)?number?string.number}</td>

                        <#if (row.recipes?size > 0)>
                            <#assign r0 = row.recipes[0]>
                            <#assign codeDesc0 = (r0.recipe_code!"") + (((r0.recipedescription!"")?trim?has_content)?then(' - ' + (r0.recipedescription!""), ''))>
                            <td class="trunc">${codeDesc0?truncate(CODEDESC_LIMIT, "")?xml}</td>
                            <td align="right">${(r0.customer_code!"")?xml}</td>
                            <td class="trunc">${(r0.customer_name!"")?truncate(CUSTNAME_LIMIT, "")?xml}</td>
                            <td align="right">${fmtNum(row.totalUnits)?number?string.number}</td>
                            <td align="right">${fmtNum(row.plus_minus)?number?string.number}</td>
                            <#if showItemCost>
                            <td align="right">${fmtCost(row.fob_cost)?number?string.number}</td>
                            <td align="right">${fmtCost(row.landed_cost)?number?string.number}</td>
                            </#if>
                            <td align="right">${fmtNum(row.loc_1_oh)?number?string.number}</td>
                            <td align="right">${fmtNum(row.loc_2_oh)?number?string.number}</td>
                            <td align="right">${fmtNum(row.po_received)?number?string.number}</td>
                            <td align="right">${fmtNum(row.po_qty)?number?string.number}</td>
                            <td align="right">&nbsp;</td><#-- PREP PROD. (TBD) -->
                        <#else>
                            <#-- Item sin recetas: columnas restantes en blanco -->
                            <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                            <td>&nbsp;</td><td>&nbsp;</td>
                            <#if showItemCost><td>&nbsp;</td><td>&nbsp;</td></#if>
                            <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                            <td>&nbsp;</td><td>&nbsp;</td>
                        </#if>
                    </tr>

                    <#-- ───── Sub-filas para recetas adicionales (índice > 0) ───── -->
                    <#if (row.recipes?size > 1)>
                        <#list row.recipes as recipe>
                            <#if (recipe?index > 0)>
                                <#assign codeDescN = (recipe.recipe_code!"") + (((recipe.recipedescription!"")?trim?has_content)?then(' - ' + (recipe.recipedescription!""), ''))>
                                <tr>
                                    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                                    <td>&nbsp;</td><td>&nbsp;</td>
                                    <td class="trunc">${codeDescN?truncate(CODEDESC_LIMIT, "")?xml}</td>
                                    <td align="right">${(recipe.customer_code!"")?xml}</td>
                                    <td class="trunc">${(recipe.customer_name!"")?truncate(CUSTNAME_LIMIT, "")?xml}</td>
                                    <td>&nbsp;</td><td>&nbsp;</td>
                                    <#if showItemCost><td>&nbsp;</td><td>&nbsp;</td></#if>
                                    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                                    <td>&nbsp;</td><td>&nbsp;</td>
                                </tr>
                            </#if>
                        </#list>
                    </#if>
                </#list>
            <#else>
                <tr>
                    <td colspan="${showItemCost?then(17,15)}" class="empty-msg" align="center">
                        No hardgoods data to display for this Prebook.
                    </td>
                </tr>
            </#if>
        </tbody>
    </table>

</body>
</pdf>

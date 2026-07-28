<?xml version="1.0"?>
<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">
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

        table.title-block { width: 100%; margin-bottom: 6px; }
        .report-no    { font-size: 9pt; font-weight: bold; }
        .report-title { font-size: 8.5pt; font-weight: bold; }
        .meta-line    { font-size: 7.5pt; }

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
            font-size: 6pt;
            line-height: 8pt;
            white-space: normal;
        }
        table.report-plain td {
            border: none;
            padding: 1px 2px;
            vertical-align: top;
        }
        .num { text-align: right; }
        .ctr { text-align: center; }
        .txt { text-align: left; }

        /* ── Separador punteado al final de cada subcategoría ─────────── */
        tr.subcat-sep-row td {
            border: none;
            border-bottom: 1px dotted #000000;
            padding: 0;
            height: 1px;
            line-height: 1px;
            font-size: 1px;
        }

        table.footer-table { width: 100%; font-size: 6pt; color: #555555; }

        .empty-msg { font-size: 9pt; font-style: italic; padding-top: 20px; }
    </style>
</head>

<body size="A4-landscape" footer="nlfooter" footer-height="18px"
      padding="0.4in 0.4in 0.4in 0.4in">

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

    <table class="report-plain">
        <colgroup>
            <col width="9%"/>
            <col width="8%"/>
            <col width="17%"/>
            <col width="7%"/>
            <col width="8%"/>
            <col width="8%"/>
            <col width="8%"/>
            <col width="8%"/>
            <col width="7%"/>
            <col width="7%"/>
            <col width="7%"/>
            <col width="8%"/>
            <col width="8%"/>
        </colgroup>

        <thead>
            <tr>
                <#list (data.headers)![] as h>
                    <th>${(h!"")?xml?replace(" ", "<br/>")}</th>
                </#list>
            </tr>
        </thead>

        <#-- Total de columnas para colspan (separador y mensaje vacío). Se calcula
             con paréntesis explícitos: "(data.headers)![]?size" se parseaba mal
             (el ?size quedaba pegado al "![]" antes de aplicarse el default),
             terminando por interpolar la lista completa de headers en vez de su
             tamaño y rompiendo el render del PDF. -->
        <#assign colCount = ((data.headers)![])?size>

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
                    <#-- Separador punteado al cierre de cada subcategoría: las filas
                         vienen ordenadas por categoría/subcategoría (fase 9 del JS,
                         printingSeq → subcatCode → description), así que "row.cat"
                         (catCode + subcatCode) cambia justo quiebre de subcategoría.
                         Se compara contra la fila siguiente; sin fila siguiente
                         (última del reporte) también se dibuja. -->
                    <#assign curCat = (row.cat)!''>
                    <#if row_has_next>
                        <#assign nextCat = (data.report[row_index + 1].cat)!''>
                    <#else>
                        <#assign nextCat = ''>
                    </#if>
                    <#if curCat != nextCat>
                        <tr class="subcat-sep-row"><td colspan="${colCount}">&nbsp;</td></tr>
                    </#if>
                </#list>
            <#else>
                <tr><td colspan="${colCount}" class="empty-msg" align="center">No greens data to display for this Prebook.</td></tr>
            </#if>
        </tbody>
    </table>

</body>
</pdf>

/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define([
    'N/query',
    'N/search',
    'N/render',
    'N/record',
    'N/log',
    'N/file',
    'N/encode',
    './prbk_lib_reports_common'
], (query, search, render, record, log, file, encode, common) => {

    // =========================================================================
    // CONSTANTS
    // =========================================================================

    // Nombre del .ftl (File Cabinet) usado para el PDF.
    const HG_TEMPLATE_FILENAME = 'prbk_custtmpl_r1_hardgoods_buying_report.ftl';

    // Encabezados ORIGINALES (con las abreviaciones pedidas) — no cambiar el set de columnas.
    const ALL_HEADERS = ['CAT', 'PRODUCT', 'DESCRIPTION', 'TYPE', 'RECP.', 'CODE DESCRIPTION', 'CUST', 'CUSTOMER NAME',
        'TOTAL UNITS', '+ -', 'FOB COST', 'LANDED COST', 'LOC1 OH UNITS', 'LOC2 OH UNITS',
        'PO QTY', 'PO RCVD', 'PREP PROD.'];

    // Columnas que se ocultan cuando el checkbox "Show item cost" está desmarcado.
    const COST_HEADERS = ['FOB COST', 'LANDED COST'];

    /** true si se deben mostrar FOB COST/LANDED COST (checkbox marcado por defecto). */
    const isShowItemCost = (filterValues) =>
        String((filterValues || {}).show_item_cost || 'T').toUpperCase() !== 'F';

    /** Encabezados para el PDF: quita FOB COST/LANDED COST si showItemCost es false. */
    const getPdfHeaders = (showItemCost) =>
        showItemCost ? ALL_HEADERS : ALL_HEADERS.filter((h) => COST_HEADERS.indexOf(h) === -1);

    // =========================================================================
    // 1. METADATA
    // =========================================================================

    const getMetadata = () => ({
        id: 'HARDGOODS_BUYING',
        name: 'Hardgoods Buying Report',
        description: 'Hardgoods buying report with recipe context, per-location inventory, ' +
            'and Prebook purchase orders.',
        formats: ['PDF', 'EXCEL']
    });

    // =========================================================================
    // 2. FILTROS
    // =========================================================================

    const getFilterDefinitions = () => ([
        {
            id: 'prebook',
            label: 'Prebook',
            type: 'select',
            source: 'customrecord_sgp_prebook',
            mandatory: true,
            helpText: 'Select the Prebook. Currently used only as a reference for the file name; ' +
                'it does not filter report data yet.'
        },
        {
            id: 'output_format',
            label: 'Document Type',
            type: 'select',
            mandatory: true,
            options: [
                { value: 'EXCEL', text: 'Excel' },
                { value: 'PDF', text: 'PDF' }
            ],
            helpText: 'Select the document format to generate (Excel or PDF).',
            // previewChoice: el shell oculta este campo y lo elige desde los
            // botones Download Excel/PDF del preview. Ver prbk_sl_reports_shell.js.
            previewChoice: true
        },
        {
            id: 'show_item_cost',
            label: 'Show item cost',
            type: 'checkbox',
            defaultValue: 'T',
            // previewChoice + hideColumns: el shell pinta un checkbox real junto a los
            // botones de descarga (marcado por defecto) que oculta/muestra, en el
            // preview, las columnas cuyo header calce con hideColumns. Ver
            // prbk_sl_reports_shell.js → buildPreviewFragment.
            previewChoice: true,
            hideColumns: COST_HEADERS
        }
    ]);

    // =========================================================================
    // 3. VALIDACIÓN CROSS-FIELD
    // =========================================================================

    const validateFilters = (values) => {
        if (!values.prebook) {
            return { valid: false, message: 'You must select a Prebook.' };
        }
        const fmt = String(values.output_format || '').toUpperCase();
        if (!fmt) {
            return { valid: false, message: 'You must select the document type (Excel or PDF).' };
        }
        if (fmt !== 'EXCEL' && fmt !== 'PDF') {
            return { valid: false, message: 'Invalid document type. Use Excel or PDF.' };
        }
        return { valid: true };
    };

    // =========================================================================
    // 4. GENERATE — Orquesta la recolección de datos
    // =========================================================================

    /**
     * @param {Object} filterValues - .prebook (Internal ID), .output_format ('PDF'|'EXCEL')
     * @returns {Object} { fileObj, contentType, filename }
     */
    const generate = (filterValues) => {
        const prebookId = String(filterValues.prebook);
        const format = String(filterValues.output_format || 'EXCEL').toUpperCase();
        log.audit('HARDGOODS.generate', `prebook=${prebookId}  format=${format}`);

        // Cabecera del Prebook: se necesita el rango CURRENT antes de cargar filas
        // (filtra las BomRevision vigentes). Se sanitiza con safeStr porque
        // search.lookupFields puede devolver ScriptNullObjectAdapter en vez de null.
        const preebookDataRaw = search.lookupFields({
            type: 'customrecord_sgp_prebook',
            id: prebookId,
            columns: [
                'name',
                'custrecord_sgp_pb_historical_start_date',
                'custrecord_sgp_pb_historical_end_date',
                'custrecord_sgp_pb_current_start_date',
                'custrecord_sgp_pb_currency_end_date'
            ]
        });
        const preebookData = {};
        Object.keys(preebookDataRaw).forEach((k) => {
            preebookData[k] = safeStr(preebookDataRaw[k]);
        });

        // Rango CURRENT (no historical) contra el que se comparan las BomRevision.
        // El historical se sigue trayendo solo para el texto "History: ..." del header.
        const currentStart = preebookData.custrecord_sgp_pb_current_start_date;
        const currentEnd = preebookData.custrecord_sgp_pb_currency_end_date;

        // Ítems hardgoods + recetas (BOM) donde aparecen, ya filtradas por rango y activos.
        const bomRows = loadHardgoodsBomList(prebookId, currentStart, currentEnd);
        log.audit('HARDGOODS.bomRows', `count=${bomRows.length}`);

        const showItemCost = isShowItemCost(filterValues);

        const baseName = `HG_BuyingReport_${String(preebookData.name || prebookId).replace(/\s+/g, '_')}_${nowStamp()}`;

        if (format === 'PDF') {
            const reportPdf = crearPDF(getPdfHeaders(showItemCost), bomRows, `${baseName}.pdf`, prebookId, preebookData, showItemCost);
            return { fileObj: reportPdf, contentType: 'PDF', filename: `${baseName}.pdf` };
        }

        // Excel siempre recibe el set completo de headers: la columna se oculta con
        // ss:Hidden en crearExcel (así no se reindexan los <Column ss:Index="...">).
        const reportExcel = crearExcel(ALL_HEADERS, bomRows, `${baseName}.xlsx`, prebookId, preebookData, showItemCost);
        return { fileObj: reportExcel, contentType: 'application/vnd.ms-excel', filename: `${baseName}.xls` };
    };

    // =========================================================================
    // 4b. GET PREVIEW DATA — misma data que crearExcel, en JSON plano para el
    //     shell. No genera archivo; no toca generate/crearExcel/crearPDF.
    // =========================================================================

    /**
     * @param {Object} filterValues - .prebook (output_format se elige en el preview)
     * @returns {Object} { title, prebookName, metaLines, headers, rows, rowCount }
     */
    const getPreviewData = (filterValues) => {
        const prebookId = String(filterValues.prebook);
        log.audit('HARDGOODS.getPreviewData', `prebook=${prebookId}`);

        const preebookDataRaw = search.lookupFields({
            type: 'customrecord_sgp_prebook',
            id: prebookId,
            columns: [
                'name',
                'custrecord_sgp_pb_historical_start_date',
                'custrecord_sgp_pb_historical_end_date',
                'custrecord_sgp_pb_current_start_date',
                'custrecord_sgp_pb_currency_end_date'
            ]
        });
        const preebookData = {};
        Object.keys(preebookDataRaw).forEach((k) => { preebookData[k] = safeStr(preebookDataRaw[k]); });

        const bomRows = loadHardgoodsBomList(
            prebookId,
            preebookData.custrecord_sgp_pb_current_start_date,
            preebookData.custrecord_sgp_pb_currency_end_date
        );

        // El preview siempre manda el set completo de headers; el checkbox
        // "Show item cost" oculta/muestra FOB COST/LANDED COST client-side
        // (ver prbk_sl_reports_shell.js → buildPreviewFragment / hideColumns).
        return {
            title: 'Hardgoods Buying Report',
            prebookName: preebookData.name || prebookId,
            metaLines: [
                `WO720 Report # ${prebookId} — WHERE USED REPORTING`,
                `History: ${preebookData.custrecord_sgp_pb_historical_start_date} - ${preebookData.custrecord_sgp_pb_historical_end_date}`,
                `Current: ${preebookData.custrecord_sgp_pb_current_start_date} - ${preebookData.custrecord_sgp_pb_currency_end_date}`
            ],
            headers: ALL_HEADERS,
            rows: buildHardgoodsPreviewRows(bomRows),
            rowCount: bomRows.length
        };
    };

    /**
     * Arma `rows` jerárquicas ({ cells, visibleSubRows, subRows, recipeCount })
     * en el mismo layout de columnas que crearExcel. Primeras 5 recetas siempre
     * visibles (cells + visibleSubRows); de la 6ta en adelante van en `subRows`,
     * que el shell colapsa detrás de un toggle. Mantener espejado con crearExcel
     * ante cualquier cambio de orden de columnas.
     */
    const buildHardgoodsPreviewRows = (rows) => {
        return (rows || []).map((row) => {
            const recipes = row.recipes || [];
            const first = recipes.length > 0 ? recipes[0] : null;

            const cells = [
                safeStr(row.cat), safeStr(row.product), safeStr(row.description),
                safeStr(row.type), String(row.num_recipes || 0)
            ];

            if (recipes.length > 0) {
                cells.push(
                    first.recipe_code + ((first.recipedescription || '').trim() ? ' - ' + first.recipedescription : ''),
                    safeStr(first.customer_code),
                    safeStr(first.customer_name),
                    fmtNumber(row.totalUnits),
                    fmtNumber(row.plus_minus),             // "+ -": LOC1 + PO QTY - TOTAL UNITS
                    String(row.fob_cost || 0),
                    String(row.landed_cost || 0),
                    String(row.loc_1_oh || 0),
                    String(row.loc_2_oh || 0),
                    fmtNumber(row.po_received),            // bajo "PO QTY" (réplica invertida, igual que crearExcel)
                    fmtNumber(row.po_qty),                  // bajo "PO RECEIVED" (réplica invertida, igual que crearExcel)
                    ''                                      // PREP PRODUCTION
                );
            } else {
                cells.push('', '', '', '', '', '', '', '', '', '', '', '');
            }

            const toSubRow = (recipe) => ({
                cells: [
                    '', '', '', '', '',
                    recipe.recipe_code + ((recipe.recipedescription || '').trim() ? ' - ' + recipe.recipedescription : ''),
                    safeStr(recipe.customer_code),
                    safeStr(recipe.customer_name),
                    '', '', '', '', '', '', '', '', ''
                ],
                // Solo display (toggle "See all sub total units"): total units de esta receta.
                subTotalUnits: recipe.subTotalUnits != null ? fmtNumber(recipe.subTotalUnits) : ''
            });

            // Primeras 5 recetas SIEMPRE visibles (1 en `cells` + hasta 4 en visibleSubRows);
            // de la 6ta en adelante quedan detrás del toggle "View more recipes" (subRows).
            const extraRecipes = recipes.slice(1);
            const visibleSubRows = extraRecipes.slice(0, 4).map(toSubRow);
            const subRows = extraRecipes.slice(4).map(toSubRow);

            return {
                cells: cells,
                visibleSubRows: visibleSubRows,
                subRows: subRows,
                recipeCount: recipes.length,
                // Total units de la 1ra receta (misma que se ve en la fila principal), solo display.
                subTotalUnits: first && first.subTotalUnits != null ? fmtNumber(first.subTotalUnits) : ''
            };
        });
    };

    // =========================================================================
    // EXCEL — mismo formato/estructura original (no modificar sin necesidad)
    // =========================================================================

    // Límite real de file.create en NetSuite es 10 MB; dejamos margen.
    const MAX_XLS_BYTES = 9.8 * 1024 * 1024;

    const crearExcel = (headers, rows, fileName, prebookId, preebookData, showItemCost) => {
        try {
            const showCost = showItemCost !== false;
            const costHidden = showCost ? '' : ' ss:Hidden="1"';

            // Escapan XML (&, <, >); isEmptyValue blinda contra ScriptNullObjectAdapter.
            const escapeXml = (v) => isEmptyValue(v) ? '' :
                String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const EMPTY = '<Cell/>';
            const strCell = (v) => `<Cell><Data ss:Type="String">${escapeXml(v)}</Data></Cell>`;
            const numCell = (v) => `<Cell><Data ss:Type="Number">${escapeXml(v)}</Data></Cell>`;

            let xmlString = '<?xml version="1.0" encoding="UTF-8" ?>\n' +
                '<?mso-application progid="Excel.Sheet"?>\n' +
                '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
                'xmlns:o="urn:schemas-microsoft-com:office:office"\n' +
                'xmlns:x="urn:schemas-microsoft-com:office:excel"\n' +
                'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"\n' +
                'xmlns:html="http://www.w3.org/TR/REC-html40">\n' +
                '<DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">\n' +
                '<Author>SUTTON</Author>\n' +
                '<LastAuthor>SUTTON</LastAuthor>\n' +
                '<Created>2015-06-05T18:19:34Z</Created>\n' +
                '<Version>16.00</Version>\n' +
                '</DocumentProperties>\n' +
                '<OfficeDocumentSettings xmlns="urn:schemas-microsoft-com:office:office">\n' +
                '<AllowPNG/>\n' +
                '</OfficeDocumentSettings>\n' +
                '<ExcelWorkbook xmlns="urn:schemas-microsoft-com:office:excel">\n' +
                '<WindowHeight>12648</WindowHeight>\n' +
                '<WindowWidth>22260</WindowWidth>\n' +
                '<WindowTopX>32767</WindowTopX>\n' +
                '<WindowTopY>32767</WindowTopY>\n' +
                '<ProtectStructure>False</ProtectStructure>\n' +
                '<ProtectWindows>False</ProtectWindows>\n' +
                '</ExcelWorkbook>\n' +
                '<Styles>\n' +
                '<Style ss:ID="Default" ss:Name="Normal">\n' +
                '<Alignment ss:Vertical="Bottom"/>\n' +
                '<Borders>\n' +
                '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>\n' +
                '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>\n' +
                '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>\n' +
                '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>\n' +
                '</Borders>\n' +
                '<Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="11" ss:Color="#000000"/>\n' +
                '<Interior/>\n' +
                '<NumberFormat/>\n' +
                '<Protection/>\n' +
                '</Style>\n' +
                '<Style ss:ID="sPlain">\n' +
                '<Borders/>\n' +
                '</Style>\n' +
                '</Styles>\n' +
                '<Worksheet ss:Name="Hoja1">\n' +
                '<Table ss:ExpandedColumnCount="' + (headers.length + 2) + '" ss:ExpandedRowCount="' + rows.length + 100 + '" x:FullColumns="1"\n' +
                'x:FullRows="1" ss:DefaultRowHeight="14.4">\n' +
                '<Column ss:Index="1" ss:Width="22.799999999999997"/>\n' +
                '<Column ss:Index="2" ss:Width="49.2"/>\n' +
                '<Column ss:Index="3" ss:AutoFitWidth="0" ss:Width="141.6"/>\n' +
                '<Column ss:Index="4" ss:Width="103.2"/>\n' +
                '<Column ss:Index="5" ss:Width="49.2"/>\n' +
                '<Column ss:Index="6" ss:Width="120.60000000000001"/>\n' +
                '<Column ss:Index="7" ss:Width="28.8"/>\n' +
                '<Column ss:Index="8" ss:Width="87"/>\n' +
                '<Column ss:Index="9" ss:Width="64.2"/>\n' +
                '<Column ss:Index="10" ss:Width="24"/>\n' +
                '<Column ss:Index="11" ss:Width="49.2"' + costHidden + '/>\n' +
                '<Column ss:Index="12" ss:Width="67.8"' + costHidden + '/>\n' +
                '<Column ss:Index="13" ss:Width="75"/>\n' +
                '<Column ss:Index="14" ss:Width="75"/>\n' +
                '<Column ss:Index="15" ss:Width="38.4"/>\n' +
                '<Column ss:Index="16" ss:Width="91.8"/>\n' +
                '<Row>\n' +
                '<Cell ss:Index="4" ss:StyleID="sPlain"><Data ss:Type="String">WO720 Report # ' + escapeXml(prebookId) + '</Data></Cell>\n' +
                '<Cell ss:Index="6" ss:StyleID="sPlain"><Data ss:Type="String">WHERE USED REPORTING</Data></Cell>\n' +
                '</Row>\n' +
                '<Row>\n' +
                '<Cell ss:Index="3" ss:StyleID="sPlain"><Data ss:Type="String">History: ' + escapeXml(preebookData.custrecord_sgp_pb_historical_start_date) + ' - ' + escapeXml(preebookData.custrecord_sgp_pb_historical_end_date) + '</Data></Cell>\n' +
                '</Row>\n' +
                '<Row>\n' +
                '<Cell ss:Index="3" ss:StyleID="sPlain"><Data ss:Type="String">Current: ' + escapeXml(preebookData.custrecord_sgp_pb_current_start_date) + ' - ' + escapeXml(preebookData.custrecord_sgp_pb_currency_end_date) + '</Data></Cell>\n' +
                '</Row>\n';

            // Fila de Headers
            xmlString += '<Row>\n';
            headers.forEach(header => {
                xmlString += strCell(header);
            });
            xmlString += '</Row>\n';

            // Filas de datos
            rows.forEach(row => {
                let firstRecipe = row.recipes && row.recipes.length > 0 ? row.recipes[0] : null;
                xmlString += '<Row>';
                xmlString += strCell(row.cat);
                xmlString += strCell(row.product);
                xmlString += strCell(row.description);
                xmlString += strCell(row.type);
                xmlString += numCell(row.num_recipes);
                if (row.recipes.length > 0) {
                    xmlString += strCell(firstRecipe.recipe_code + ((firstRecipe.recipedescription || '').trim() ? " - " : "") + firstRecipe.recipedescription);
                    xmlString += strCell(firstRecipe.customer_code);
                    xmlString += strCell(firstRecipe.customer_name);
                    xmlString += strCell(fmtNumber(row.totalUnits));
                    xmlString += strCell(fmtNumber(row.plus_minus));    // "+ -": LOC1 + PO QTY - TOTAL UNITS
                    xmlString += strCell(row.fob_cost);
                    xmlString += strCell(row.landed_cost);
                    xmlString += strCell(row.loc_1_oh);
                    xmlString += strCell(row.loc_2_oh);
                    xmlString += strCell(fmtNumber(row.po_received));   // bajo "PO QTY" (réplica invertida del Excel)
                    xmlString += strCell(fmtNumber(row.po_qty));        // bajo "PO RECEIVED" (réplica invertida del Excel)
                    xmlString += EMPTY;                      // PREP PRODUCTION
                    xmlString += '</Row>';
                    // Máximo 5 recetas mostradas (1 en la fila principal + hasta 4 sub-filas),
                    // aunque haya más — # RECIPES y TOTAL UNITS siguen reflejando el total real.
                    row.recipes.slice(0, 5).forEach((recipe, index) => {
                        if (index === 0) return; // ya impresa en la fila principal
                        xmlString += '<Row>';
                        xmlString += EMPTY + EMPTY + EMPTY + EMPTY + EMPTY;
                        xmlString += strCell(recipe.recipe_code + ((recipe.recipedescription || '').trim() ? " - " : "") + recipe.recipedescription);
                        xmlString += strCell(recipe.customer_code);
                        xmlString += strCell(recipe.customer_name);
                        xmlString += EMPTY + EMPTY + EMPTY + EMPTY + EMPTY + EMPTY + EMPTY + EMPTY + EMPTY;
                        xmlString += '</Row>';
                    });
                } else {
                    xmlString += EMPTY + EMPTY + EMPTY + EMPTY + EMPTY + EMPTY +
                        EMPTY + EMPTY + EMPTY + EMPTY + EMPTY + EMPTY;
                    xmlString += '</Row>';
                }
            });

            xmlString += ' </Table>\n' +
                '<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">\n' +
                '<PageSetup>\n' +
                '<Header x:Margin="0.3"/>\n' +
                '<Footer x:Margin="0.3"/>\n' +
                '<PageMargins x:Bottom="0.75" x:Left="0.7" x:Right="0.7" x:Top="0.75"/>\n' +
                '</PageSetup>\n' +
                '<Selected/>\n' +
                '<Panes>\n' +
                '<Pane>\n' +
                '<Number>3</Number>\n' +
                '<ActiveCol>3</ActiveCol>\n' +
                '</Pane>\n' +
                '</Panes>\n' +
                '</WorksheetOptions>\n' +
                '</Worksheet>\n' +
                '</Workbook>';

            let base64EncodedString = encode.convert({
                string: xmlString,
                inputEncoding: encode.Encoding.UTF_8,
                outputEncoding: encode.Encoding.BASE_64
            });

            // Tamaño real ≈ len(base64) * 3/4. Si supera el margen, mensaje accionable.
            const approxFileBytes = Math.floor(base64EncodedString.length * 3 / 4);
            if (approxFileBytes > MAX_XLS_BYTES) {
                const mb = (approxFileBytes / (1024 * 1024)).toFixed(1);
                throw new Error(
                    `The generated Excel file is ~${mb} MB, which exceeds NetSuite's 10 MB limit. ` +
                    `Generate the report in PDF format or reduce the Prebook scope (fewer items/recipes).`
                );
            }

            let excelFile = file.create({
                name: fileName || 'export_netSuite.xls',
                fileType: file.Type.EXCEL,
                contents: base64EncodedString
            });

            return excelFile;
        } catch (error) {
            log.error('HARDGOODS.crearExcel', `Error al crear Excel: ${error.message}`);
            throw error; // re-lanzar para que el shell muestre el mensaje
        }
    };

    // =========================================================================
    // PDF
    // =========================================================================

    /** Resuelve el Internal ID de un archivo del File Cabinet por nombre. */
    const findTemplateFileId = (fileName) => {
        const sql = `SELECT id FROM file WHERE name = ? ORDER BY id`;
        const rs = query.runSuiteQL({ query: sql, params: [fileName] });
        const results = rs.asMappedResults();
        return results.length ? results[0].id : null;
    };

    /** Genera el PDF a partir de la plantilla FTL del File Cabinet. */
    const crearPDF = (headers, rows, fileName, prebookId, preebookData, showItemCost) => {
        try {
            const templateFileId = findTemplateFileId(HG_TEMPLATE_FILENAME);
            if (!templateFileId) {
                throw new Error(`Template '${HG_TEMPLATE_FILENAME}' not found in the File Cabinet.`);
            }

            const templateFile = file.load({ id: templateFileId });

            const renderer = render.create();
            renderer.templateContent = templateFile.getContents();

            // Record del Prebook → ${record.<campo>} en la FTL
            const preBookObj = record.load({
                type: 'customrecord_sgp_prebook',
                id: prebookId
            });
            renderer.addRecord({ templateName: 'record', record: preBookObj });

            // Datos del reporte → ${data.report[...]} / ${data.metadata.*}
            // Máximo 5 recetas por fila (igual que crearExcel); num_recipes/totalUnits
            // no se tocan, siguen reflejando el total real.
            const reportForPdf = rows.map((row) => Object.assign({}, row, {
                recipes: (row.recipes || []).slice(0, 5)
            }));
            renderer.addCustomDataSource({
                format: render.DataSource.JSON,
                alias: 'data',
                data: JSON.stringify({
                    report: reportForPdf,
                    headers: headers,
                    metadata: {
                        prebookId: prebookId,
                        prebookName: preebookData.name || '',
                        historicalStart: preebookData.custrecord_sgp_pb_historical_start_date || '',
                        historicalEnd: preebookData.custrecord_sgp_pb_historical_end_date || '',
                        currentStart: preebookData.custrecord_sgp_pb_current_start_date || '',
                        currentEnd: preebookData.custrecord_sgp_pb_currency_end_date || '',
                        generatedAt: nowStamp(),
                        totalRows: rows.length,
                        // 'T'/'F' en vez de boolean: igual que el bug ya resuelto de
                        // ?string/?is_number (ver R1 PDF sin formato), un boolean JSON
                        // llega al data source de FreeMarker sin garantía de tipo —
                        // <#if showItemCost> podía evaluar mal (o tirar error) cuando
                        // venía false, dejando de renderizar TODAS las filas del <tbody>
                        // (el <thead> ya se había pintado antes del loop). Comparando
                        // contra el string 'T' se evita esa ambigüedad de tipo.
                        showItemCost: (showItemCost !== false) ? 'T' : 'F'
                    }
                })
            });

            const pdfFile = renderer.renderAsPdf();
            pdfFile.name = fileName || 'export_netSuite.pdf';

            return pdfFile;
        } catch (error) {
            log.error('HARDGOODS.crearPDF', `Error al crear PDF: ${error.message}`);
            throw error; // re-lanzar para que el shell muestre el mensaje (igual que crearExcel)
        }
    };

    // =========================================================================
    // QUERIES (N/query — SuiteQL)
    // =========================================================================

    /** Corre SuiteQL paginando de a 1000 filas (evita el límite de 5000 de runSuiteQL directo). */
    const runSuiteQLAll = (sql, params) => {
        params = params || [];
        try {
            const out = [];
            const paged = query.runSuiteQLPaged({
                query: sql,
                params: params,
                pageSize: 1000
            });
            paged.pageRanges.forEach((pr) => {
                const page = paged.fetch({ index: pr.index });
                page.data.asMappedResults().forEach((r) => out.push(r));
            });
            return out;
        } catch (ePaged) {
            // Algunas tablas-mapa del sistema no soportan paginación; fallback a runSuiteQL directo.
            log.debug('HARDGOODS.runSuiteQLAll',
                `Sin paginación para esta consulta, uso runSuiteQL directo. Detalle: ${ePaged.message}`);
            const results = query.runSuiteQL({ query: sql, params: params }).asMappedResults();
            if (results.length === 5000) {
                log.error('HARDGOODS.runSuiteQLAll',
                    'La consulta sin paginación devolvió 5000 filas: posible truncamiento (revisar volumen).');
            }
            return results;
        }
    };

    /** Parte un arreglo de IDs en listas para cláusulas IN (), en bloques de `size`. */
    const chunkIds = (ids, size) => {
        const out = [];
        for (let i = 0; i < ids.length; i += size) {
            const inList = ids.slice(i, i + size)
                .map((x) => Number(x)).filter((n) => !isNaN(n)).join(', ');
            if (inList) out.push(inList);
        }
        return out;
    };

    /**
     * Construye las filas: ítems Hardgoods de tipo Assembly y, por cada uno,
     * TODAS las Bill of Materials donde el ítem aparece como material real,
     * usando la MISMA lógica de explosión de 2 niveles que
     * pa_sl_bom_explosion_ui.js (BOM Explosion tool):
     *   assembly → bom → bomRevisionBomMap → bomRevision → bomRevisionComponentMember (comp)
     *   y si comp.itemsource IN ('WORK_ORDER','PHANTOM'), se explota un 2do nivel
     *   (sub_iaib/sub_bom/sub_map/sub_bomRev/subcomp) para llegar al material real.
     * El ítem que termina representando la fila (PRODUCT/CAT/DESCRIPTION/etc.) es
     * comp.item cuando NO es WORK_ORDER/PHANTOM, o subcomp.item cuando sí lo es;
     * si un WORK_ORDER/PHANTOM no tiene su propia sub-BOM, esa línea se descarta
     * por completo (igual que en BOM Explosion). La BOM "padre" (para CODE
     * DESCRIPTION/CUST/CUSTOMER NAME, fase 4) sigue siendo siempre la receta
     * principal (bom/bomRevision de nivel 1), nunca la micro-BOM del phantom/WO.
     *
     * Filtros aplicados YA en el SQL de la fase 2 (no post-fetch en JS, para
     * traer menos filas): bom/bomRevision.isinactive = 'F' (nivel 1 y 2), y
     * vigencia [effectivestartdate, effectiveenddate] del nivel 1 solapada con
     * el rango CURRENT del Prebook [currentStart, currentEnd] (no el historical
     * — cubre ~1 año hacia atrás; el nivel 2 no se filtra por fecha, igual que
     * en BOM Explosion). Ver toIsoDateStr/parseAccountDate.
     *
     * TOTAL UNITS — cascada MRP de 3 niveles (Recipe → Style → Raw Material):
     *   cada receta (BOM nivel 1) tiene su propia proyección del Prebook
     *   (customrecord_sgp_prebook_projection_rp.custrecord_sgp_product_code =
     *   producto terminado/receta, NO el material hardgoods). subTotalUnits de
     *   cada receta = projectedQty DE ESA receta × bomquantity de 2 niveles
     *   (comp.bomquantity × subcomp.bomquantity, o × 1 sin 2do nivel — el
     *   "total_componente" de BOM Explosion). TOTAL UNITS = suma de
     *   subTotalUnits entre todas las recetas donde aparece el material (una
     *   sola revisión por BOM: la de ID más alto entre las que calificaron).
     *   Si TOTAL UNITS = 0, el ítem se omite del reporte.
     * PO QTY / PO RECEIVED = de líneas de PO con custbody_sgp_report_id = este Prebook.
     * LOC1/LOC2 OH UNITS = inventario inicial del Prebook (customrecord_bc_prebookbeginninginvline,
     *   filtrado por customrecord_bc_preebookbeginninginv.custrecordprebook). LOC1 desde
     *   custrecord_bc_prebbokbegninvq, LOC2 desde custrecord_bc_prebbokbegninvq_lc2 (campos
     *   independientes en la misma línea).
     * "+ -" = LOC1 OH UNITS + PO QTY - TOTAL UNITS.
     * CAT = custitem_sgp_category.custrecord_sgp_printing_prefix.
     * FOB COST / LANDED COST redondeados a 4 decimales.
     * BOM/BomRevision (nivel 1) con '*' en el name quedan excluidos (fase 2).
     *
     * @param {string} prebookId
     * @param {string} [currentStart] - custrecord_sgp_pb_current_start_date
     * @param {string} [currentEnd]   - custrecord_sgp_pb_currency_end_date
     * @returns {Array<Object>}
     */
    const loadHardgoodsBomList = (prebookId, currentStart, currentEnd) => {
        const rows = [];
        let phase = 'init';

        try {
            // ── 1. Ítems hardgoods ────────────────────────────────────────
            phase = '1-hardgoods items';
            const hardgoodsItems = runSuiteQLAll(`
                SELECT
                    itm.id                                     AS item_id,
                    itm.itemid                                 AS item_name,
                    itm.itemtype                               AS item_type,
                    itm.displayname                            AS description,
                    itm.custitem_sgp_last_purchase_price       AS fob_cost,
                    itm.custitem_bc_lastpurchasepricewithoutla AS landed_cost,
                    catprefix.custrecord_sgp_printing_prefix   AS category_code,
                    catprefix.custrecord_sgp_categoty_printing_seq AS printing_seq,
                    cat.name                                   AS category_name
                FROM
                    item itm
                INNER JOIN
                    customrecord_cseg_sgp_prod_cat cat ON cat.id = itm.custitem_cseg_sgp_prod_cat
                LEFT JOIN
                    customrecord_sgp_category catprefix ON catprefix.id = itm.custitem_sgp_category
                WHERE
                    LOWER(cat.name) = 'hardgoods'
                    AND itm.isinactive = 'F'
                    AND cat.isinactive = 'F'
                ORDER BY
                    itm.id ASC                                 -- OBLIGATORIO para usar FETCH FIRST
                FETCH FIRST 8000 ROWS ONLY
            `);

            if (!hardgoodsItems.length) {
                log.audit('HARDGOODS.loadHardgoodsBomList', 'Sin ítems hardgoods → reporte vacío.');
                return rows;
            }
            log.audit('HARDGOODS.loadHardgoodsBomList', `Ítems hardgoods: ${hardgoodsItems.length}`);

            const hardgoodsItemIds = hardgoodsItems.map((it) => String(it.item_id));

            // ── 2. Explosión de 2 niveles (igual que pa_sl_bom_explosion_ui.js) ──
            //      SELECT DISTINCT: mismo resguardo que usa pa_sl_bom_explosion_ui.js
            //      contra filas duplicadas por fan-out de itemAssemblyItemBom (un BOM
            //      puede estar referenciado por más de un ítem ensamblado).
            //      Nivel 1: bom → bomRevisionBomMap → bomRevision → bomRevisionComponentMember.
            //      Nivel 2 (solo si comp.itemsource es WORK_ORDER/PHANTOM): se repite
            //      la cadena partiendo de comp.item como "assembly" (sub_iaib/sub_bom/
            //      sub_map/sub_bomRev/subcomp) para llegar al material real.
            //      item_id final = subcomp.item si hay 2do nivel, si no comp.item.
            //      bom_quantity = comp.bomquantity × subcomp.bomquantity (× 1 si no
            //      hay 2do nivel) = "total_componente" de BOM Explosion.
            //      Filtrado ya en SQL: activos + rango CURRENT (solo nivel 1) +
            //      BOM/BomRevision nivel 1 con '*' excluidos + material final
            //      dentro de hardgoodsItemIds + WORK_ORDER/PHANTOM sin sub-BOM
            //      se descarta (igual que BOM Explosion).
            phase = '2-explosion 2 niveles + fechas + inactivos';
            const revisionDataByItem = {};   // itemId → { revisionId: bomquantity (sumado) }
            const bomIdByRevision = {};      // revisionId → bomId (siempre nivel 1)
            const bomIdSet = {};             // bomId → true
            const assemblyItemByBom = {};    // bomId → item_id del producto terminado (nivel 1, iaib.assembly)
            const currentStartIso = toIsoDateStr(parseAccountDate(currentStart));
            const currentEndIso = toIsoDateStr(parseAccountDate(currentEnd));
            const dateConds = [];
            const dateParams = [];
            if (currentEndIso) {
                dateConds.push("(br.effectivestartdate IS NULL OR br.effectivestartdate <= TO_DATE(?, 'YYYY-MM-DD'))");
                dateParams.push(currentEndIso);
            }
            if (currentStartIso) {
                dateConds.push("(br.effectiveenddate IS NULL OR br.effectiveenddate >= TO_DATE(?, 'YYYY-MM-DD'))");
                dateParams.push(currentStartIso);
            }
            const dateWhereSql = dateConds.length ? ' AND ' + dateConds.join(' AND ') : '';
            // Diagnóstico: si currentStart/currentEnd llegan vacíos del Prebook, o si
            // ambos parsean a null, dateWhereSql queda '' y NO se filtra por fecha —
            // cualquier BomRevision con effectivestartdate/enddate NULL en ambos
            // extremos tampoco se filtra nunca (la condición "IS NULL OR ..." la deja
            // pasar siempre). Esto es lo primero a revisar si aparecen demasiadas
            // recetas para un mismo ítem.
            log.audit('HARDGOODS.loadHardgoodsBomList',
                `Fechas CURRENT del Prebook: raw=[${currentStart} - ${currentEnd}] → ISO=[${currentStartIso} - ${currentEndIso}] → ` +
                (dateWhereSql ? 'filtro SQL aplicado' : 'SIN FILTRO DE FECHA (fechas vacías o no parseables) — trae TODAS las revisiones activas'));
            let totalComponentRows = 0;
            chunkIds(hardgoodsItemIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT DISTINCT
                        b.id           AS bom_id,
                        br.id          AS revision_id,
                        iaib.assembly  AS assembly_item_id,
                        CASE WHEN UPPER(comp.itemsource) IN ('WORK_ORDER', 'PHANTOM')
                             THEN subcomp.item ELSE comp.item END AS item_id,
                        (NVL(comp.bomquantity, 0) * NVL(subcomp.bomquantity, 1)) AS bom_quantity
                    FROM bom b
                    INNER JOIN itemAssemblyItemBom iaib ON iaib.billofmaterials = b.id
                    INNER JOIN bomRevisionBomMap map ON map.billofmaterials = b.id
                    INNER JOIN bomRevision br ON br.id = map.bomrevision AND NVL(br.isinactive, 'F') = 'F'
                    INNER JOIN bomRevisionComponentMember comp ON comp.bomrevision = br.id
                    LEFT JOIN itemAssemblyItemBom sub_iaib
                        ON sub_iaib.assembly = comp.item
                        AND UPPER(comp.itemsource) IN ('WORK_ORDER', 'PHANTOM')
                    LEFT JOIN bom sub_bom ON sub_bom.id = sub_iaib.billofmaterials
                    LEFT JOIN bomRevisionBomMap sub_map ON sub_map.billofmaterials = sub_bom.id
                    LEFT JOIN bomRevision sub_bomRev ON sub_bomRev.id = sub_map.bomrevision AND NVL(sub_bomRev.isinactive, 'F') = 'F'
                    LEFT JOIN bomRevisionComponentMember subcomp ON subcomp.bomrevision = sub_bomRev.id
                    WHERE NVL(b.isinactive, 'F') = 'F'
                      AND (b.name IS NULL OR b.name NOT LIKE '%*%')
                      AND (br.name IS NULL OR br.name NOT LIKE '%*%')
                      AND (
                            (UPPER(comp.itemsource) IN ('WORK_ORDER', 'PHANTOM') AND subcomp.item IS NOT NULL)
                            OR
                            (UPPER(comp.itemsource) NOT IN ('WORK_ORDER', 'PHANTOM'))
                          )
                      AND (
                            (UPPER(comp.itemsource) IN ('WORK_ORDER', 'PHANTOM') AND subcomp.item IN (${inList}))
                            OR
                            (UPPER(comp.itemsource) NOT IN ('WORK_ORDER', 'PHANTOM') AND comp.item IN (${inList}))
                          )
                      ${dateWhereSql}
                    ORDER BY
                        b.id ASC
                `, dateParams).forEach((r) => {
                    totalComponentRows++;
                    const itemId = String(r.item_id);
                    const revId = String(r.revision_id);
                    if (!revisionDataByItem[itemId]) revisionDataByItem[itemId] = {};
                    // Suma (no sobrescribe): el mismo ítem puede llegar por más de
                    // una línea/ruta dentro de la misma revisión (directo + phantom).
                    revisionDataByItem[itemId][revId] =
                        (revisionDataByItem[itemId][revId] || 0) + (Number(r.bom_quantity) || 0);
                    bomIdByRevision[revId] = String(r.bom_id);
                    bomIdSet[String(r.bom_id)] = true;
                    // Se asume 1 producto terminado por BOM (relación esperada); si hay
                    // más de uno, gana el último visto.
                    if (!isEmptyValue(r.assembly_item_id)) {
                        assemblyItemByBom[String(r.bom_id)] = String(r.assembly_item_id);
                    }
                });
            });
            const bomIds = Object.keys(bomIdSet);
            log.audit('HARDGOODS.loadHardgoodsBomList',
                `Explosión 2 niveles, ya filtrada en SQL (activos + rango CURRENT [${currentStart} - ${currentEnd}]): ${totalComponentRows} líneas, ${bomIds.length} BOMs`);

            // ── 3. Inventario inicial del Prebook (LOC1/LOC2 OH UNITS) ─────
            //      LOC1 y LOC2 son campos independientes en la misma línea
            //      (custrecord_bc_prebbokbegninvq / custrecord_bc_prebbokbegninvq_lc2).
            //      Línea sin cantidad = 0.
            phase = '3-inventario inicial (LOC1/LOC2)';
            const invByItem = {};   // itemId → { loc1, loc2 }
            chunkIds(hardgoodsItemIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        ln.custrecord_bc_prebookbeginv_item AS item_id,
                        SUM(ln.custrecord_bc_prebbokbegninvq) AS quantity_loc1,
                        SUM(ln.custrecord_bc_prebbokbegninvq_lc2) AS quantity_loc2
                    FROM customrecord_bc_prebookbeginninginvline ln
                    INNER JOIN customrecord_bc_preebookbeginninginv bg
                        ON bg.id = ln.custrecord_bc_prebookbinv2
                    WHERE ln.isinactive = 'F'
                      AND bg.custrecordprebook = ?
                      AND ln.custrecord_bc_prebookbeginv_item IN (${inList})
                    GROUP BY ln.custrecord_bc_prebookbeginv_item
                `, [prebookId]).forEach((r) => {
                    invByItem[String(r.item_id)] = {
                        loc1: Number(r.quantity_loc1) || 0,
                        loc2: Number(r.quantity_loc2) || 0
                    };
                });
            });

            // ── 4. Metadata de las Bill of Materials padre ────────────────
            //      Customer solo si está activo (join condicionado); si está
            //      inactivo, la receta se muestra igual sin nombre/código.
            //      customer_name (Altname): si el customer tiene marcado
            //      custentity_sgp_consolidateprebook Y TIENE parent, se toma el
            //      Altname del parent (jerarquía); si el check está marcado pero
            //      NO tiene parent, o si no está marcado, se usa el Altname del
            //      mismo customer (fallback vía parentcust.altname IS NOT NULL).
            //      CODE / DESCRIPTION: recipe_code siempre es b.name (BOM name).
            //      La descripción sale de customrecord_sgp_recipe_product_mgt,
            //      matcheado contra b.name comparando solo la parte ANTES del
            //      paréntesis (algunos name traen "(xx)" y otros no, pero esa
            //      parte siempre es igual) — cubre match exacto y con sufijo
            //      en cualquiera de los dos lados. Sin coincidencia,
            //      recipe_description queda vacío y el front solo muestra el
            //      nombre del BOM (mismo comportamiento ya existente para "sin
            //      descripción").
            phase = '4-bom meta';
            const bomMeta = {};   // bomId → { recipe_code, recipe_description, customer_code, customer_name }
            chunkIds(bomIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        b.id                                AS bom_id,
                        b.name                              AS recipe_code,
                        prm.custrecord_sgp_prm_description   AS recipe_description,
                        cust.entityid                       AS customer_code,
                        CASE WHEN cust.custentity_sgp_consolidateprebook = 'T'
                              AND parentcust.altname IS NOT NULL
                             THEN parentcust.altname
                             ELSE cust.altname
                        END                                  AS customer_name
                    FROM Bom b
                    LEFT JOIN Customer cust ON cust.id = b.custrecord_sgp_bom_customer AND cust.isinactive = 'F'
                    LEFT JOIN Customer parentcust ON parentcust.id = cust.parent
                    LEFT JOIN customrecord_sgp_recipe_product_mgt prm
                        ON TRIM(CASE WHEN INSTR(prm.name, '(') > 0
                                     THEN SUBSTR(prm.name, 1, INSTR(prm.name, '(') - 1)
                                     ELSE prm.name END)
                         = TRIM(CASE WHEN INSTR(b.name, '(') > 0
                                     THEN SUBSTR(b.name, 1, INSTR(b.name, '(') - 1)
                                     ELSE b.name END)
                    WHERE b.id IN (${inList})
                      AND b.isinactive = 'F'
                    ORDER BY
                        b.id ASC                                 -- OBLIGATORIO para usar FETCH FIRST
                    FETCH FIRST 4000 ROWS ONLY
                `).forEach((r) => {
                    bomMeta[String(r.bom_id)] = {
                        recipe_code: r.recipe_code || '',
                        recipe_description: r.recipe_description || '',
                        customer_code: r.customer_code || '',
                        customer_name: r.customer_name || ''
                    };
                });
            });

            // ── 5. Proyecciones del Prebook por PRODUCTO TERMINADO (nivel 1) ──
            //      custrecord_sgp_product_code = el producto terminado/receta
            //      (assembly_item_id de la fase 2), NO el material hardgoods.
            //      Las PreBook Units viven en el producto terminado y bajan en
            //      cascada multiplicando por el bomQuantity de 2 niveles (fase 2)
            //      — igual que el diagrama de MRP (Recipe → Style → Raw Material).
            phase = '5-proyecciones prebook (por producto terminado)';
            const projectionQtyByAssembly = {};
            const assemblyIds = Array.from(new Set(Object.keys(assemblyItemByBom).map((bomId) => assemblyItemByBom[bomId])));
            chunkIds(assemblyIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        pj.custrecord_sgp_product_code AS item_id,
                        SUM(pj.custrecord_sgp_prebook_qty) AS total_qty
                    FROM customrecord_sgp_prebook_projection_rp pj
                    WHERE pj.custrecord_sgp_prebook_id_detail = ?
                      AND pj.isinactive = 'F'
                      AND pj.custrecord_sgp_product_code IN (${inList})
                    GROUP BY pj.custrecord_sgp_product_code
                `, [prebookId]).forEach((r) => {
                    projectionQtyByAssembly[String(r.item_id)] = Number(r.total_qty) || 0;
                });
            });

            // ── 6. PO QTY / PO RECEIVED por ítem hardgoods ────────────────
            phase = '6-po qty y recibido';
            const poByItem = {};
            chunkIds(hardgoodsItemIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        tl.item AS item_id,
                        SUM(ABS(tl.quantity)) AS po_qty,
                        SUM(ABS(tl.quantityshiprecv)) AS po_received
                    FROM
                        transaction t
                    INNER JOIN
                        transactionline tl ON tl.transaction = t.id
                    WHERE
                        t.type = 'PurchOrd'
                        AND t.custbody_sgp_report_id = ?
                        AND tl.mainline = 'F'
                        AND tl.item IN (${inList})
                    GROUP BY
                        tl.item
                `, [prebookId]).forEach((r) => {
                    poByItem[String(r.item_id)] = {
                        po_qty: Number(r.po_qty) || 0,
                        po_received: Number(r.po_received) || 0
                    };
                });
            });

            // ── 7. Armado de filas: dedup por BOM, revisión de mayor ID ───
            phase = '7-armado filas';
            hardgoodsItems.forEach((it) => {
                const itemId = String(it.item_id);
                const revData = revisionDataByItem[itemId] || {};
                const revIds = Object.keys(revData);

                const bestRevByBom = {};   // bomId → { revId, bomquantity }
                revIds.forEach((revId) => {
                    const bomId = bomIdByRevision[revId];
                    if (!bomId) return;
                    const current = bestRevByBom[bomId];
                    if (!current || Number(revId) > Number(current.revId)) {
                        bestRevByBom[bomId] = { revId: revId, bomquantity: revData[revId] };
                    }
                });

                // Diagnóstico: un ítem con demasiadas recetas distintas suele indicar
                // que el filtro de fecha CURRENT no está restringiendo nada (ver log
                // de fase 2) — cada BomRevision con effective dates NULL en ambos
                // extremos "siempre califica" y se acumula como receta aparte.
                const RECIPE_COUNT_ALERT_THRESHOLD = 50;
                const bomIdCount = Object.keys(bestRevByBom).length;
                if (bomIdCount > RECIPE_COUNT_ALERT_THRESHOLD) {
                    log.audit('HARDGOODS.loadHardgoodsBomList',
                        `Ítem con demasiadas recetas: ${it.item_name || itemId} (id=${itemId}) → ${bomIdCount} BOMs distintos. Revisar si sus BomRevision tienen effectivestartdate/enddate en NULL (bypass del filtro CURRENT).`);
                }

                // MRP en cascada (ver diagrama Recipe → Style → Raw Material):
                // cada receta (BOM) tiene SU PROPIA proyección (la del producto
                // terminado que la usa, fase 5), no una proyección global del
                // material. subTotalUnits de cada receta = projectedQty de ESA
                // receta × bomQuantity de 2 niveles (comp×subcomp, fase 2).
                // TOTAL UNITS = suma de subTotalUnits entre todas las recetas
                // (mismo "agregar por componente, sumar entre styles" del diagrama,
                // extendido a que el material puede estar en varias recetas).
                const recipes = Object.keys(bestRevByBom).map((bomId) => {
                    const meta = bomMeta[bomId] || {};
                    const bomQuantity = bestRevByBom[bomId].bomquantity || 0;
                    const assemblyItemId = assemblyItemByBom[bomId];
                    // Sin proyección del producto terminado de esta receta → 0.
                    const recipeProjectedQty = projectionQtyByAssembly[assemblyItemId] || 0;
                    return {
                        recipeId: bomId,
                        // Código a mostrar (CODE DESCRIPTION): sin el sufijo "(xx)" que
                        // algunos b.name traen (ver stripRecipeCodeSuffix). Único punto
                        // donde se arma `recipes`, así queda limpio para preview/Excel/PDF.
                        recipe_code: stripRecipeCodeSuffix(meta.recipe_code),
                        recipedescription: meta.recipe_description || '',
                        customer_code: meta.customer_code || '',
                        customer_name: meta.customer_name || '',
                        // Total units de ESTA receta: participa en TOTAL UNITS (suma abajo).
                        subTotalUnits: recipeProjectedQty * bomQuantity
                    };
                }).sort((a, b) => String(a.recipe_code).localeCompare(String(b.recipe_code)));

                const totalUnits = recipes.reduce((sum, r) => sum + (r.subTotalUnits || 0), 0);

                // TOTAL UNITS = 0 (sin proyección real en ninguna receta) → el ítem no se muestra.
                if (!totalUnits) return;

                const po = poByItem[itemId] || { po_qty: 0, po_received: 0 };
                const inv = invByItem[itemId] || { loc1: 0, loc2: 0 };
                const onHandQty = inv.loc1;
                const plusMinus = onHandQty + po.po_qty - totalUnits; // "+ -": LOC1 + PO QTY - TOTAL UNITS

                rows.push({
                    componentItemId: itemId,
                    cat: it.category_code || it.category_name || '',
                    // Orden del reporte: custrecord_sgp_categoty_printing_seq (null → al final).
                    categorySeq: isEmptyValue(it.printing_seq) ? null : Number(it.printing_seq),
                    product: it.item_name || '',
                    description: it.description || '',
                    type: mapItemType(it.item_type),
                    // Máximo 4 decimales.
                    fob_cost: Number((Number(it.fob_cost) || 0).toFixed(4)),
                    landed_cost: Number((Number(it.landed_cost) || 0).toFixed(4)),
                    // LOC1 y LOC2 desde campos independientes (fase 3).
                    loc_1_oh: inv.loc1,
                    loc_2_oh: inv.loc2,
                    plus_minus: plusMinus,
                    po_qty: po.po_qty,
                    po_received: po.po_received,
                    totalUnits: totalUnits,
                    recipes: recipes,
                    num_recipes: recipes.length
                });
            });

            // Orden del reporte: Category Sequence (custrecord_sgp_categoty_printing_seq,
            // ascendente, sin valor → al final) y luego Product Description ascendente.
            rows.sort((a, b) => {
                const seqA = a.categorySeq == null ? Number.MAX_SAFE_INTEGER : a.categorySeq;
                const seqB = b.categorySeq == null ? Number.MAX_SAFE_INTEGER : b.categorySeq;
                if (seqA !== seqB) return seqA - seqB;
                return String(a.description || '').localeCompare(String(b.description || ''));
            });

            log.audit('HARDGOODS.loadHardgoodsBomList', `Filas generadas: ${rows.length}`);

        } catch (e) {
            log.error('HARDGOODS.loadHardgoodsBomList',
                `Fallo en fase [${phase}]: ${e.message} | ${e.stack}`);
        }

        return rows;
    };

    // =========================================================================
    // MISC HELPERS
    // =========================================================================

    /** Formatea con separador de miles (1234567 -> "1,234,567"; con decimales,
     *  redondea a 2). Solo para presentación (TOTAL UNITS, "+ -", PO QTY,
     *  PO RECEIVED); el valor numérico crudo no se toca en ningún cálculo. */
    const fmtNumber = (v) => {
        let n = Number(v);
        if (!isFinite(n)) n = 0;
        const neg = n < 0;
        n = Math.abs(n);
        const fixed = Number.isInteger(n) ? String(n) : n.toFixed(2);
        const [intPart, decPart] = fixed.split('.');
        const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (neg ? '-' : '') + withCommas + (decPart ? '.' + decPart : '');
    };

    /** Quita el sufijo "(xx)" (y el espacio previo) de un recipe_code (b.name) para
     *  mostrarlo limpio en CODE DESCRIPTION. Solo afecta el display; el match contra
     *  customrecord_sgp_recipe_product_mgt ya se hace en el SQL de fase 4 (SUBSTR). */
    const stripRecipeCodeSuffix = (code) => {
        const s = String(code || '');
        const idx = s.indexOf('(');
        return (idx > -1 ? s.substring(0, idx) : s).trim();
    };

    /** Mapea el type interno de NetSuite al texto legible del reporte. */
    const mapItemType = (nsType) => {
        const MAP = {
            InvtPart: 'Inventory',
            Assembly: 'RAW',
            NonInvtPart: 'Non-Inventory',
            OthCharge: 'Other Charge',
            Service: 'Service',
            Kit: 'Kit'
        };
        return MAP[nsType] || nsType || '';
    };

    /** Detecta valores "vacíos", incluyendo ScriptNullObjectAdapter (Java) que NetSuite
     *  devuelve en vez de null/undefined para campos vacíos (frecuente en fechas). */
    const isEmptyValue = (v) => {
        if (v === null || v === undefined || v === '') return true;
        if (typeof v === 'object') {
            return /NullObjectAdapter/i.test(String(v));
        }
        return false;
    };

    /** Convierte a string vacío cualquier valor "vacío" (ver isEmptyValue). */
    const safeStr = (v) => (isEmptyValue(v) ? '' : String(v));

    /** Parsea fecha de cuenta (ISO o MM/DD/YYYY) a Date. Null si no se puede interpretar. */
    const parseAccountDate = (v) => {
        const s = safeStr(v);
        if (!s) return null;
        let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) {
            const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
            return isNaN(d.getTime()) ? null : d;
        }
        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) {
            const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
            return isNaN(d.getTime()) ? null : d;
        }
        const fallback = new Date(s);
        return isNaN(fallback.getTime()) ? null : fallback;
    };

    /** Formatea un Date como 'YYYY-MM-DD' para bind params de TO_DATE() en SuiteQL. */
    const toIsoDateStr = (d) => {
        if (!d) return null;
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    /** Timestamp compacto para el nombre del archivo: YYYYMMDD_HHmm. */
    const nowStamp = () => {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    };

    // =========================================================================
    return {
        getMetadata,
        getFilterDefinitions,
        validateFilters,
        generate,
        getPreviewData
    };
});

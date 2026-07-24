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

        // Encabezados ORIGINALES — no cambiar este set de columnas.
        const headers = ['CAT', 'PRODUCT', 'DESCRIPTION', 'TYPE', '# RECIPES', 'CODE DESCRIPTION', 'CUST', 'CUSTOMER NAME',
            'TOTAL UNITS', '+ -', 'FOB COST', 'LANDED COST', 'LOC1 OH UNITS', 'LOC2 OH UNITS',
            'PO QTY', 'PO RECEIVED', 'PREP PRODUCTION'];

        const baseName = `HG_BuyingReport_${String(preebookData.name || prebookId).replace(/\s+/g, '_')}_${nowStamp()}`;

        if (format === 'PDF') {
            const reportPdf = crearPDF(headers, bomRows, `${baseName}.pdf`, prebookId, preebookData);
            return { fileObj: reportPdf, contentType: 'PDF', filename: `${baseName}.pdf` };
        }

        const reportExcel = crearExcel(headers, bomRows, `${baseName}.xlsx`, prebookId, preebookData);
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

        const headers = ['CAT', 'PRODUCT', 'DESCRIPTION', 'TYPE', '# RECIPES', 'CODE DESCRIPTION', 'CUST', 'CUSTOMER NAME',
            'TOTAL UNITS', '+ -', 'FOB COST', 'LANDED COST', 'LOC1 OH UNITS', 'LOC2 OH UNITS',
            'PO QTY', 'PO RECEIVED', 'PREP PRODUCTION'];

        return {
            title: 'Hardgoods Buying Report',
            prebookName: preebookData.name || prebookId,
            metaLines: [
                `WO720 Report # ${prebookId} — WHERE USED REPORTING`,
                `History: ${preebookData.custrecord_sgp_pb_historical_start_date} - ${preebookData.custrecord_sgp_pb_historical_end_date}`,
                `Current: ${preebookData.custrecord_sgp_pb_historical_start_date} - ${preebookData.custrecord_sgp_pb_historical_end_date}`
            ],
            headers: headers,
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
                    first.recipe_code + (first.recipedescription ? ' - ' + first.recipedescription : ''),
                    safeStr(first.customer_code),
                    safeStr(first.customer_name),
                    String(row.totalUnits || 0),
                    String(row.plus_minus != null ? row.plus_minus : 0),   // "+ -": LOC1 OH menos PO QTY
                    String(row.fob_cost || 0),
                    String(row.landed_cost || 0),
                    String(row.loc_1_oh || 0),
                    String(row.loc_2_oh || 0),
                    String(row.po_received || 0),          // bajo "PO QTY" (réplica invertida, igual que crearExcel)
                    String(row.po_qty || 0),               // bajo "PO RECEIVED" (réplica invertida, igual que crearExcel)
                    ''                                      // PREP PRODUCTION
                );
            } else {
                cells.push('', '', '', '', '', '', '', '', '', '', '', '');
            }

            const toSubRow = (recipe) => ({
                cells: [
                    '', '', '', '', '',
                    recipe.recipe_code + (recipe.recipedescription ? ' - ' + recipe.recipedescription : ''),
                    safeStr(recipe.customer_code),
                    safeStr(recipe.customer_name),
                    '', '', '', '', '', '', '', '', ''
                ],
                // Solo display (toggle "See all sub total units"): total units de esta receta.
                subTotalUnits: recipe.subTotalUnits != null ? recipe.subTotalUnits : ''
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
                subTotalUnits: first && first.subTotalUnits != null ? first.subTotalUnits : ''
            };
        });
    };

    // =========================================================================
    // EXCEL — mismo formato/estructura original (no modificar sin necesidad)
    // =========================================================================

    // Límite real de file.create en NetSuite es 10 MB; dejamos margen.
    const MAX_XLS_BYTES = 9.8 * 1024 * 1024;

    const crearExcel = (headers, rows, fileName, prebookId, preebookData) => {
        try {

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
                '<Column ss:Width="22.799999999999997"/>\n' +
                '<Column ss:Width="49.2"/>\n' +
                '<Column ss:AutoFitWidth="0" ss:Width="141.6"/>\n' +
                '<Column ss:Width="103.2"/>\n' +
                '<Column ss:Width="49.2"/>\n' +
                '<Column ss:Width="120.60000000000001"/>\n' +
                '<Column ss:Width="28.8"/>\n' +
                '<Column ss:Width="87"/>\n' +
                '<Column ss:Width="64.2"/>\n' +
                '<Column ss:Width="24"/>\n' +
                '<Column ss:Width="49.2"/>\n' +
                '<Column ss:Width="67.8"/>\n' +
                '<Column ss:Width="75" ss:Span="1"/>\n' +
                '<Column ss:Index="15" ss:Width="38.4"/>\n' +
                '<Column ss:Width="91.8"/>\n' +
                '<Row>\n' +
                '<Cell ss:Index="4" ss:StyleID="sPlain"><Data ss:Type="String">WO720 Report # ' + escapeXml(prebookId) + '</Data></Cell>\n' +
                '<Cell ss:Index="6" ss:StyleID="sPlain"><Data ss:Type="String">WHERE USED REPORTING</Data></Cell>\n' +
                '</Row>\n' +
                '<Row>\n' +
                '<Cell ss:Index="3" ss:StyleID="sPlain"><Data ss:Type="String">History: ' + escapeXml(preebookData.custrecord_sgp_pb_historical_start_date) + ' - ' + escapeXml(preebookData.custrecord_sgp_pb_historical_end_date) + '</Data></Cell>\n' +
                '</Row>\n' +
                '<Row>\n' +
                '<Cell ss:Index="3" ss:StyleID="sPlain"><Data ss:Type="String">Current: ' + escapeXml(preebookData.custrecord_sgp_pb_historical_start_date) + ' - ' + escapeXml(preebookData.custrecord_sgp_pb_historical_end_date) + '</Data></Cell>\n' +
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
                    xmlString += strCell(firstRecipe.recipe_code + (firstRecipe.recipedescription ? " - " : "") + firstRecipe.recipedescription);
                    xmlString += strCell(firstRecipe.customer_code);
                    xmlString += strCell(firstRecipe.customer_name);
                    xmlString += strCell(row.totalUnits);
                    xmlString += strCell(row.plus_minus);    // "+ -": LOC1 OH menos PO QTY
                    xmlString += strCell(row.fob_cost);
                    xmlString += strCell(row.landed_cost);
                    xmlString += strCell(row.loc_1_oh);
                    xmlString += strCell(row.loc_2_oh);
                    xmlString += strCell(row.po_received);   // bajo "PO QTY" (réplica invertida del Excel)
                    xmlString += strCell(row.po_qty);        // bajo "PO RECEIVED" (réplica invertida del Excel)
                    xmlString += EMPTY;                      // PREP PRODUCTION
                    xmlString += '</Row>';
                    // Máximo 5 recetas mostradas (1 en la fila principal + hasta 4 sub-filas),
                    // aunque haya más — # RECIPES y TOTAL UNITS siguen reflejando el total real.
                    row.recipes.slice(0, 5).forEach((recipe, index) => {
                        if (index === 0) return; // ya impresa en la fila principal
                        xmlString += '<Row>';
                        xmlString += EMPTY + EMPTY + EMPTY + EMPTY + EMPTY;
                        xmlString += strCell(recipe.recipe_code + (recipe.recipedescription ? " - " : "") + recipe.recipedescription);
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
    const crearPDF = (headers, rows, fileName, prebookId, preebookData) => {
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
                        generatedAt: nowStamp(),
                        totalRows: rows.length
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
     * TODAS las Bill of Materials en las que aparece como COMPONENTE
     * (where-used vía BomRevisionComponent → bomRevision → Bom), agrupadas en
     * `row.recipes`.
     *
     * Filtros aplicados YA en el SQL de la fase 2 (no post-fetch en JS, para
     * traer menos filas): br/b.isinactive = 'F', y vigencia
     * [effectivestartdate, effectiveenddate] solapada con el rango CURRENT del
     * Prebook [currentStart, currentEnd] (no el historical — cubre ~1 año
     * hacia atrás). Ver toIsoDateStr/parseAccountDate.
     *
     * TOTAL UNITS = proyección del Prebook (customrecord_sgp_prebook_projection_rp,
     *   0 si no hay proyección) × bomquantity sumado entre todas las recetas donde
     *   el ítem es componente (una sola revisión por BOM: la de ID más alto entre
     *   las que calificaron). Si TOTAL UNITS = 0, el ítem se omite del reporte.
     * PO QTY / PO RECEIVED = de líneas de PO con custbody_sgp_report_id = este Prebook.
     * LOC1/LOC2 OH UNITS = inventario inicial del Prebook (customrecord_bc_prebookbeginninginvline,
     *   filtrado por customrecord_bc_preebookbeginninginv.custrecordprebook), misma cantidad en ambas.
     * "+ -" = LOC1 OH UNITS + PO QTY - TOTAL UNITS.
     * CAT = custitem_sgp_category.custrecord_sgp_printing_prefix.
     * FOB COST / LANDED COST redondeados a 4 decimales.
     * BOM/BomRevision con '*' en el name quedan excluidos (fase 2).
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

            // ── 2. Where-used, ya filtrado en SQL por activos + rango CURRENT ──
            //      (fechas via TO_DATE con bind params — ver toIsoDateStr).
            //      También excluye BOM/BomRevision cuyo name contenga '*'.
            phase = '2-where-used componentes + fechas + inactivos';
            const revisionDataByItem = {};   // itemId → { revisionId: bomquantity }
            const bomIdByRevision = {};      // revisionId → bomId
            const bomIdSet = {};             // bomId → true
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
            let totalComponentRows = 0;
            chunkIds(hardgoodsItemIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        brc.item              AS item_id,
                        brc.bomrevision       AS revision_id,
                        brc.bomquantity       AS bom_quantity,
                        br.billofmaterials    AS bom_id
                    FROM BomRevisionComponent brc
                    INNER JOIN bomRevision br ON br.id = brc.bomrevision
                    INNER JOIN Bom b ON b.id = br.billofmaterials
                    WHERE brc.item IN (${inList})
                      AND br.isinactive = 'F'
                      AND b.isinactive = 'F'
                      AND (b.name IS NULL OR b.name NOT LIKE '%*%')
                      AND (br.name IS NULL OR br.name NOT LIKE '%*%')
                      ${dateWhereSql}
                    ORDER BY
                        brc.item ASC                                 -- OBLIGATORIO para usar FETCH FIRST
                `, dateParams).forEach((r) => {
                    totalComponentRows++;
                    const itemId = String(r.item_id);
                    const revId = String(r.revision_id);
                    if (!revisionDataByItem[itemId]) revisionDataByItem[itemId] = {};
                    revisionDataByItem[itemId][revId] = Number(r.bom_quantity) || 0;
                    bomIdByRevision[revId] = String(r.bom_id);
                    bomIdSet[String(r.bom_id)] = true;
                });
            });
            const bomIds = Object.keys(bomIdSet);
            log.audit('HARDGOODS.loadHardgoodsBomList',
                `Componentes ya filtrados en SQL (activos + rango CURRENT [${currentStart} - ${currentEnd}]): ${totalComponentRows}`);

            // ── 3. Inventario inicial del Prebook (LOC1/LOC2 OH UNITS) ─────
            //      Misma cantidad para ambas columnas (no hay desglose por
            //      ubicación en el registro origen). Línea sin cantidad = 0.
            phase = '3-inventario inicial (LOC1/LOC2)';
            const invByItem = {};   // itemId → quantity
            chunkIds(hardgoodsItemIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        ln.custrecord_bc_prebookbeginv_item AS item_id,
                        SUM(ln.custrecord_bc_prebbokbegninvq) AS quantity
                    FROM customrecord_bc_prebookbeginninginvline ln
                    INNER JOIN customrecord_bc_preebookbeginninginv bg
                        ON bg.id = ln.custrecord_bc_prebookbinv2
                    WHERE ln.isinactive = 'F'
                      AND bg.custrecordprebook = ?
                      AND ln.custrecord_bc_prebookbeginv_item IN (${inList})
                    GROUP BY ln.custrecord_bc_prebookbeginv_item
                `, [prebookId]).forEach((r) => {
                    invByItem[String(r.item_id)] = Number(r.quantity) || 0;
                });
            });

            // ── 4. Metadata de las Bill of Materials padre ────────────────
            //      Customer solo si está activo (join condicionado); si está
            //      inactivo, la receta se muestra igual sin nombre/código.
            //      CODE / DESCRIPTION: recipe_code siempre es b.name (BOM name).
            //      La descripción sale de customrecord_sgp_recipe_product_mgt
            //      cuyo name coincide exactamente con b.name; sin coincidencia,
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
                        cust.altname                        AS customer_name
                    FROM Bom b
                    LEFT JOIN Customer cust ON cust.id = b.custrecord_sgp_bom_customer AND cust.isinactive = 'F'
                    LEFT JOIN customrecord_sgp_recipe_product_mgt prm ON prm.name = b.name
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

            // ── 5. Proyecciones del Prebook por ítem hardgoods ────────────
            phase = '5-proyecciones prebook';
            const projectionQtyByItem = {};
            chunkIds(hardgoodsItemIds, 1000).forEach((inList) => {
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
                    projectionQtyByItem[String(r.item_id)] = Number(r.total_qty) || 0;
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

                // Sin proyección del Prebook para este ítem → 0 (antes caía en 1 por error).
                const projectedQty = projectionQtyByItem[itemId] || 0;

                const recipes = Object.keys(bestRevByBom).map((bomId) => {
                    const meta = bomMeta[bomId] || {};
                    const bomQuantity = bestRevByBom[bomId].bomquantity || 0;
                    return {
                        recipeId: bomId,
                        recipe_code: meta.recipe_code || '',
                        recipedescription: meta.recipe_description || '',
                        customer_code: meta.customer_code || '',
                        customer_name: meta.customer_name || '',
                        // Solo display (toggle "See all sub total units"): total units de ESTA
                        // receta individual. No participa en el cálculo de TOTAL UNITS.
                        subTotalUnits: projectedQty * bomQuantity
                    };
                }).sort((a, b) => String(a.recipe_code).localeCompare(String(b.recipe_code)));

                const totalBomQty = Object.keys(bestRevByBom)
                    .reduce((sum, bomId) => sum + (bestRevByBom[bomId].bomquantity || 0), 0);
                const totalUnits = projectedQty * totalBomQty;

                // TOTAL UNITS = 0 (sin proyección real) → el ítem no se muestra en el reporte.
                if (!totalUnits) return;

                const po = poByItem[itemId] || { po_qty: 0, po_received: 0 };
                const onHandQty = invByItem[itemId] || 0;
                const plusMinus = onHandQty + po.po_qty - totalUnits; // "+ -": LOC1 + PO QTY - TOTAL UNITS

                rows.push({
                    componentItemId: itemId,
                    cat: it.category_code || it.category_name || '',
                    product: it.item_name || '',
                    description: it.description || '',
                    type: mapItemType(it.item_type),
                    // Máximo 4 decimales.
                    fob_cost: Number((Number(it.fob_cost) || 0).toFixed(4)),
                    landed_cost: Number((Number(it.landed_cost) || 0).toFixed(4)),
                    // Mismo valor en ambas: el inventario inicial del Prebook no distingue ubicación.
                    loc_1_oh: onHandQty,
                    loc_2_oh: onHandQty,
                    plus_minus: plusMinus,
                    po_qty: po.po_qty,
                    po_received: po.po_received,
                    totalUnits: totalUnits,
                    recipes: recipes,
                    num_recipes: recipes.length
                });
            });

            // Más recetas primero
            rows.sort((a, b) => {
                if (a.num_recipes > b.num_recipes) return -1;
                if (a.num_recipes < b.num_recipes) return 1;
                return String(a.product).localeCompare(String(b.product));
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

    /** Mapea el type interno de NetSuite al texto legible del reporte. */
    const mapItemType = (nsType) => {
        const MAP = {
            InvtPart: 'Inventory',
            Assembly: 'Assembly',
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

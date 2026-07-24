/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * R2 — ALL RAW MATERIALS PROJECTION REPORT (GREENS)
 * Hermano de prbk_lib_r1_hardgoods_buying_report.js: misma arquitectura, pero
 * solo artículos GREENS, columnas distintas, y loadBomComponents agrega por
 * item "para todas las recetas" (sin sub-filas).
 *
 * Columnas (orden del reporte impreso):
 *   CAT | PRODUCT CODE | PRODUCT DESCRIPTION | STEMS NEEDED | BUNCHES NEEDED |
 *   CASES NEEDED | QUANTY ONHAND | PO RECVD | IN BOUND | CASES SHORT | CASES OVER
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

    const LOC1_ID = 1;          // Internal ID real de LOC1
    const LOC1_LABEL = 'LOC1';  // nombre visible de LOC1

    // Nombre del .ftl en el File Cabinet; su ID se resuelve en runtime (findTemplateFileId).
    const GR_TEMPLATE_FILENAME = 'prbk_custtmpl_r2_greens_projection_report.ftl';

    // Límite real de file.create en NetSuite es 10 MB; dejamos margen.
    const MAX_XLS_BYTES = 9.8 * 1024 * 1024;

    // =========================================================================
    // 1. METADATA
    // =========================================================================

    const getMetadata = () => ({
        id: 'GREENS_PROJECTION',
        name: 'All Raw Materials Projection - Greens',
        description: 'Raw material (greens) projection per item: stems/bunches/cases needed, ' +
            'beginning inventory, POs received, inbound, and case short/over.',
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
            helpText: 'Select the Prebook to generate the report from.'
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
    // 3. VALIDACIÓN
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
    // 4. GENERATE
    // =========================================================================

    /**
     * @param {Object} filterValues - .prebook, .output_format
     * @returns {Object} { fileObj, contentType, filename }
     */
    const generate = (filterValues) => {
        const prebookId = String(filterValues.prebook);
        const format = String(filterValues.output_format || 'EXCEL').toUpperCase();
        log.audit('GREENS.generate', `prebook=${prebookId}  format=${format}`);

        // Rango CURRENT filtra las BomRevision vigentes; historical solo para "History: ...".
        const preebookData = search.lookupFields({
            type: 'customrecord_sgp_prebook',
            id: prebookId,
            columns: [
                'custrecord_sgp_pb_historical_start_date',
                'custrecord_sgp_pb_historical_end_date',
                'name',
                'custrecord_sgp_pb_current_start_date',
                'custrecord_sgp_pb_currency_end_date'
            ]
        });
        const historicalStart = safeStr(preebookData?.custrecord_sgp_pb_historical_start_date);
        const historicalEnd = safeStr(preebookData?.custrecord_sgp_pb_historical_end_date);
        const currentStart = safeStr(preebookData?.custrecord_sgp_pb_current_start_date);
        const currentEnd = safeStr(preebookData?.custrecord_sgp_pb_currency_end_date);
        log.audit('GREENS.generate',
            `Prebook fields: name="${safeStr(preebookData?.name)}" historical=[${historicalStart} - ${historicalEnd}] current=[${currentStart} - ${currentEnd}]`);

        const rows = loadBomComponents(prebookId, currentStart, currentEnd);
        log.audit('GREENS.rows', `count=${rows.length}`);

        const headers = ['CAT', 'PRODUCT CODE', 'PRODUCT DESCRIPTION', 'PACK PK/STM', 'STEMS NEEDED',
            'BUNCHES NEEDED', 'CASES NEEDED', 'QUANTITY ONHAND', 'UNIT PREP COMP', 'PO RECVD LOC1',
            'IN BOUND LOC1', 'CASES SHORT LOC1', 'CASES OVER LOC1'];
        const baseName = `Greens_Projection_${String(preebookData?.name).replace(/\s+/g, '_')}_${nowStamp()}`;

        if (format === 'PDF') {
            const reportPdf = crearPDF(headers, rows, `${baseName}.pdf`, prebookId, preebookData);
            return { fileObj: reportPdf, contentType: 'PDF', filename: `${baseName}.pdf` };
        }

        const reportExcel = crearExcel(headers, rows, `${baseName}.xlsx`, prebookId, preebookData);
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
        log.audit('GREENS.getPreviewData', `prebook=${prebookId}`);

        const preebookData = search.lookupFields({
            type: 'customrecord_sgp_prebook',
            id: prebookId,
            columns: [
                'custrecord_sgp_pb_historical_start_date',
                'custrecord_sgp_pb_historical_end_date',
                'name',
                'custrecord_sgp_pb_current_start_date',
                'custrecord_sgp_pb_currency_end_date'
            ]
        });
        const historicalStart = safeStr(preebookData?.custrecord_sgp_pb_historical_start_date);
        const historicalEnd = safeStr(preebookData?.custrecord_sgp_pb_historical_end_date);
        const currentStart = safeStr(preebookData?.custrecord_sgp_pb_current_start_date);
        const currentEnd = safeStr(preebookData?.custrecord_sgp_pb_currency_end_date);
        log.audit('GREENS.getPreviewData',
            `Prebook fields: name="${safeStr(preebookData?.name)}" historical=[${historicalStart} - ${historicalEnd}] current=[${currentStart} - ${currentEnd}]`);

        const rows = loadBomComponents(prebookId, currentStart, currentEnd);

        const headers = ['CAT', 'PRODUCT CODE', 'PRODUCT DESCRIPTION', 'PACK PK/STM', 'STEMS NEEDED',
            'BUNCHES NEEDED', 'CASES NEEDED', 'QUANTITY ONHAND', 'UNIT PREP COMP', 'PO RECVD LOC1',
            'IN BOUND LOC1', 'CASES SHORT LOC1', 'CASES OVER LOC1'];

        // Mismo orden de columnas que crearExcel (una fila por item, sin sub-filas).
        const flatRows = rows.map((r) => ([
            safeStr(r.cat), safeStr(r.productCode), safeStr(r.description), safeStr(r.pkstm),
            String(r.stemsNeeded || 0), String(r.bunchesNeeded || 0), String(r.casesNeeded || 0),
            String(r.qtyOnHand || 0), String(r.unitprepcomp || 0), String(r.poReceived || 0),
            String(r.inBound || 0),
            (r.casesShort === '' || r.casesShort == null ? '' : String(r.casesShort)),
            (r.casesOver === '' || r.casesOver == null ? '' : String(r.casesOver))
        ]));

        return {
            title: 'All Raw Materials Projection - Greens',
            prebookName: safeStr(preebookData?.name) || prebookId,
            metaLines: [
                `WO720.R # ${prebookId} — ALL RAW MATERIALS PROJECTION REPORT FOR ALL RECIPES`,
                `PREPARED FOR: ${safeStr(preebookData?.name)}`,
                `ALL SUB CATS - History: ${historicalStart} - ${historicalEnd}  RELATING TO Current: ${safeStr(preebookData?.custrecord_sgp_pb_current_start_date)}`
            ],
            headers: headers,
            rows: flatRows,
            rowCount: rows.length
        };
    };

    // =========================================================================
    // 5. EXCEL
    // =========================================================================

    const crearExcel = (headers, rows, fileName, prebookId, preebookData) => {
        try {
            // Escapan XML; celdas sin ss:StyleID heredan borde del estilo Default.
            const escapeXml = (v) => isEmptyValue(v) ? '' :
                String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const EMPTY = '<Cell/>';
            const strCell = (v) => `<Cell><Data ss:Type="String">${escapeXml(v)}</Data></Cell>`;

            const hist = `History: ${escapeXml(preebookData?.custrecord_sgp_pb_historical_start_date)} - ${escapeXml(preebookData?.custrecord_sgp_pb_historical_end_date)}`;
            // TODO: mostrar también el fin del rango CURRENT (custrecord_sgp_pb_currency_end_date) cuando se defina el layout.
            const curr = `Current: ${escapeXml(preebookData?.custrecord_sgp_pb_current_start_date)}`;

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
                '<Version>16.00</Version>\n' +
                '</DocumentProperties>\n' +
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
                '<Table ss:ExpandedColumnCount="' + (headers.length + 2) + '" ss:ExpandedRowCount="' + (rows.length + 100) + '" x:FullColumns="1"\n' +
                'x:FullRows="1" ss:DefaultRowHeight="14.4">\n' +
                '<Column ss:Width="35"/>\n' +     // CAT
                '<Column ss:Width="60"/>\n' +     // PRODUCT CODE
                '<Column ss:Width="160"/>\n' +    // PRODUCT DESCRIPTION
                '<Column ss:Width="60"/>\n' +     // STEMS NEEDED
                '<Column ss:Width="65"/>\n' +     // BUNCHES NEEDED
                '<Column ss:Width="60"/>\n' +     // CASES NEEDED
                '<Column ss:Width="65"/>\n' +     // QUANTY ONHAND
                '<Column ss:Width="55"/>\n' +     // PO RECVD
                '<Column ss:Width="55"/>\n' +     // IN BOUND
                '<Column ss:Width="60"/>\n' +     // CASES SHORT
                '<Column ss:Width="60"/>\n' +     // CASES OVER
                '<Row>\n' +
                '<Cell ss:StyleID="sPlain"><Data ss:Type="String">WO720.R   # ' + escapeXml(prebookId) + '   ALL RAW MATERIALS PROJECTION REPORT FOR ALL RECIPES</Data></Cell>\n' +
                '</Row>\n' +
                '<Row>\n' +
                // TODO: "PREPARED FOR" debería ser company/branch; por ahora usa el nombre del Prebook.
                '<Cell ss:StyleID="sPlain"><Data ss:Type="String">PREPARED FOR: ' + escapeXml(preebookData?.name) + '</Data></Cell>\n' +
                '</Row>\n' +
                '<Row>\n' +
                '<Cell ss:StyleID="sPlain"><Data ss:Type="String">ALL SUB CATS   - ' + escapeXml(hist) + '   RELATING TO ' + escapeXml(curr) + '</Data></Cell>\n' +
                '</Row>\n';

            xmlString += '<Row>\n';
            headers.forEach(header => { xmlString += strCell(header); });
            xmlString += '</Row>\n';

            // Una fila por item (sin sub-filas; el reporte agrega "para todas las recetas").
            rows.forEach(row => {
                xmlString += '<Row>';
                xmlString += strCell(row.cat);
                xmlString += strCell(row.productCode);
                xmlString += strCell(row.description);
                xmlString += strCell(row.pkstm);
                xmlString += strCell(row.stemsNeeded);
                xmlString += strCell(row.bunchesNeeded);
                xmlString += strCell(row.casesNeeded);
                xmlString += strCell(row.qtyOnHand);
                xmlString += strCell(row.unitprepcomp);
                xmlString += strCell(row.poReceived);
                xmlString += strCell(row.inBound);
                xmlString += strCell(row.casesShort);
                xmlString += strCell(row.casesOver);
                xmlString += '</Row>';
            });

            xmlString += ' </Table>\n' +
                '<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">\n' +
                '<PageSetup>\n' +
                '<PageMargins x:Bottom="0.75" x:Left="0.7" x:Right="0.7" x:Top="0.75"/>\n' +
                '</PageSetup>\n' +
                '<Selected/>\n' +
                '</WorksheetOptions>\n' +
                '</Worksheet>\n' +
                '</Workbook>';

            const base64EncodedString = encode.convert({
                string: xmlString,
                inputEncoding: encode.Encoding.UTF_8,
                outputEncoding: encode.Encoding.BASE_64
            });

            const approxFileBytes = Math.floor(base64EncodedString.length * 3 / 4);
            if (approxFileBytes > MAX_XLS_BYTES) {
                const mb = (approxFileBytes / (1024 * 1024)).toFixed(1);
                throw new Error(
                    `The generated Excel file is ~${mb} MB, which exceeds NetSuite's 10 MB limit. ` +
                    `Generate the report in PDF format or reduce the Prebook scope.`
                );
            }

            const excelFile = file.create({
                name: fileName || 'export_netSuite.xls',
                fileType: file.Type.EXCEL,
                contents: base64EncodedString
            });

            return excelFile;
        } catch (error) {
            log.error('GREENS.crearExcel', `Error al crear Excel: ${error.message}`);
            throw error; // propagar para que el shell muestre el mensaje
        }
    };

    // =========================================================================
    // 6. PDF
    // =========================================================================

    const findTemplateFileId = (fileName) => {
        const sql = `SELECT id FROM file WHERE name = ? ORDER BY id`;
        const rs = query.runSuiteQL({ query: sql, params: [fileName] });
        const results = rs.asMappedResults();
        return results.length ? results[0].id : null;
    };

    /** Genera el PDF desde la plantilla FTL. Aliases FreeMarker: record (prebook), data. */
    const crearPDF = (headers, rows, fileName, prebookId, preebookData) => {
        try {
            const templateFileId = findTemplateFileId(GR_TEMPLATE_FILENAME);
            if (!templateFileId) {
                throw new Error(`Template '${GR_TEMPLATE_FILENAME}' not found in the File Cabinet.`);
            }

            const templateFile = file.load({ id: templateFileId });

            const renderer = render.create();
            renderer.templateContent = templateFile.getContents();

            const preBookObj = record.load({
                type: 'customrecord_sgp_prebook',
                id: prebookId
            });
            renderer.addRecord({ templateName: 'record', record: preBookObj });

            renderer.addCustomDataSource({
                format: render.DataSource.JSON,
                alias: 'data',
                data: JSON.stringify({
                    report: rows,
                    headers: headers,
                    metadata: {
                        prebookId: prebookId,
                        prebookName: safeStr(preebookData?.name),
                        historicalStart: safeStr(preebookData?.custrecord_sgp_pb_historical_start_date),
                        historicalEnd: safeStr(preebookData?.custrecord_sgp_pb_historical_end_date),
                        currentStart: safeStr(preebookData?.custrecord_sgp_pb_current_start_date),
                        loc1Label: LOC1_LABEL,
                        generatedAt: nowStamp(),
                        totalRows: rows.length
                    }
                })
            });

            const pdfFile = renderer.renderAsPdf();
            pdfFile.name = fileName || 'export_netSuite.pdf';
            return pdfFile;
        } catch (error) {
            log.error('GREENS.crearPDF', `Error al crear PDF: ${error.message}`);
            throw error; // re-lanzar para que el shell muestre el mensaje (igual que crearExcel)
        }
    };

    // =========================================================================
    // 7. DATA — loadBomComponents (GREENS)
    // =========================================================================

    /**
     * Agrega los componentes GREENS del Prebook en UNA fila por item (el reporte
     * es "para todas las recetas": se suman las apariciones del item en todas
     * las BOM Revisions vigentes).
     *
     * Mapeo de columnas → fuente:
     *   CAT/PRODUCT CODE/DESCRIPTION/PACK PK/STM ← item.
     *   STEMS NEEDED  ← por cada receta (Bom) donde el green es componente
     *     (where-used, ya filtrado en SQL por vigencia + activos — ver fase 3),
     *     se ubica el producto terminado dueño de la receta (bomassemblyitemmap)
     *     y se multiplica su proyección (customrecord_sgp_prebook_projection_rp)
     *     × bomquantity del green en esa revisión, sumado entre recetas.
     *   BUNCHES NEEDED ← STEMS NEEDED / stems-por-bunch (custitem_sgp_actualstems).
     *   CASES NEEDED   ← aproximación temporal = BUNCHES NEEDED (falta fuente "mixed bunches").
     *   QUANTITY ONHAND← inventario inicial del Prebook, snapshot sin ubicación.
     *   UNIT PREP COMP ← unidades de Assembly Build (type='Build') para este Prebook.
     *   PO RECVD/IN BOUND LOC1 ← de líneas de PO filtradas a LOC1_ID.
     *   CASES SHORT/OVER LOC1  ← (onhand + recvd + inbound) vs CASES NEEDED (placeholder,
     *     unidades pendientes de reconciliar con negocio).
     *
     * Filtro de fechas: SQL-side, contra el rango CURRENT del Prebook (no
     * historical) — ver fase 3 y toIsoDateStr/parseAccountDate.
     *
     * @param {string} prebookId
     * @param {string} currentStart - custrecord_sgp_pb_current_start_date
     * @param {string} currentEnd   - custrecord_sgp_pb_currency_end_date
     * @returns {Array<Object>}
     */
    const loadBomComponents = (prebookId, currentStart, currentEnd) => {
        const rows = [];
        let phase = 'init';
        log.audit('GREENS.loadBomComponents',
            `INICIO prebookId=${prebookId} currentStart="${currentStart}" currentEnd="${currentEnd}"`);

        const sql_generalComponents = `
            SELECT
                category.custrecord_sgp_printing_prefix AS category_code,
                category.name AS category_name,
                itm.itemid AS item_name,
                NVL(itm.purchasedescription, ' ') AS description,
                itm.id AS item,
                itm.custitem_sgp_packing AS packing,
                itm.custitem_sgp_actualstems AS actual_stems
            FROM
                item itm
            INNER JOIN
                customrecord_sgp_category category ON category.id = itm.custitem_sgp_category
            WHERE
                itm.custitem_sgp_category IS NOT NULL
                AND itm.isinactive = 'F'
                AND LOWER(BUILTIN.DF(itm.custitem_sgp_category)) LIKE '%greens%'
            GROUP BY
                category.custrecord_sgp_printing_prefix,
                category.name,
                itm.itemid,
                NVL(itm.purchasedescription, ' '),
                itm.id,
                itm.custitem_sgp_packing,
                itm.custitem_sgp_actualstems
        `;

        try {
            // ── 1. Ítems GREENS ────────────────────────────────────────────
            phase = '1-greens items';
            const results_gnl = runSuiteQLAll(sql_generalComponents);
            if (!results_gnl.length) {
                log.audit('GREENS.loadBomComponents', 'Sin ítems GREENS → reporte vacío.');
                return rows;
            }
            log.audit('GREENS.loadBomComponents', `Ítems GREENS: ${results_gnl.length}`);
            const greenItemIds = results_gnl.map((r) => String(r.item));

            // ── 2. Where-used: en qué BomRevisionComponent aparece cada green ─
            phase = '2-where-used componentes';
            const revisionDataByItem = {};   // itemId → { revisionId: bomquantity }
            const allRevisionIdSet = {};
            let totalComponentRows = 0;
            chunkIds(greenItemIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        brc.item        AS item_id,
                        brc.bomrevision AS revision_id,
                        brc.bomquantity AS bom_quantity
                    FROM BomRevisionComponent brc
                    WHERE brc.item IN (${inList})
                `).forEach((r) => {
                    totalComponentRows++;
                    const itemId = String(r.item_id);
                    const revId = String(r.revision_id);
                    if (!revisionDataByItem[itemId]) revisionDataByItem[itemId] = {};
                    revisionDataByItem[itemId][revId] = Number(r.bom_quantity) || 1;
                    allRevisionIdSet[revId] = true;
                });
            });
            const allRevisionIds = Object.keys(allRevisionIdSet);
            log.audit('GREENS.loadBomComponents',
                `Fase 2: BomRevisionComponent filas=${totalComponentRows}, greens con >=1 receta=${Object.keys(revisionDataByItem).length} de ${greenItemIds.length}, revisiones únicas=${allRevisionIds.length}`);
            if (!allRevisionIds.length) {
                log.audit('GREENS.loadBomComponents',
                    'Fase 2: SIN revisiones — ningún green aparece como componente de ninguna receta. STEMS/BUNCHES/CASES NEEDED quedarán en 0 para todos.');
            }

            // ── 3. Revisión → BOM, ya filtrado en SQL por rango CURRENT ──────
            //      (TO_DATE con bind params — reduce filas traídas vs. filtrar en JS).
            phase = '3-revision a bom (SQL date-filtered)';
            const bomIdByRevision = {};     // revisionId → bomId (solo vigentes)
            const bomIdSet = {};
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
            let totalRevisionRows = 0;
            chunkIds(allRevisionIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        br.id                  AS revision_id,
                        br.billofmaterials     AS bom_id
                    FROM bomRevision br
                    WHERE br.id IN (${inList})
                      ${dateWhereSql}
                `, dateParams).forEach((r) => {
                    totalRevisionRows++;
                    const revId = String(r.revision_id);
                    bomIdByRevision[revId] = String(r.bom_id);
                    bomIdSet[String(r.bom_id)] = true;
                });
            });
            const bomIds = Object.keys(bomIdSet);
            log.audit('GREENS.loadBomComponents',
                `Fase 3: bomRevision filas=${totalRevisionRows} (de ${allRevisionIds.length} revisiones consultadas), BOMs vigentes en rango CURRENT [${currentStart} - ${currentEnd}]=${bomIds.length}`);
            if (allRevisionIds.length && !bomIds.length) {
                log.audit('GREENS.loadBomComponents',
                    'Fase 3: había revisiones (fase 2) pero NINGUNA calificó en el rango CURRENT del Prebook — revisar currentStart/currentEnd. STEMS/BUNCHES/CASES NEEDED quedarán en 0.');
            }

            // ── 4. Bom → producto terminado dueño (bomassemblyitemmap) ───────
            phase = '4-bom a producto terminado';
            const productItemIdByBom = {};
            let totalMapRows = 0;
            chunkIds(bomIds, 1000).forEach((inList) => {
                try {
                    runSuiteQLAll(`
                        SELECT
                            map.assemblyitem  AS product_item_id,
                            map.bom           AS bom_id
                        FROM bomassemblyitemmap map
                        WHERE map.bom IN (${inList})
                    `).forEach((r) => {
                        totalMapRows++;
                        productItemIdByBom[String(r.bom_id)] = String(r.product_item_id);
                    });
                } catch (eMap) {
                    log.error('GREENS.loadBomComponents',
                        `bomassemblyitemmap falló para este bloque (verificar esquema): ${eMap.message}`);
                }
            });
            const productItemIds = Object.keys(productItemIdByBom)
                .map((bomId) => productItemIdByBom[bomId]);
            log.audit('GREENS.loadBomComponents',
                `Fase 4: bomassemblyitemmap filas=${totalMapRows}, BOMs con producto terminado mapeado=${Object.keys(productItemIdByBom).length} de ${bomIds.length} consultados`);
            if (bomIds.length && !Object.keys(productItemIdByBom).length) {
                log.audit('GREENS.loadBomComponents',
                    'Fase 4: NINGÚN BOM tiene producto terminado en bomassemblyitemmap. La fase 9 descarta la receta cuando falta este mapeo (if (!productItemId) return) — STEMS/BUNCHES/CASES NEEDED quedarán en 0 para todos.');
            }

            // ── 5. Proyección del Prebook por producto terminado ──────────────
            phase = '5-proyecciones por producto terminado';
            const projByProduct = {};
            let totalProjRows = 0;
            chunkIds(productItemIds, 1000).forEach((inList) => {
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
                    totalProjRows++;
                    projByProduct[String(r.item_id)] = Number(r.total_qty) || 0;
                });
            });
            log.audit('GREENS.loadBomComponents',
                `Fase 5: customrecord_sgp_prebook_projection_rp filas=${totalProjRows}, productos con proyección=${Object.keys(projByProduct).length} de ${productItemIds.length} consultados (prebook_id_detail=${prebookId})`);
            if (productItemIds.length && !Object.keys(projByProduct).length) {
                log.audit('GREENS.loadBomComponents',
                    'Fase 5: SIN proyecciones para ningún producto terminado — revisar custrecord_sgp_prebook_id_detail=' + prebookId + ' en customrecord_sgp_prebook_projection_rp.');
            }

            // ── 6. PO recibidas / pedidas (LOC1) por green ────────────────────
            phase = '6-po qty y recibido (LOC1)';
            const poByItem = {};
            let totalPoRows = 0;
            chunkIds(greenItemIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        tl.item                     AS item_id,
                        SUM(tl.quantity)            AS po_quantity,
                        SUM(tl.quantityshiprecv)    AS po_received
                    FROM transaction t
                    INNER JOIN transactionline tl ON tl.transaction = t.id
                    WHERE t.type = 'PurchOrd'
                      AND t.custbody_sgp_report_id = ?
                      AND tl.mainline = 'F'
                      AND tl.item IN (${inList})
                    GROUP BY tl.item
                `, [prebookId]).forEach((r) => {
                    totalPoRows++;
                    poByItem[String(r.item_id)] = {
                        po_quantity: Number(r.po_quantity) || 0,
                        po_received: Number(r.po_received) || 0
                    };
                });
            });
            log.audit('GREENS.loadBomComponents',
                `Fase 6: líneas de PO (type=PurchOrd) filas=${totalPoRows}, greens con PO=${Object.keys(poByItem).length} de ${greenItemIds.length} (custbody_sgp_report_id=${prebookId}) [NOTA: filtro tl.location=LOC1 no está aplicado en esta query actualmente]`);
            if (greenItemIds.length && !totalPoRows) {
                log.audit('GREENS.loadBomComponents',
                    'Fase 6: 0 filas de PO — revisar que existan Purchase Orders con custbody_sgp_report_id=' + prebookId + '.');
            }

            // ── 7. Inventario inicial del Prebook (snapshot, sin ubicación) ───
            phase = '7-inventario inicial';
            const invByItem = {};
            let totalInvRows = 0;
            chunkIds(greenItemIds, 1000).forEach((inList) => {
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
                    totalInvRows++;
                    invByItem[String(r.item_id)] = Number(r.quantity) || 0;
                });
            });
            log.audit('GREENS.loadBomComponents',
                `Fase 7: customrecord_bc_prebookbeginninginvline filas=${totalInvRows}, greens con inventario inicial=${Object.keys(invByItem).length} de ${greenItemIds.length} (custrecordprebook=${prebookId})`);
            if (greenItemIds.length && !totalInvRows) {
                log.audit('GREENS.loadBomComponents',
                    'Fase 7: 0 filas de inventario inicial — revisar customrecord_bc_preebookbeginninginv.custrecordprebook=' + prebookId + ' con líneas activas.');
            }

            // ── 8. UNIT PREP COMP: Assembly Build completados (sin ubicación) ─
            phase = '8-unit prep comp (assembly build)';
            const prepByItem = {};
            let totalPrepRows = 0;
            chunkIds(greenItemIds, 1000).forEach((inList) => {
                try {
                    runSuiteQLAll(`
                        SELECT
                            tl.item          AS item_id,
                            SUM(tl.quantity) AS built_qty
                        FROM transaction t
                        INNER JOIN transactionline tl ON tl.transaction = t.id
                        WHERE t.type = 'Build'
                          AND t.custbody_sgp_report_id = ?
                          AND tl.mainline = 'F'
                          AND tl.item IN (${inList})
                        GROUP BY tl.item
                    `, [prebookId]).forEach((r) => {
                        totalPrepRows++;
                        prepByItem[String(r.item_id)] = Number(r.built_qty) || 0;
                    });
                } catch (eBuild) {
                    log.error('GREENS.loadBomComponents',
                        `Query de Assembly Build falló (verificar código de tipo 'Build'): ${eBuild.message}`);
                }
            });
            log.audit('GREENS.loadBomComponents',
                `Fase 8: Assembly Build filas=${totalPrepRows}, greens con producción=${Object.keys(prepByItem).length} de ${greenItemIds.length} (custbody_sgp_report_id=${prebookId})`);

            // ── 9. Armado de filas: STEMS NEEDED = explosión de BOM ───────────
            phase = '9-armado filas';
            // Contadores de diagnóstico (fase 9): en qué punto se descarta cada green
            // al armar STEMS NEEDED, y cuántos items terminan con cada columna en 0.
            let itemsNoRevData = 0, skipsNoBomId = 0, skipsNoProduct = 0;
            let itemsWithStems = 0, itemsWithOnHand = 0, itemsWithPoReceived = 0, itemsWithPrep = 0;
            results_gnl.forEach((r) => {
                const itemId = String(r.item);
                const packing = Number(r.packing) || 0;
                const actualStems = Number(r.actual_stems) || 0;

                // revData ya solo contiene revisiones vigentes (filtradas en SQL, fase 3).
                const revData = revisionDataByItem[itemId] || {};
                if (!Object.keys(revData).length) itemsNoRevData++;
                let stemsNeeded = 0;
                Object.keys(revData).forEach((revId) => {
                    const bomId = bomIdByRevision[revId];
                    if (!bomId) { skipsNoBomId++; return; }   // revisión fuera de rango, o sin match en fase 3
                    const productItemId = productItemIdByBom[bomId];
                    if (!productItemId) { skipsNoProduct++; return; }   // receta sin producto terminado mapeado
                    const projectedQty = projByProduct[productItemId] || 1;
                    stemsNeeded += (revData[revId] || 999)/* * projectedQty */;
                });

                const bunchesNeeded = actualStems > 0 ? Math.ceil(stemsNeeded / actualStems) : 0;
                const casesNeeded = bunchesNeeded; // aproximación temporal

                const po = poByItem[itemId] || { po_quantity: 0, po_received: 0 };
                const qtyOnHand = invByItem[itemId] || 0;
                const poReceived = po.po_received;
                const inBound = po.po_quantity - po.po_received;
                const unitprepcomp = prepByItem[itemId] || 0;

                const supply = qtyOnHand + poReceived + inBound;
                const diff = supply - casesNeeded;
                const casesShort = diff < 0 ? Math.abs(diff) : '';
                const casesOver = diff > 0 ? diff : '';

                const pkstm = (packing || actualStems) ? `${packing}/${actualStems}` : '';

                if (stemsNeeded > 0) itemsWithStems++;
                if (qtyOnHand > 0) itemsWithOnHand++;
                if (poReceived > 0) itemsWithPoReceived++;
                if (unitprepcomp > 0) itemsWithPrep++;

                rows.push({
                    cat: r.category_code || r.category_name || '',
                    productCode: r.item_name || '',
                    description: r.description || '',
                    pkstm: pkstm,
                    stemsNeeded: stemsNeeded,
                    bunchesNeeded: bunchesNeeded,
                    casesNeeded: casesNeeded,
                    qtyOnHand: qtyOnHand,
                    unitprepcomp: unitprepcomp,
                    poReceived: poReceived,
                    inBound: inBound,
                    casesShort: casesShort,
                    casesOver: casesOver,
                    componentItemId: itemId,
                    packing: packing,
                    actualStems: actualStems
                });
            });

            rows.sort((a, b) => String(a.cat).localeCompare(String(b.cat)) ||
                String(a.productCode).localeCompare(String(b.productCode)));

            log.audit('GREENS.loadBomComponents',
                `Fase 9 resumen: ${results_gnl.length} greens · sin recetas vigentes=${itemsNoRevData} · ` +
                `saltos por bomId no resuelto=${skipsNoBomId} · saltos por producto terminado no mapeado=${skipsNoProduct}`);
            log.audit('GREENS.loadBomComponents',
                `Fase 9 columnas >0: STEMS NEEDED=${itemsWithStems} · QUANTITY ONHAND=${itemsWithOnHand} · ` +
                `PO RECVD=${itemsWithPoReceived} · UNIT PREP COMP=${itemsWithPrep} (de ${results_gnl.length} greens)`);
            log.audit('GREENS.loadBomComponents', `Filas generadas: ${rows.length}`);
        } catch (e) {
            log.error('GREENS.loadBomComponents', `Fallo en fase [${phase}]: ${e.message} | ${e.stack}`);
        }
        return rows;
    };

    // =========================================================================
    // MISC HELPERS
    // =========================================================================

    const nowStamp = () => {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    };

    /** Detecta valores "vacíos", incluyendo ScriptNullObjectAdapter (ver R1). */
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

    /** Corre SuiteQL paginando de a 1000 filas (evita el límite de 5000 de runSuiteQL directo). */
    const runSuiteQLAll = (sql, params) => {
        params = params || [];
        try {
            const out = [];
            const paged = query.runSuiteQLPaged({ query: sql, params: params, pageSize: 1000 });
            paged.pageRanges.forEach((pr) => {
                const page = paged.fetch({ index: pr.index });
                page.data.asMappedResults().forEach((r) => out.push(r));
            });
            return out;
        } catch (ePaged) {
            log.debug('GREENS.runSuiteQLAll',
                `Sin paginación para esta consulta, uso runSuiteQL directo. Detalle: ${ePaged.message}`);
            const results = query.runSuiteQL({ query: sql, params: params }).asMappedResults();
            if (results.length === 5000) {
                log.error('GREENS.runSuiteQLAll',
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

    // NOTA: código muerto (no se invoca desde generate()), heredado de una versión previa.
    const buildEmptyResponse = (format, prebookId, preebookData) => {
        const headers = ['CAT', 'PRODUCT CODE', 'PRODUCT DESCRIPTION', 'PACK PK/STM', 'STEMS NEEDED',
            'BUNCHES NEEDED', 'CASES NEEDED', 'QUANTITY ONHAND', 'UNIT PREP COMP', 'PO RECVD LOC1',
            'IN BOUND LOC1', 'CASES SHORT LOC1', 'CASES OVER LOC1'];
        if (String(format).toUpperCase() === 'PDF') {
            return { fileObj: crearPDF(headers, [], `Greens_Projection_${prebookId}_${nowStamp()}.pdf`, prebookId, preebookData), contentType: 'PDF', filename: `Greens_Projection_${prebookId}.pdf` };
        }
        return { fileObj: crearExcel(headers, [], `Greens_Projection_${prebookId}_${nowStamp()}.xlsx`, prebookId, preebookData), contentType: 'application/vnd.ms-excel', filename: `Greens_Projection_${prebookId}.xls` };
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

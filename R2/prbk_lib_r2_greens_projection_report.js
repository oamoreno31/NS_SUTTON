/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * R2 — ALL RAW MATERIALS PROJECTION REPORT (GREENS)
 * Hermano de prbk_lib_r1_hardgoods_buying_report.js. Misma arquitectura, pero:
 *   - Solo artículos GREENS (no hardgoods).
 *   - Columnas y cálculos distintos (ver mapeo).
 *   - loadBomComponents reescrito por completo (agrega por item, "para todas las recetas").
 *
 * Columnas mostradas (orden del reporte impreso):
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

    const LOC1_ID = 1;          // ← Internal ID real de LOC1
    const LOC1_LABEL = 'LOC1';  // ← nombre visible de LOC1

    /**
     * Nombre del archivo .ftl (plantilla FreeMarker) en el File Cabinet.
     * Su Internal ID se resuelve en runtime (findTemplateFileId) para no
     * tocar el script al migrar entre ambientes.
     */
    const GR_TEMPLATE_FILENAME = 'prbk_custtmpl_r2_greens_projection_report.ftl';

    // Límite real de file.create en NetSuite es 10 MB; dejamos margen.
    const MAX_XLS_BYTES = 9.8 * 1024 * 1024;

    // =========================================================================
    // 1. METADATA
    // =========================================================================

    const getMetadata = () => ({
        id: 'GREENS_PROJECTION',
        name: 'All Raw Materials Projection - Greens',
        description: 'Proyección de materia prima (greens) por item: stems/bunches/cases ' +
            'necesarios, inventario inicial, POs recibidas, inbound y corto/sobrante en cajas.',
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
            helpText: 'Seleccione el Preebook del cual se generará el reporte.'
        },
        {
            id: 'output_format',
            label: 'Tipo de documento',
            type: 'select',
            mandatory: true,
            options: [
                { value: 'EXCEL', text: 'Excel' },
                { value: 'PDF', text: 'PDF' }
            ],
            helpText: 'Seleccione el formato del documento a generar (Excel o PDF).',
            // previewChoice: el shell oculta este campo del formulario de filtros
            // cuando la librería implementa getPreviewData() — el formato se elige
            // desde los botones "Download Excel" / "Download PDF" de la pantalla
            // de previsualización, no antes. Ver prbk_sl_reports_shell.js.
            previewChoice: true
        }
    ]);

    // =========================================================================
    // 3. VALIDACIÓN
    // =========================================================================

    const validateFilters = (values) => {
        if (!values.prebook) {
            return { valid: false, message: 'Debe seleccionar un Preebook.' };
        }
        const fmt = String(values.output_format || '').toUpperCase();
        if (!fmt) {
            return { valid: false, message: 'Debe seleccionar el tipo de documento (Excel o PDF).' };
        }
        if (fmt !== 'EXCEL' && fmt !== 'PDF') {
            return { valid: false, message: 'Tipo de documento inválido. Use Excel o PDF.' };
        }
        return { valid: true };
    };

    // =========================================================================
    // 4. GENERATE
    // =========================================================================

    /**
     * @param  {Object} filterValues  - filterValues.prebook, filterValues.output_format
     * @returns {Object} { fileObj, contentType, filename }
     */
    const generate = (filterValues) => {
        const prebookId = String(filterValues.prebook);
        const format = String(filterValues.output_format || 'EXCEL').toUpperCase();
        log.audit('GREENS.generate', `prebook=${prebookId}  format=${format}`);

        // ── Cabecera del Prebook (se necesita ANTES de cargar filas: el rango
        //    CURRENT start/end se usa para filtrar las BomRevision vigentes) ──
        //    El historical se sigue trayendo solo para el texto "History: ..." del
        //    header del Excel/PDF (sin cambios en ese display).
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

        // Rango a comparar contra las BomRevision: el rango CURRENT del Prebook —
        // NO el historical (el historical cubre ~1 año hacia atrás y hacía que
        // aparecieran recetas/revisiones de hasta un año antes del seleccionado).
        const currentStart = safeStr(preebookData?.custrecord_sgp_pb_current_start_date);
        const currentEnd = safeStr(preebookData?.custrecord_sgp_pb_currency_end_date);

        // ── Filas del reporte (una por item greens, agregadas para todas las recetas) ──
        const rows = loadBomComponents(prebookId, currentStart, currentEnd);
        log.audit('GREENS.rows', `count=${rows.length}`);

        // Orden/etiquetas alineadas con el mapeo oficial de columnas:
        // QUANTITY ONHAND va ANTES de UNIT PREP COMP (antes estaban invertidas),
        // y PO RECVD / IN BOUND / CASES SHORT / CASES OVER llevan sufijo LOC1.
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
    // 4b. GET PREVIEW DATA — misma data/estructura que crearExcel, pero en JSON
    //     plano para que el shell la pinte en la pantalla de previsualización.
    //     No genera ningún archivo; no toca generate/crearExcel/crearPDF.
    // =========================================================================

    /**
     * @param {Object} filterValues - filterValues.prebook (output_format no aplica aquí:
     *                                 se elige en la pantalla de preview vía previewChoice).
     * @returns {Object} { title, prebookName, metaLines, headers, rows, rowCount }
     */
    const getPreviewData = (filterValues) => {
        const prebookId = String(filterValues.prebook);
        log.audit('GREENS.getPreviewData', `prebook=${prebookId}`);

        // El rango que filtra las BomRevision es CURRENT, no historical (ver
        // generate() más arriba). El historical se sigue trayendo solo para el
        // texto "History: ..." de metaLines más abajo.
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
            // Helpers de celda: escapan caracteres XML (&, <, >) y emiten celdas vacías
            // mínimas. Las celdas NO llevan ss:StyleID: heredan el borde del estilo Default.
            // Usa isEmptyValue para blindarse contra ScriptNullObjectAdapter (ver R1).
            const escapeXml = (v) => isEmptyValue(v) ? '' :
                String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const EMPTY = '<Cell/>';
            const strCell = (v) => `<Cell><Data ss:Type="String">${escapeXml(v)}</Data></Cell>`;

            const hist = `History: ${escapeXml(preebookData?.custrecord_sgp_pb_historical_start_date)} - ${escapeXml(preebookData?.custrecord_sgp_pb_historical_end_date)}`;
            // TODO: cuando exista el field de fin de período actual, mostrar "{start} - {end}".
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
                // Bloque de título (estilo sPlain = sin borde)
                '<Row>\n' +
                '<Cell ss:StyleID="sPlain"><Data ss:Type="String">WO720.R   # ' + escapeXml(prebookId) + '   ALL RAW MATERIALS PROJECTION REPORT FOR ALL RECIPES</Data></Cell>\n' +
                '</Row>\n' +
                '<Row>\n' +
                // TODO: "PREPARED FOR" debería ser el nombre de la compañía/sucursal; por ahora usamos el nombre del Prebook.
                '<Cell ss:StyleID="sPlain"><Data ss:Type="String">PREPARED FOR: ' + escapeXml(preebookData?.name) + '</Data></Cell>\n' +
                '</Row>\n' +
                '<Row>\n' +
                '<Cell ss:StyleID="sPlain"><Data ss:Type="String">ALL SUB CATS   - ' + escapeXml(hist) + '   RELATING TO ' + escapeXml(curr) + '</Data></Cell>\n' +
                '</Row>\n';

            // Encabezados
            xmlString += '<Row>\n';
            headers.forEach(header => { xmlString += strCell(header); });
            xmlString += '</Row>\n';

            // Filas de datos: UNA por item (sin sub-filas de recetas; el reporte agrega "para todas las recetas")
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

            // Cierre
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

            // Control de tamaño: archivo real ≈ len(base64) * 3/4
            const approxFileBytes = Math.floor(base64EncodedString.length * 3 / 4);
            if (approxFileBytes > MAX_XLS_BYTES) {
                const mb = (approxFileBytes / (1024 * 1024)).toFixed(1);
                throw new Error(
                    `El Excel generado pesa ~${mb} MB y supera el límite de 10 MB de NetSuite. ` +
                    `Genere el reporte en formato PDF o reduzca el alcance del Prebook.`
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

    /**
     * Genera el PDF a partir de la plantilla FTL del File Cabinet.
     * Aliases para FreeMarker: record (prebook) y data ({ report, headers, metadata }).
     */
    const crearPDF = (headers, rows, fileName, prebookId, preebookData) => {
        try {
            const templateFileId = findTemplateFileId(GR_TEMPLATE_FILENAME);
            if (!templateFileId) {
                log.error('GREENS.crearPDF',
                    `No se encontró la plantilla '${GR_TEMPLATE_FILENAME}' en el File Cabinet.`);
                return null;
            }

            const templateFile = file.load({ id: templateFileId });

            const renderer = render.create();
            renderer.templateContent = templateFile.getContents();

            const preBookObj = record.load({
                type: 'customrecord_sgp_prebook',
                id: prebookId
            });
            renderer.addRecord('record', preBookObj);

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
            return null;
        }
    };

    // =========================================================================
    // 7. DATA — loadBomComponents (GREENS)
    // =========================================================================

    /**
     * Carga y agrega los componentes GREENS del Prebook en UNA fila por item
     * (el reporte es "para todas las recetas", así que se suman las apariciones del
     * item en todas las BOM Revisions vigentes durante el período historical del Prebook).
     *
     * Mapeo de columnas → fuente (confirmado contra el documento de mapeo oficial):
     *   CAT                  ← custrecord_sgp_category (SGP CATEGORY), prefijo de impresión
     *   PRODUCT CODE         ← item.itemid (MPN)
     *   PRODUCT DESCRIPTION  ← item.purchasedescription
     *   PACK PK/STM          ← "{custitem_sgp_packing}/{custitem_sgp_actualstems}" (descriptivo)
     *   STEMS NEEDED         ← explosión de BOM: por cada receta (Bom) donde el green aparece
     *                          como componente (BomRevisionComponent, "where-used"), filtrando
     *                          solo las BomRevision vigentes durante
     *                          [historicalStart, historicalEnd] (overlap de fechas), se ubica
     *                          el producto terminado dueño de esa receta (bomassemblyitemmap:
     *                          item ↔ su BOM propia) y se multiplica su cantidad proyectada
     *                          (customrecord_sgp_prebook_projection_rp) × bomquantity del green
     *                          en esa revisión. Se suma entre todas las recetas calificadas.
     *   BUNCHES NEEDED       ← STEMS NEEDED / stems-por-bunch (custitem_sgp_actualstems)
     *   CASES NEEDED         ← APROXIMACIÓN TEMPORAL = BUNCHES NEEDED (aún no existe la fuente
     *                          de "mixed bunches"; cuando se defina, sumar aquí).
     *   QUANTITY ONHAND      ← inventario inicial del Prebook (customrecord_bc_prebookbeginninginvline),
     *                          snapshot fijo, sin desglose por ubicación.
     *   UNIT PREP COMP       ← unidades de Assembly Build (type='Build') completadas para este
     *                          Prebook (custbody_sgp_report_id), sin desglose por ubicación.
     *                          OJO: verificar contra la cuenta que el código de tipo de
     *                          transacción para Assembly Build sea 'Build'.
     *   PO RECVD LOC1        ← cantidad recibida en POs (quantityshiprecv), filtrado a LOC1_ID.
     *   IN BOUND LOC1        ← qty de PO pedida no recibida (quantity - quantityshiprecv), LOC1_ID.
     *   CASES SHORT/OVER LOC1← (QUANTITY ONHAND + PO RECVD LOC1 + IN BOUND LOC1) vs CASES NEEDED.
     *                          NOTA: mezcla unidades (onhand/PO probablemente en "cases" de compra,
     *                          CASES NEEDED es una aproximación de bunches) — placeholder hasta
     *                          reconciliar unidades con el negocio.
     *
     * Rango de fechas usado para "vigentes": el rango CURRENT del Prebook
     *   (custrecord_sgp_pb_current_start_date / ..._currency_end_date) — NO el
     *   historical (el historical cubre ~1 año hacia atrás y hacía aparecer
     *   recetas/revisiones de hasta un año antes del rango seleccionado).
     *
     * @param {string} prebookId
     * @param {string} currentStart - Fecha (formato de cuenta) de custrecord_sgp_pb_current_start_date.
     * @param {string} currentEnd   - Fecha (formato de cuenta) de custrecord_sgp_pb_currency_end_date.
     * @returns {Array<Object>}
     */
    const loadBomComponents = (prebookId, currentStart, currentEnd) => {
        const rows = [];
        let phase = 'init';

        // Base: items GREENS obtenidos directamente desde el registro de item
        const sql_generalComponents = `
            SELECT
                category.custrecord_sgp_printing_prefix AS category_code,
                category.name AS category_name,
                itm.itemid AS item_name,
                NVL(itm.purchasedescription, ' ') AS description, -- Protege contra nulos
                itm.id AS item,
                itm.custitem_sgp_packing AS packing,
                itm.custitem_sgp_actualstems AS actual_stems
            FROM
                item itm
            INNER JOIN
                customrecord_sgp_category category ON category.id = itm.custitem_sgp_category
            WHERE
                itm.custitem_sgp_category IS NOT NULL
                AND LOWER(BUILTIN.DF(itm.custitem_sgp_category)) LIKE '%greens%'
            GROUP BY
                category.custrecord_sgp_printing_prefix, -- ¡Agregado! (Evita el error de NetSuite)
                category.name,
                itm.itemid,
                NVL(itm.purchasedescription, ' '),       -- Alineado con el SELECT
                itm.id,
                itm.custitem_sgp_packing,
                itm.custitem_sgp_actualstems
        `;

        try {
            // ── 1. Ítems GREENS ──────────────────────────────────────────────
            phase = '1-greens items';
            const results_gnl = runSuiteQLAll(sql_generalComponents);
            if (!results_gnl.length) {
                log.audit('GREENS.loadBomComponents', 'Sin ítems GREENS → reporte vacío.');
                return rows;
            }
            log.audit('GREENS.loadBomComponents', `Ítems GREENS: ${results_gnl.length}`);
            const greenItemIds = results_gnl.map((r) => String(r.item));

            // ── 2. Where-used: en qué BomRevisionComponent aparece cada green ──
            //      como COMPONENTE, junto con su bomquantity.
            phase = '2-where-used componentes';
            const revisionDataByItem = {};   // itemId → { revisionId: bomquantity, ... }
            const allRevisionIdSet = {};
            chunkIds(greenItemIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        brc.item        AS item_id,
                        brc.bomrevision AS revision_id,
                        brc.bomquantity AS bom_quantity
                    FROM BomRevisionComponent brc
                    WHERE brc.item IN (${inList})
                `).forEach((r) => {
                    const itemId = String(r.item_id);
                    const revId = String(r.revision_id);
                    if (!revisionDataByItem[itemId]) revisionDataByItem[itemId] = {};
                    revisionDataByItem[itemId][revId] = Number(r.bom_quantity) || 0;
                    allRevisionIdSet[revId] = true;
                });
            });
            const allRevisionIds = Object.keys(allRevisionIdSet);
            log.audit('GREENS.loadBomComponents',
                `Revisiones de BOM donde algún green aparece como componente: ${allRevisionIds.length}`);

            // ── 3. Revisión → Bill of Materials + fechas de vigencia ──────────
            phase = '3-revision a bom + fechas';
            const bomIdByRevision = {};     // revisionId → bomId
            const revisionQualifies = {};   // revisionId → boolean (vigente en el rango CURRENT del Prebook)
            const currentStartDate = parseAccountDate(currentStart);
            const currentEndDate = parseAccountDate(currentEnd);
            const bomIdSet = {};
            chunkIds(allRevisionIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        br.id                  AS revision_id,
                        br.billofmaterials     AS bom_id,
                        br.effectivestartdate  AS eff_start,
                        br.effectiveenddate    AS eff_end
                    FROM bomRevision br
                    WHERE br.id IN (${inList})
                `).forEach((r) => {
                    const revId = String(r.revision_id);
                    bomIdByRevision[revId] = String(r.bom_id);

                    // Vigente si se solapa con [currentStart, currentEnd]:
                    // effectivestartdate <= currentEnd AND (sin fin O effectiveenddate >= currentStart)
                    const effStart = parseAccountDate(r.eff_start);
                    const effEnd = parseAccountDate(r.eff_end);
                    let qualifies = true;
                    if (currentEndDate && effStart && effStart > currentEndDate) qualifies = false;
                    if (currentStartDate && effEnd && effEnd < currentStartDate) qualifies = false;
                    revisionQualifies[revId] = qualifies;

                    if (qualifies) bomIdSet[String(r.bom_id)] = true;
                });
            });
            const bomIds = Object.keys(bomIdSet);
            log.audit('GREENS.loadBomComponents',
                `Recetas (Bom) con al menos una revisión vigente en rango CURRENT [${currentStart} - ${currentEnd}]: ${bomIds.length}`);

            // ── 4. Bom → producto terminado dueño de esa receta (bomassemblyitemmap) ─
            //      OJO: se asume que la tabla tiene columnas item/billofmaterials;
            //      si esta fase falla, revisar el esquema real de bomassemblyitemmap
            //      en la cuenta (ver nota histórica sobre 'masterdefault' en R1).
            phase = '4-bom a producto terminado';
            const productItemIdByBom = {};   // bomId → productItemId
            chunkIds(bomIds, 1000).forEach((inList) => {
                try {
                    runSuiteQLAll(`
                        SELECT
                            map.item             AS product_item_id,
                            map.billofmaterials  AS bom_id
                        FROM bomassemblyitemmap map
                        WHERE map.billofmaterials IN (${inList})
                    `).forEach((r) => {
                        productItemIdByBom[String(r.bom_id)] = String(r.product_item_id);
                    });
                } catch (eMap) {
                    log.error('GREENS.loadBomComponents',
                        `bomassemblyitemmap falló para este bloque de BOMs (verificar esquema real): ${eMap.message}`);
                }
            });
            const productItemIds = Object.keys(productItemIdByBom)
                .map((bomId) => productItemIdByBom[bomId]);

            // ── 5. Proyección del Prebook por producto terminado (demanda) ────
            phase = '5-proyecciones por producto terminado';
            const projByProduct = {};   // productItemId → cantidad proyectada (suma)
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
                    projByProduct[String(r.item_id)] = Number(r.total_qty) || 0;
                });
            });

            // ── 6. PO recibidas / pedidas (LOC1) por green ────────────────────
            phase = '6-po qty y recibido (LOC1)';
            const poByItem = {};   // itemId → { po_quantity, po_received }
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
                      AND tl.location = ${Number(LOC1_ID)}
                      AND tl.item IN (${inList})
                    GROUP BY tl.item
                `, [prebookId]).forEach((r) => {
                    poByItem[String(r.item_id)] = {
                        po_quantity: Number(r.po_quantity) || 0,
                        po_received: Number(r.po_received) || 0
                    };
                });
            });

            // ── 7. Inventario inicial del Prebook (snapshot, sin ubicación) ───
            phase = '7-inventario inicial';
            const invByItem = {};   // itemId → quantity
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
                    invByItem[String(r.item_id)] = Number(r.quantity) || 0;
                });
            });

            // ── 8. UNIT PREP COMP: Assembly Build completados (sin ubicación) ─
            phase = '8-unit prep comp (assembly build)';
            const prepByItem = {};   // itemId → quantity
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
                        prepByItem[String(r.item_id)] = Number(r.built_qty) || 0;
                    });
                } catch (eBuild) {
                    log.error('GREENS.loadBomComponents',
                        `Query de Assembly Build falló (verificar código de tipo 'Build' en la cuenta): ${eBuild.message}`);
                }
            });

            // ── 9. Armado de filas: STEMS NEEDED = explosión de BOM ───────────
            phase = '9-armado filas';
            results_gnl.forEach((r) => {
                const itemId = String(r.item);
                const packing = Number(r.packing) || 0;
                const actualStems = Number(r.actual_stems) || 0;

                // Recetas calificadas (vigentes en el rango) donde este green es componente.
                const revData = revisionDataByItem[itemId] || {};
                let stemsNeeded = 0;
                Object.keys(revData).forEach((revId) => {
                    if (!revisionQualifies[revId]) return;
                    const bomId = bomIdByRevision[revId];
                    if (!bomId) return;
                    const productItemId = productItemIdByBom[bomId];
                    if (!productItemId) return;   // receta sin producto terminado mapeado (bomassemblyitemmap)
                    const projectedQty = projByProduct[productItemId] || 0;
                    stemsNeeded += (revData[revId] || 0) * projectedQty;
                });

                const bunchesNeeded = actualStems > 0 ? Math.ceil(stemsNeeded / actualStems) : 0;

                // CASES NEEDED: aproximación temporal (sin fuente de "mixed bunches" todavía).
                const casesNeeded = bunchesNeeded;

                const po = poByItem[itemId] || { po_quantity: 0, po_received: 0 };
                const qtyOnHand = invByItem[itemId] || 0;
                const poReceived = po.po_received;
                const inBound = po.po_quantity - po.po_received;
                const unitprepcomp = prepByItem[itemId] || 0;

                // CASES SHORT/OVER (LOC1): oferta (onhand + recibido + inbound) vs demanda (casesNeeded).
                // NOTA: placeholder hasta reconciliar unidades (ver comentario en el JSDoc de la función).
                const supply = qtyOnHand + poReceived + inBound;
                const diff = supply - casesNeeded;
                const casesShort = diff < 0 ? Math.abs(diff) : '';
                const casesOver = diff > 0 ? diff : '';

                const pkstm = (packing || actualStems) ? `${packing}/${actualStems}` : '';

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

            // Orden por CAT y Código de Producto
            rows.sort((a, b) => String(a.cat).localeCompare(String(b.cat)) ||
                String(a.productCode).localeCompare(String(b.productCode)));

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

    /**
     * Detecta valores "vacíos", incluyendo el caso en que NetSuite devuelve un
     * ScriptNullObjectAdapter (objeto Java interno) en vez de null/undefined para
     * campos sin valor (frecuente en fechas de search.lookupFields). Sin este
     * check, String(v) imprime el nombre de la clase Java literalmente. Ver el
     * mismo problema/fix en prbk_lib_r1_hardgoods_buying_report.js.
     */
    const isEmptyValue = (v) => {
        if (v === null || v === undefined || v === '') return true;
        if (typeof v === 'object') {
            return /NullObjectAdapter/i.test(String(v));
        }
        return false;
    };

    /** Convierte a string vacío cualquier valor "vacío" (ver isEmptyValue). */
    const safeStr = (v) => (isEmptyValue(v) ? '' : String(v));

    /**
     * Parsea una fecha de NetSuite (formato de cuenta, ej. "1/15/2026", o ISO
     * "2026-01-15") a un objeto Date. Devuelve null si no se puede interpretar.
     * Necesario para comparar effectivestartdate/enddate de BomRevision contra
     * el rango historical start/end del Prebook sin depender del formato exacto
     * que devuelva SuiteQL en esta cuenta.
     */
    const parseAccountDate = (v) => {
        const s = safeStr(v);
        if (!s) return null;
        // ISO (YYYY-MM-DD[...])
        let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) {
            const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
            return isNaN(d.getTime()) ? null : d;
        }
        // MM/DD/YYYY (formato típico de cuenta US)
        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) {
            const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
            return isNaN(d.getTime()) ? null : d;
        }
        const fallback = new Date(s);
        return isNaN(fallback.getTime()) ? null : fallback;
    };

    /**
     * Ejecuta una SuiteQL y devuelve TODOS los resultados mapeados, paginando de a
     * 1000 para no chocar contra el límite de 5000 filas de runSuiteQL directo.
     * Mismo helper que en prbk_lib_r1_hardgoods_buying_report.js.
     */
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

    // NOTA: esta función no se invoca desde generate() actualmente (código muerto,
    // heredado de una versión previa) — se deja actualizada por consistencia.
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
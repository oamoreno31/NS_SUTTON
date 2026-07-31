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

    const LOC1_ID = 1;
    const LOC1_LABEL = 'LOC1';

    const GR_TEMPLATE_FILENAME = 'prbk_custtmpl_r2_greens_projection_report.ftl';

    const MAX_XLS_BYTES = 9.8 * 1024 * 1024;

    // Header set completo, con las 2 columnas de auditoría ya incluidas, en el
    // orden en que se leen como ecuación: SUBTOTAL (cascada del BOM, antes de
    // multiplicar) * SOLD (la proyección del Prebook, fase 5) =
    // STEMS NEEDED (el resultado). SOLD = row.soldBunches (projectedQty);
    // SUBTOTAL = row.subtotal (suma de compTotals SIN multiplicar).
    const ALL_HEADERS = ['CAT', 'PRODUCT CODE', 'PRODUCT DESCRIPTION', 'PACK PK/STM', 'SOLD', 'SUBTOTAL', 'STEMS NEEDED',
        'BUNCHES NEEDED', 'CASES NEEDED', 'QUANTITY ONHAND', 'UNIT PREP COMP', 'PO RECVD LOC1',
        'IN BOUND LOC1', 'CASES SHORT LOC1', 'CASES OVER LOC1'];

    const AUDIT_HEADERS = ['SOLD', 'SUBTOTAL'];

    /** true si el checkbox "Show audit" está marcado (desmarcado por defecto). */
    const isShowAudit = (filterValues) =>
        String((filterValues || {}).show_audit || 'F').toUpperCase() === 'T';

    /** Headers para Excel/PDF (la descarga real, no el preview): sin "Show audit"
     *  marcado, se quitan SOLD/SUBTOTAL por completo del set de columnas
     *  — a diferencia del preview (que usa ALL_HEADERS siempre + hideColumns
     *  client-side, ver getFilterDefinitions), acá si no se filtra el header
     *  quedaría una columna de más sin celda correspondiente en las filas. */
    const getHeaders = (showAudit) =>
        showAudit ? ALL_HEADERS : ALL_HEADERS.filter((h) => AUDIT_HEADERS.indexOf(h) === -1);

    const getMetadata = () => ({
        id: 'GREENS_PROJECTION',
        name: 'All Raw Materials Projection - Greens',
        description: 'Raw material (greens) projection per item: stems/bunches/cases needed, ' +
            'beginning inventory, POs received, inbound, and case short/over.',
        formats: ['PDF', 'EXCEL']
    });

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
            previewChoice: true
        },
        {
            id: 'show_audit',
            label: 'Show audit',
            type: 'checkbox',
            defaultValue: 'F',
            helpText: 'Reveals SOLD and SUBTOTAL: the Prebook projection quantity and the pre-multiplication BOM cascade used to calculate STEMS NEEDED.',
            previewChoice: true,
            hideColumns: AUDIT_HEADERS
        }
    ]);

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

    const generate = (filterValues) => {
        const prebookId = String(filterValues.prebook);
        const format = String(filterValues.output_format || 'EXCEL').toUpperCase();
        log.audit('GREENS.generate', `prebook=${prebookId}  format=${format}`);

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

        const showAudit = isShowAudit(filterValues);
        const headers = getHeaders(showAudit);
        const baseName = `Greens_Projection_${String(preebookData?.name).replace(/\s+/g, '_')}_${nowStamp()}`;

        if (format === 'PDF') {
            const reportPdf = crearPDF(headers, rows, `${baseName}.pdf`, prebookId, preebookData, showAudit);
            return { fileObj: reportPdf, contentType: 'PDF', filename: `${baseName}.pdf` };
        }

        const reportExcel = crearExcel(headers, rows, `${baseName}.xlsx`, prebookId, preebookData, showAudit);
        return { fileObj: reportExcel, contentType: 'application/vnd.ms-excel', filename: `${baseName}.xls` };
    };

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

        // El preview siempre manda el set completo de headers (incluidas SOLD
        // BUNCHES y SUBTOTAL): el checkbox "Show audit" oculta/muestra esas
        // columnas client-side vía hideColumns (ver getFilterDefinitions), sin
        // necesidad de volver a pedir el preview al server. Excel/PDF sí filtran
        // de verdad (ver generate() → getHeaders/showAudit).
        const headers = ALL_HEADERS;

        const flatRows = rows.map((r) => ([
            safeStr(r.cat), safeStr(r.productCode), safeStr(r.description), safeStr(r.pkstm),
            String(r.soldBunches || 0), String(r.subtotal || 0),
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
                `ALL SUB CATS - History: ${historicalStart} - ${historicalEnd}  RELATING TO Current: ${currentStart} - ${currentEnd}`
            ],
            headers: headers,
            rows: flatRows,
            rowCount: rows.length
        };
    };

    const crearExcel = (headers, rows, fileName, prebookId, preebookData, showAudit) => {
        try {
            const escapeXml = (v) => isEmptyValue(v) ? '' :
                String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const EMPTY = '<Cell/>';
            const strCell = (v) => `<Cell><Data ss:Type="String">${escapeXml(v)}</Data></Cell>`;

            const hist = `History: ${escapeXml(preebookData?.custrecord_sgp_pb_historical_start_date)} - ${escapeXml(preebookData?.custrecord_sgp_pb_historical_end_date)}`;
            const curr = `Current: ${escapeXml(preebookData?.custrecord_sgp_pb_current_start_date)} - ${escapeXml(preebookData?.custrecord_sgp_pb_currency_end_date)}`;

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
                '<Column ss:Width="45"/>\n' +
                '<Column ss:Width="60"/>\n' +
                '<Column ss:Width="160"/>\n' +
                '<Column ss:Width="60"/>\n' +
                (showAudit ? '<Column ss:Width="60"/>\n' : '') +   // SOLD
                (showAudit ? '<Column ss:Width="60"/>\n' : '') +   // SUBTOTAL
                '<Column ss:Width="65"/>\n' +
                '<Column ss:Width="60"/>\n' +
                '<Column ss:Width="65"/>\n' +
                '<Column ss:Width="55"/>\n' +
                '<Column ss:Width="55"/>\n' +
                '<Column ss:Width="60"/>\n' +
                '<Column ss:Width="60"/>\n' +
                '<Row>\n' +
                '<Cell ss:StyleID="sPlain"><Data ss:Type="String">WO720.R   # ' + escapeXml(prebookId) + '   ALL RAW MATERIALS PROJECTION REPORT FOR ALL RECIPES</Data></Cell>\n' +
                '</Row>\n' +
                '<Row>\n' +
                '<Cell ss:StyleID="sPlain"><Data ss:Type="String">PREPARED FOR: ' + escapeXml(preebookData?.name) + '</Data></Cell>\n' +
                '</Row>\n' +
                '<Row>\n' +
                '<Cell ss:StyleID="sPlain"><Data ss:Type="String">ALL SUB CATS   - ' + escapeXml(hist) + '   RELATING TO ' + escapeXml(curr) + '</Data></Cell>\n' +
                '</Row>\n';

            xmlString += '<Row>\n';
            headers.forEach(header => { xmlString += strCell(header); });
            xmlString += '</Row>\n';

            rows.forEach(row => {
                xmlString += '<Row>';
                xmlString += strCell(row.cat);
                xmlString += strCell(row.productCode);
                xmlString += strCell(row.description);
                xmlString += strCell(row.pkstm);
                if (showAudit) {
                    xmlString += strCell(row.soldBunches);
                    xmlString += strCell(row.subtotal);
                }
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
            throw error;
        }
    };

    const findTemplateFileId = (fileName) => {
        const sql = `SELECT id FROM file WHERE name = ? ORDER BY id`;
        const rs = query.runSuiteQL({ query: sql, params: [fileName] });
        const results = rs.asMappedResults();
        return results.length ? results[0].id : null;
    };

    const crearPDF = (headers, rows, fileName, prebookId, preebookData, showAudit) => {
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
                        currentEnd: safeStr(preebookData?.custrecord_sgp_pb_currency_end_date),
                        loc1Label: LOC1_LABEL,
                        generatedAt: nowStamp(),
                        generatedAtDisplay: nowDisplayStamp(),
                        totalRows: rows.length,
                        // 'T'/'F' en vez de boolean: mismo criterio que R1 (showItemCost/
                        // showRecipeAudit) — un boolean JSON no garantiza tipo en el data
                        // source de FreeMarker y puede evaluar mal en <#if>.
                        showAudit: (showAudit === true) ? 'T' : 'F'
                    }
                })
            });

            const pdfFile = renderer.renderAsPdf();
            pdfFile.name = fileName || 'export_netSuite.pdf';
            return pdfFile;
        } catch (error) {
            log.error('GREENS.crearPDF', `Error al crear PDF: ${error.message}`);
            throw error;
        }
    };

    const loadBomComponents = (prebookId, currentStart, currentEnd) => {
        const rows = [];
        let phase = 'init';
        log.audit('GREENS.loadBomComponents',
            `INICIO prebookId=${prebookId} currentStart="${currentStart}" currentEnd="${currentEnd}"`);

        const sql_generalComponents = `
            SELECT
                category.custrecord_sgp_printing_prefix        AS category_code,
                category.name                                  AS category_name,
                category.custrecord_sgp_categoty_printing_seq  AS printing_seq,
                subcat.custrecord_sgp_code                     AS subcat_code,
                itm.itemid AS item_name,
                NVL(itm.purchasedescription, ' ') AS description,
                itm.id AS item,
                itm.custitem_sgp_packing AS packing,
                itm.custitem_sgp_actualstems AS actual_stems
            FROM
                item itm
            INNER JOIN
                customrecord_sgp_category category ON category.id = itm.custitem_sgp_category
            LEFT JOIN
                customrecord_sgp_subcategory subcat ON subcat.id = itm.custitem_sgp_subcategory
            WHERE
                itm.custitem_sgp_category IS NOT NULL
                AND itm.isinactive = 'F'
                AND LOWER(BUILTIN.DF(itm.custitem_sgp_category)) LIKE '%greens%'
                AND (itm.itemid IS NULL OR itm.itemid NOT LIKE '%*%')
                AND UPPER(BUILTIN.DF(itm.unitstype)) = 'CASE'
            GROUP BY
                category.custrecord_sgp_printing_prefix,
                category.name,
                category.custrecord_sgp_categoty_printing_seq,
                subcat.custrecord_sgp_code,
                itm.itemid,
                NVL(itm.purchasedescription, ' '),
                itm.id,
                itm.custitem_sgp_packing,
                itm.custitem_sgp_actualstems
        `;

        try {
            phase = '1-greens items';
            const results_gnl = runSuiteQLAll(sql_generalComponents);
            if (!results_gnl.length) {
                log.audit('GREENS.loadBomComponents', 'Sin ítems GREENS → reporte vacío.');
                return rows;
            }
            log.audit('GREENS.loadBomComponents', `Ítems GREENS: ${results_gnl.length}`);
            const greenItemIds = results_gnl.map((r) => String(r.item));

            // ── 2. Explosión hacia ABAJO de la BOM PROPIA de cada green ────
            //      Un GREEN es un ítem terminado (assembly) con su propia BOM —
            //      ya no se busca dónde el green aparece como componente de otra
            //      receta (where-used). Se parte de itemAssemblyItemBom.assembly =
            //      green y se baja: componente directo, y si ese componente es
            //      Phantom/Work Order, un nivel más (subcomponente) — mismo patrón
            //      de 2 niveles que R1 y pa_sl_bom_explosion_ui.js, pero en la
            //      dirección correcta (forward, no where-used).
            phase = '2-explosion (BOM propia del green) 2 niveles + fechas + inactivos';
            const explosionByGreen = {};   // greenId → revId → { bomId, comps: { compItemId: {code, description, quantity} } }
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
            log.audit('GREENS.loadBomComponents',
                `Fechas CURRENT del Prebook: raw=[${currentStart} - ${currentEnd}] → ISO=[${currentStartIso} - ${currentEndIso}] → ` +
                (dateWhereSql ? 'filtro SQL aplicado' : 'SIN FILTRO DE FECHA (fechas vacías o no parseables) — trae TODAS las revisiones activas'));
            let totalComponentRows = 0;
            chunkIds(greenItemIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT DISTINCT
                        iaib.assembly AS green_item_id,
                        b.id          AS bom_id,
                        br.id         AS revision_id,
                        CASE WHEN UPPER(comp.itemsource) IN ('WORK_ORDER', 'PHANTOM')
                             THEN subcomp.item ELSE comp.item END AS component_item_id,
                        CASE WHEN UPPER(comp.itemsource) IN ('WORK_ORDER', 'PHANTOM')
                             THEN subitm.itemid ELSE compitm.itemid END AS component_code,
                        CASE WHEN UPPER(comp.itemsource) IN ('WORK_ORDER', 'PHANTOM')
                             THEN NVL(subitm.purchasedescription, subitm.displayname)
                             ELSE NVL(compitm.purchasedescription, compitm.displayname) END AS component_description,
                        (NVL(comp.bomquantity, 0) * NVL(subcomp.bomquantity, 1)) AS bom_quantity
                    FROM itemAssemblyItemBom iaib
                    INNER JOIN bom b ON b.id = iaib.billofmaterials
                    INNER JOIN bomRevisionBomMap map ON map.billofmaterials = b.id
                    INNER JOIN bomRevision br ON br.id = map.bomrevision AND NVL(br.isinactive, 'F') = 'F'
                    INNER JOIN bomRevisionComponentMember comp ON comp.bomrevision = br.id
                    LEFT JOIN item compitm ON compitm.id = comp.item
                    LEFT JOIN itemAssemblyItemBom sub_iaib
                        ON sub_iaib.assembly = comp.item
                        AND UPPER(comp.itemsource) IN ('WORK_ORDER', 'PHANTOM')
                    LEFT JOIN bom sub_bom ON sub_bom.id = sub_iaib.billofmaterials
                    LEFT JOIN bomRevisionBomMap sub_map ON sub_map.billofmaterials = sub_bom.id
                    LEFT JOIN bomRevision sub_bomRev ON sub_bomRev.id = sub_map.bomrevision AND NVL(sub_bomRev.isinactive, 'F') = 'F'
                    LEFT JOIN bomRevisionComponentMember subcomp ON subcomp.bomrevision = sub_bomRev.id
                    LEFT JOIN item subitm ON subitm.id = subcomp.item
                    WHERE iaib.assembly IN (${inList})
                      AND NVL(b.isinactive, 'F') = 'F'
                      AND (b.name IS NULL OR b.name NOT LIKE '%*%')
                      AND (br.name IS NULL OR br.name NOT LIKE '%*%')
                      AND (
                            (UPPER(comp.itemsource) IN ('WORK_ORDER', 'PHANTOM') AND subcomp.item IS NOT NULL)
                            OR
                            (UPPER(comp.itemsource) NOT IN ('WORK_ORDER', 'PHANTOM'))
                          )
                      ${dateWhereSql}
                    ORDER BY iaib.assembly ASC
                `, dateParams).forEach((r) => {
                    totalComponentRows++;
                    const greenId = String(r.green_item_id);
                    const revId = String(r.revision_id);
                    const compId = String(r.component_item_id);
                    if (!explosionByGreen[greenId]) explosionByGreen[greenId] = {};
                    if (!explosionByGreen[greenId][revId]) {
                        explosionByGreen[greenId][revId] = { bomId: String(r.bom_id), comps: {} };
                    }
                    const comps = explosionByGreen[greenId][revId].comps;
                    if (!comps[compId]) {
                        comps[compId] = { code: r.component_code || '', description: r.component_description || '', quantity: 0 };
                    }
                    // Suma (no sobrescribe): el mismo subcomponente puede llegar por más de
                    // una línea/ruta dentro de la misma revisión (directo + phantom).
                    comps[compId].quantity += (Number(r.bom_quantity) || 0);
                });
            });
            log.audit('GREENS.loadBomComponents',
                `Fase 2: explosión filas=${totalComponentRows}, greens con BOM propia vigente=${Object.keys(explosionByGreen).length} de ${greenItemIds.length}`);
            if (!Object.keys(explosionByGreen).length) {
                log.audit('GREENS.loadBomComponents',
                    'Fase 2: SIN resultados — ningún green tiene su propia BOM vigente (activa, sin "*", dentro del rango CURRENT). STEMS/BUNCHES/CASES NEEDED quedarán en 0 para todos.');
            }

            // ── 5. Proyecciones del Prebook por GREEN ───────────────────────
            //      Mismo patrón que fase 5 de R1 (customrecord_sgp_prebook_projection_rp),
            //      pero buscando directamente por el green: acá el green YA es el
            //      producto terminado (ver corrección de dirección del 2026-07-30),
            //      no hace falta resolver un "producto terminado" aparte como en R1.
            //      STEMS NEEDED se multiplica por esta proyección en fase 9 — sin
            //      proyección, el green no se muestra (mismo criterio que TOTAL UNITS=0
            //      en R1).
            phase = '5-proyecciones prebook (por green)';
            const projectedQtyByGreen = {};
            chunkIds(greenItemIds, 1000).forEach((inList) => {
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
                    projectedQtyByGreen[String(r.item_id)] = Number(r.total_qty) || 0;
                });
            });
            log.audit('GREENS.loadBomComponents',
                `Fase 5: proyecciones obtenidas para ${Object.keys(projectedQtyByGreen).length} de ${greenItemIds.length} greens (custrecord_sgp_prebook_id_detail=${prebookId}).`);
            if (!Object.keys(projectedQtyByGreen).length) {
                log.audit('GREENS.loadBomComponents',
                    'Fase 5: SIN proyecciones — revisar customrecord_sgp_prebook_projection_rp.custrecord_sgp_prebook_id_detail=' + prebookId + ' con líneas activas para estos greens. STEMS/BUNCHES/CASES NEEDED quedarán en 0 para todos.');
            }

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
                      AND tl.location = ${Number(LOC1_ID)}
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
                `Fase 6: líneas de PO (type=PurchOrd, location=LOC1) filas=${totalPoRows}, greens con PO=${Object.keys(poByItem).length} de ${greenItemIds.length} (custbody_sgp_report_id=${prebookId})`);
            if (greenItemIds.length && !totalPoRows) {
                log.audit('GREENS.loadBomComponents',
                    'Fase 6: 0 filas de PO — revisar que existan Purchase Orders con custbody_sgp_report_id=' + prebookId + '.');
            }

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

            phase = '9-armado filas';
            let itemsNoRevData = 0, itemsNoProjection = 0;
            let itemsWithStems = 0, itemsWithOnHand = 0, itemsWithPoReceived = 0, itemsWithPrep = 0;
            results_gnl.forEach((r) => {
                const itemId = String(r.item);
                const packing = Number(r.packing) || 0;
                const actualStems = Number(r.actual_stems) || 0;

                const revMap = explosionByGreen[itemId] || {};
                const revIds = Object.keys(revMap);
                if (!revIds.length) itemsNoRevData++;
                if (!projectedQtyByGreen[itemId]) itemsNoProjection++;

                // Dedup: 1 mejor revisión (la de ID más alto) por cada BOM propia del
                // green que calificó — normalmente un green tiene una sola BOM, pero
                // se soporta más de una por seguridad (igual patrón que R1).
                const bestRevByBom = {};
                revIds.forEach((revId) => {
                    const bomId = revMap[revId].bomId;
                    const current = bestRevByBom[bomId];
                    if (!current || Number(revId) > Number(current.revId)) {
                        bestRevByBom[bomId] = { revId: revId, comps: revMap[revId].comps };
                    }
                });

                // Subcomponentes REALES (materiales) que arman este green, fusionados
                // entre todas las BOM "mejores" (normalmente 1 sola) — ya no son
                // recetas/clientes (eso era para la dirección where-used anterior).
                const compTotals = {};
                Object.keys(bestRevByBom).forEach((bomId) => {
                    const comps = bestRevByBom[bomId].comps;
                    Object.keys(comps).forEach((compId) => {
                        if (!compTotals[compId]) {
                            compTotals[compId] = { code: comps[compId].code, description: comps[compId].description, quantity: 0 };
                        }
                        compTotals[compId].quantity += comps[compId].quantity;
                    });
                });

                // Proyección del Prebook para ESTE green (fase 5) — mismo criterio que
                // R1: MRP en cascada, projectedQty del producto terminado × bomQuantity
                // del componente. Sin proyección → 0 (el ítem no se muestra, ver filtro
                // de stemsNeeded más abajo).
                const projectedQty = projectedQtyByGreen[itemId] || 0;

                // SUBTOTAL (columna de auditoría, "Show audit"): la cascada del BOM
                // ANTES de multiplicar por la proyección — mismo número que stemsNeeded
                // representaba antes de esta sesión, cuando aún no existía fase 5.
                // SUBTOTAL * SOLD (projectedQty) === STEMS NEEDED, siempre.
                const subtotal = Object.keys(compTotals)
                    .reduce((sum, compId) => sum + (compTotals[compId].quantity || 0), 0);

                const components = Object.keys(compTotals).map((compId) => ({
                    componentItemId: compId,
                    componentCode: compTotals[compId].code,
                    componentDescription: compTotals[compId].description,
                    // Cantidad de este subcomponente YA multiplicada por la proyección,
                    // para que sumar components[].quantity siga reconstruyendo STEMS NEEDED.
                    quantity: compTotals[compId].quantity * projectedQty
                })).sort((a, b) => b.quantity - a.quantity);

                // STEMS NEEDED = suma de las cantidades de todos los subcomponentes
                // (cada una ya multiplicada por la proyección del green).
                const stemsNeeded = components.reduce((sum, c) => sum + (c.quantity || 0), 0);

                const bunchesNeeded = actualStems > 0 ? Math.ceil(stemsNeeded / actualStems) : 0;
                const casesNeededCount = packing > 0 ? Math.ceil(bunchesNeeded / packing) : 0;
                const casesNeeded = packing > 0 ? `${casesNeededCount}X${packing}` : String(casesNeededCount);

                const po = poByItem[itemId] || { po_quantity: 0, po_received: 0 };
                const qtyOnHand = invByItem[itemId] || 0;
                const poReceived = po.po_received;
                const inBound = po.po_quantity - po.po_received;
                const unitprepcomp = prepByItem[itemId] || 0;

                const supply = qtyOnHand + poReceived + inBound;
                const diff = supply - casesNeededCount;
                const fmtCasePack = (n) => (packing > 0 ? `${n}X${packing}` : String(n));
                const casesShort = diff < 0 ? fmtCasePack(Math.abs(diff)) : '';
                const casesOver = diff > 0 ? fmtCasePack(diff) : '';

                const pkstm = (packing || actualStems) ? `${packing}/${actualStems}` : '';

                if (stemsNeeded > 0) itemsWithStems++;
                if (qtyOnHand > 0) itemsWithOnHand++;
                if (poReceived > 0) itemsWithPoReceived++;
                if (unitprepcomp > 0) itemsWithPrep++;

                if (stemsNeeded === 0 && bunchesNeeded === 0) return;

                const catCode = r.category_code || r.category_name || '';
                const subcatCode = safeStr(r.subcat_code);
                rows.push({
                    cat: [catCode, subcatCode].filter((v) => v !== '').join(' '),
                    subcatCode: subcatCode,
                    printingSeq: isEmptyValue(r.printing_seq) ? Number.MAX_SAFE_INTEGER : Number(r.printing_seq),
                    productCode: r.item_name || '',
                    description: r.description || '',
                    pkstm: pkstm,
                    // SOLD (columna de auditoría, "Show audit"): la proyección del
                    // Prebook para este green — el multiplicador que se aplicó a la cascada
                    // del BOM para llegar a stemsNeeded (ver fase 5).
                    soldBunches: projectedQty,
                    // SUBTOTAL (columna de auditoría, "Show audit"): la cascada del BOM
                    // antes de multiplicar por soldBunches — subtotal * soldBunches === stemsNeeded.
                    subtotal: subtotal,
                    stemsNeeded: stemsNeeded,
                    // Desglose por subcomponente (material real) que compone stemsNeeded.
                    components: components,
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

            rows.sort((a, b) => {
                if (a.printingSeq !== b.printingSeq) return a.printingSeq - b.printingSeq;
                const sc = compareSubcat(a.subcatCode, b.subcatCode);
                if (sc !== 0) return sc;
                return String(a.description || '').localeCompare(String(b.description || ''));
            });

            log.audit('GREENS.loadBomComponents',
                `Fase 9 resumen: ${results_gnl.length} greens · sin BOM propia vigente=${itemsNoRevData} · sin proyección=${itemsNoProjection}`);
            log.audit('GREENS.loadBomComponents',
                `Fase 9 columnas >0: STEMS NEEDED=${itemsWithStems} · QUANTITY ONHAND=${itemsWithOnHand} · ` +
                `PO RECVD=${itemsWithPoReceived} · UNIT PREP COMP=${itemsWithPrep} (de ${results_gnl.length} greens)`);
            log.audit('GREENS.loadBomComponents', `Filas generadas: ${rows.length}`);
        } catch (e) {
            log.error('GREENS.loadBomComponents', `Fallo en fase [${phase}]: ${e.message} | ${e.stack}`);
        }
        return rows;
    };

    const nowStamp = () => {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    };

    const nowDisplayStamp = () => {
        const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    const isEmptyValue = (v) => {
        if (v === null || v === undefined || v === '') return true;
        if (typeof v === 'object') {
            return /NullObjectAdapter/i.test(String(v));
        }
        return false;
    };

    const safeStr = (v) => (isEmptyValue(v) ? '' : String(v));

    const compareSubcat = (a, b) => {
        const sa = safeStr(a);
        const sb = safeStr(b);
        const na = Number(sa);
        const nb = Number(sb);
        const aIsNum = sa !== '' && !isNaN(na);
        const bIsNum = sb !== '' && !isNaN(nb);
        if (aIsNum && bIsNum) return na - nb;
        return sa.localeCompare(sb);
    };

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

    const toIsoDateStr = (d) => {
        if (!d) return null;
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

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

    const chunkIds = (ids, size) => {
        const out = [];
        for (let i = 0; i < ids.length; i += size) {
            const inList = ids.slice(i, i + size)
                .map((x) => Number(x)).filter((n) => !isNaN(n)).join(', ');
            if (inList) out.push(inList);
        }
        return out;
    };

    const buildEmptyResponse = (format, prebookId, preebookData) => {
        const headers = ['CAT', 'PRODUCT CODE', 'PRODUCT DESCRIPTION', 'PACK PK/STM', 'STEMS NEEDED',
            'BUNCHES NEEDED', 'CASES NEEDED', 'QUANTITY ONHAND', 'UNIT PREP COMP', 'PO RECVD LOC1',
            'IN BOUND LOC1', 'CASES SHORT LOC1', 'CASES OVER LOC1'];
        if (String(format).toUpperCase() === 'PDF') {
            return { fileObj: crearPDF(headers, [], `Greens_Projection_${prebookId}_${nowStamp()}.pdf`, prebookId, preebookData), contentType: 'PDF', filename: `Greens_Projection_${prebookId}.pdf` };
        }
        return { fileObj: crearExcel(headers, [], `Greens_Projection_${prebookId}_${nowStamp()}.xlsx`, prebookId, preebookData), contentType: 'application/vnd.ms-excel', filename: `Greens_Projection_${prebookId}.xls` };
    };

    return {
        getMetadata,
        getFilterDefinitions,
        validateFilters,
        generate,
        getPreviewData
    };
});

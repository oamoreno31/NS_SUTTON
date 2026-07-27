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
                `ALL SUB CATS - History: ${historicalStart} - ${historicalEnd}  RELATING TO Current: ${currentStart} - ${currentEnd}`
            ],
            headers: headers,
            rows: flatRows,
            rowCount: rows.length
        };
    };

    const crearExcel = (headers, rows, fileName, prebookId, preebookData) => {
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
                        currentEnd: safeStr(preebookData?.custrecord_sgp_pb_currency_end_date),
                        loc1Label: LOC1_LABEL,
                        generatedAt: nowStamp(),
                        generatedAtDisplay: nowDisplayStamp(),
                        totalRows: rows.length
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

            phase = '2-explosion 2 niveles + fechas + inactivos';
            const revisionDataByItem = {};
            const bomIdByRevision = {};
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
            log.audit('GREENS.loadBomComponents',
                `Fechas CURRENT del Prebook: raw=[${currentStart} - ${currentEnd}] → ISO=[${currentStartIso} - ${currentEndIso}] → ` +
                (dateWhereSql ? 'filtro SQL aplicado' : 'SIN FILTRO DE FECHA (fechas vacías o no parseables) — trae TODAS las revisiones activas'));
            let totalComponentRows = 0;
            chunkIds(greenItemIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT DISTINCT
                        b.id   AS bom_id,
                        br.id  AS revision_id,
                        CASE WHEN UPPER(comp.itemsource) IN ('WORK_ORDER', 'PHANTOM')
                             THEN subcomp.item ELSE comp.item END AS item_id,
                        (NVL(comp.bomquantity, 1) * NVL(subcomp.bomquantity, 1)) AS bom_quantity
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
                    ORDER BY b.id ASC
                `, dateParams).forEach((r) => {
                    totalComponentRows++;
                    const itemId = String(r.item_id);
                    const revId = String(r.revision_id);
                    if (!revisionDataByItem[itemId]) revisionDataByItem[itemId] = {};
                    revisionDataByItem[itemId][revId] =
                        (revisionDataByItem[itemId][revId] || 0) + (Number(r.bom_quantity) || 0);
                    bomIdByRevision[revId] = String(r.bom_id);
                    bomIdSet[String(r.bom_id)] = true;
                });
            });
            log.audit('GREENS.loadBomComponents',
                `Fase 2: explosión filas=${totalComponentRows}, greens con >=1 receta=${Object.keys(revisionDataByItem).length} de ${greenItemIds.length}, BOMs distintos=${Object.keys(bomIdSet).length}`);
            if (!Object.keys(revisionDataByItem).length) {
                log.audit('GREENS.loadBomComponents',
                    'Fase 2: SIN resultados — ningún green aparece (directo o vía phantom/WO) como componente de ninguna receta vigente. STEMS/BUNCHES/CASES NEEDED quedarán en 0 para todos.');
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
            let itemsNoRevData = 0, skipsNoBomId = 0;
            let itemsWithStems = 0, itemsWithOnHand = 0, itemsWithPoReceived = 0, itemsWithPrep = 0;
            results_gnl.forEach((r) => {
                const itemId = String(r.item);
                const packing = Number(r.packing) || 0;
                const actualStems = Number(r.actual_stems) || 0;

                const revData = revisionDataByItem[itemId] || {};
                if (!Object.keys(revData).length) itemsNoRevData++;

                const bestRevByBom = {};
                Object.keys(revData).forEach((revId) => {
                    const bomId = bomIdByRevision[revId];
                    if (!bomId) { skipsNoBomId++; return; }
                    const current = bestRevByBom[bomId];
                    if (!current || Number(revId) > Number(current.revId)) {
                        bestRevByBom[bomId] = { revId: revId, bomquantity: revData[revId] };
                    }
                });
                const stemsNeeded = Object.keys(bestRevByBom)
                    .reduce((sum, bomId) => sum + (bestRevByBom[bomId].bomquantity || 0), 0);

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

                const catCode = r.category_code || r.category_name || '';
                const subcatCode = safeStr(r.subcat_code);
                rows.push({
                    cat: [catCode, subcatCode].filter((v) => v !== '').join(' '),
                    subcatCode: subcatCode,
                    printingSeq: isEmptyValue(r.printing_seq) ? Number.MAX_SAFE_INTEGER : Number(r.printing_seq),
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

            rows.sort((a, b) => {
                if (a.printingSeq !== b.printingSeq) return a.printingSeq - b.printingSeq;
                const sc = String(a.subcatCode || '').localeCompare(String(b.subcatCode || ''));
                if (sc !== 0) return sc;
                return String(a.productCode).localeCompare(String(b.productCode));
            });

            log.audit('GREENS.loadBomComponents',
                `Fase 9 resumen: ${results_gnl.length} greens · sin recetas vigentes=${itemsNoRevData} · ` +
                `saltos por bomId no resuelto=${skipsNoBomId}`);
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

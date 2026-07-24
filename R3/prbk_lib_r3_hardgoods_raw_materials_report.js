/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * R3 — ALL RAW MATERIALS PROJECTION REPORT (HARDGOODS)
 * Hermano de prbk_lib_r2_greens_projection_report.js: misma arquitectura y
 * mismas fórmulas (explosión 2 niveles, sin proyección de demanda, LOC1
 * únicamente), pero filtrando ítems HARDGOODS (igual que R1) en vez de GREENS,
 * columna "UNITS NEEDED" en vez de "STEMS NEEDED", y TRES vistas del mismo
 * dataset: MAIN (plana, sort Vendor → Subcategory → Product Code), CATEGORY
 * (agrupada por CAT) y VENDOR (agrupada por Vendor) — las 3 descargables en
 * Excel/PDF y las 3 disponibles como pestañas en el preview embebido.
 *
 * Columnas (orden del reporte impreso, igual en las 3 vistas):
 *   CAT | PRODUCT CODE | PRODUCT DESCRIPTION | PACK PK/STM | UNITS NEEDED |
 *   BUNCHES NEEDED | CASES NEEDED | QUANTITY ONHAND | UNIT PREP COMP |
 *   PO RECVD LOC1 | IN BOUND LOC1 | CASES SHORT LOC1 | CASES OVER LOC1
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
    const HG_TEMPLATE_FILENAME = 'prbk_custtmpl_r3_hardgoods_raw_materials_report.ftl';

    // Límite real de file.create en NetSuite es 10 MB; dejamos margen.
    const MAX_XLS_BYTES = 9.8 * 1024 * 1024;

    // Vistas soportadas (preview + descarga).
    const VIEW_MAIN = 'MAIN';
    const VIEW_CATEGORY = 'CATEGORY';
    const VIEW_VENDOR = 'VENDOR';

    // Orden de columnas confirmado contra el PDF de referencia (WO720.RH by
    // vendor, 2026-07-24): QUANTY ONHAND, PO RECVD, UNITS PREP COMP, IN BOUND
    // (antes teníamos PO RECVD después de UNIT PREP COMP — corregido).
    const HEADERS = ['CAT', 'PRODUCT CODE', 'PRODUCT DESCRIPTION', 'PACK PKxSTM', 'UNITS NEEDED',
        'BUNCHES NEEDED', 'CASES NEEDED', 'QUANTITY ONHAND', 'PO RECVD LOC1', 'UNIT PREP COMP',
        'IN BOUND LOC1', 'CASES SHORT LOC1', 'CASES OVER LOC1'];

    // Etiqueta para filas/vendors/categorías sin dato (blank ordena primero, igual que el PDF de referencia).
    const BLANK_LABEL = '/';

    // =========================================================================
    // 1. METADATA
    // =========================================================================

    const getMetadata = () => ({
        id: 'HARDGOODS_RM_PROJECTION',
        name: 'All Raw Materials Projection - Hardgoods',
        description: 'Hardgoods raw material projection per item: units/bunches/cases needed, ' +
            'beginning inventory, POs received, inbound, and case short/over. 3 views: Main, ' +
            'by Category and by Vendor.',
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
        },
        {
            id: 'view',
            label: 'View',
            type: 'select',
            mandatory: false,
            defaultValue: VIEW_MAIN,
            options: [
                { value: VIEW_MAIN, text: 'Main' },
                { value: VIEW_CATEGORY, text: 'By Category' },
                { value: VIEW_VENDOR, text: 'By Vendor' }
            ],
            helpText: 'Report layout: flat (Main), grouped by Category, or grouped by Vendor.',
            // previewChoice también: el preview la setea sola según la pestaña
            // activa al hacer clic en Download (ver prbk_sl_reports_shell.js).
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
        const view = String(values.view || VIEW_MAIN).toUpperCase();
        if ([VIEW_MAIN, VIEW_CATEGORY, VIEW_VENDOR].indexOf(view) === -1) {
            return { valid: false, message: 'Invalid view. Use Main, Category or Vendor.' };
        }
        return { valid: true };
    };

    // =========================================================================
    // 4. GENERATE
    // =========================================================================

    /**
     * @param {Object} filterValues - .prebook, .output_format, .view (MAIN|CATEGORY|VENDOR)
     * @returns {Object} { fileObj, contentType, filename }
     */
    const generate = (filterValues) => {
        const prebookId = String(filterValues.prebook);
        const format = String(filterValues.output_format || 'EXCEL').toUpperCase();
        const view = String(filterValues.view || VIEW_MAIN).toUpperCase();
        log.audit('HG_RM.generate', `prebook=${prebookId}  format=${format}  view=${view}`);

        const preebookData = loadPrebookHeader(prebookId);
        const rows = loadHardgoodsRawMaterials(prebookId, preebookData.currentStart, preebookData.currentEnd);
        log.audit('HG_RM.rows', `count=${rows.length}`);

        const payload = buildViewPayload(view, rows);
        const baseName = `HG_RawMaterials_${view}_${String(preebookData.name || prebookId).replace(/\s+/g, '_')}_${nowStamp()}`;

        if (format === 'PDF') {
            const reportPdf = crearPDF(payload, `${baseName}.pdf`, prebookId, preebookData);
            return { fileObj: reportPdf, contentType: 'PDF', filename: `${baseName}.pdf` };
        }

        const reportExcel = crearExcel(payload, `${baseName}.xlsx`, prebookId, preebookData);
        return { fileObj: reportExcel, contentType: 'application/vnd.ms-excel', filename: `${baseName}.xls` };
    };

    // =========================================================================
    // 4b. GET PREVIEW DATA — 3 pestañas (views) con el mismo dataset, cada una
    //     con su propio orden/agrupación. No genera archivo.
    // =========================================================================

    /**
     * @param {Object} filterValues - .prebook (output_format/view se eligen en el preview)
     * @returns {Object} { title, prebookName, metaLines, views: [{id,label,headers,rows,rowCount}] }
     */
    const getPreviewData = (filterValues) => {
        const prebookId = String(filterValues.prebook);
        log.audit('HG_RM.getPreviewData', `prebook=${prebookId}`);

        const preebookData = loadPrebookHeader(prebookId);
        const rows = loadHardgoodsRawMaterials(prebookId, preebookData.currentStart, preebookData.currentEnd);

        const metaLines = [
            `WO720.RH # ${prebookId} — ALL RAW MATERIALS PROJECTION REPORT FOR ALL RECIPES`,
            `PREPARED FOR: ${preebookData.name}`,
            `ALL SUB CATS - History: ${preebookData.historicalStart} - ${preebookData.historicalEnd}  RELATING TO Current: ${preebookData.currentStart} - ${preebookData.currentEnd}`
        ];

        return {
            title: 'All Raw Materials Projection - Hardgoods',
            prebookName: preebookData.name || prebookId,
            metaLines: metaLines,
            views: [
                {
                    id: VIEW_MAIN,
                    label: 'Main',
                    headers: HEADERS,
                    rows: toFlatPreviewRows(sortMain(rows.slice())),
                    rowCount: rows.length
                },
                {
                    id: VIEW_CATEGORY,
                    label: 'By Category',
                    headers: HEADERS,
                    rows: groupedToPreviewRows(groupByCategory(rows)),
                    rowCount: rows.length
                },
                {
                    id: VIEW_VENDOR,
                    label: 'By Vendor',
                    headers: HEADERS,
                    rows: groupedToPreviewRows(groupByVendor(rows)),
                    rowCount: rows.length
                }
            ]
        };
    };

    /** Header del Prebook, ya sanitizado con safeStr (blinda contra ScriptNullObjectAdapter). */
    const loadPrebookHeader = (prebookId) => {
        const raw = search.lookupFields({
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
        return {
            name: safeStr(raw?.name),
            historicalStart: safeStr(raw?.custrecord_sgp_pb_historical_start_date),
            historicalEnd: safeStr(raw?.custrecord_sgp_pb_historical_end_date),
            currentStart: safeStr(raw?.custrecord_sgp_pb_current_start_date),
            currentEnd: safeStr(raw?.custrecord_sgp_pb_currency_end_date)
        };
    };

    // =========================================================================
    // 4c. VIEW PAYLOAD — arma la estructura que consumen crearExcel/crearPDF.
    //     MAIN: { view, flat: [...] }   CATEGORY/VENDOR: { view, groups: [{label, rows}] }
    // =========================================================================

    const buildViewPayload = (view, rows) => {
        if (view === VIEW_CATEGORY) {
            return { view: VIEW_CATEGORY, groups: groupByCategory(rows) };
        }
        if (view === VIEW_VENDOR) {
            return { view: VIEW_VENDOR, groups: groupByVendor(rows) };
        }
        return { view: VIEW_MAIN, flat: sortMain(rows.slice()) };
    };

    /** Sort de la vista MAIN: Vendor → Subcategory → Product Code (alfabético, los 3 ascendentes). */
    const sortMain = (rows) => rows.sort((a, b) => {
        const v = String(a.vendor || '').localeCompare(String(b.vendor || ''));
        if (v !== 0) return v;
        const s = String(a.subcategory || '').localeCompare(String(b.subcategory || ''));
        if (s !== 0) return s;
        return String(a.productCode || '').localeCompare(String(b.productCode || ''));
    });

    /** Agrupa por CAT (orden de grupo: category_printing_seq asc, empate alfabético; dentro de cada grupo, Product Code asc). */
    const groupByCategory = (rows) => {
        const byLabel = {};
        rows.forEach((r) => {
            const label = r.cat || BLANK_LABEL;
            if (!byLabel[label]) byLabel[label] = { label: label, seq: r.printingSeq, rows: [] };
            byLabel[label].rows.push(r);
        });
        const groups = Object.keys(byLabel).map((k) => byLabel[k]);
        groups.forEach((g) => g.rows.sort((a, b) => String(a.productCode || '').localeCompare(String(b.productCode || ''))));
        groups.sort((a, b) => {
            const seqA = a.seq == null ? Number.MAX_SAFE_INTEGER : a.seq;
            const seqB = b.seq == null ? Number.MAX_SAFE_INTEGER : b.seq;
            if (seqA !== seqB) return seqA - seqB;
            return String(a.label).localeCompare(String(b.label));
        });
        return groups;
    };

    /**
     * Agrupa por Vendor. Orden confirmado por Omar (2026-07-24): Vendor
     * (grupo, alfabético A-Z, blank primero) → Product Code (A-Z) →
     * Subcategory (custitem_sgp_subcategory, como desempate final).
     */
    const groupByVendor = (rows) => {
        const byLabel = {};
        rows.forEach((r) => {
            const label = r.vendor || BLANK_LABEL;
            if (!byLabel[label]) byLabel[label] = { label: label, rows: [] };
            byLabel[label].rows.push(r);
        });
        const groups = Object.keys(byLabel).map((k) => byLabel[k]);
        groups.forEach((g) => g.rows.sort((a, b) => {
            const p = String(a.productCode || '').localeCompare(String(b.productCode || ''));
            if (p !== 0) return p;
            return String(a.subcategory || '').localeCompare(String(b.subcategory || ''));
        }));
        groups.sort((a, b) => String(a.label).localeCompare(String(b.label)));
        return groups;
    };

    /** Fila plana en el mismo orden de columnas que HEADERS. */
    const rowToCells = (r) => ([
        safeStr(r.cat), safeStr(r.productCode), safeStr(r.description), safeStr(r.pkstm),
        String(r.unitsNeeded || 0), String(r.bunchesNeeded || 0), String(r.casesNeeded || 0),
        String(r.qtyOnHand || 0), String(r.poReceived || 0), String(r.unitprepcomp || 0),
        String(r.inBound || 0),
        (r.casesShort === '' || r.casesShort == null ? '' : String(r.casesShort)),
        (r.casesOver === '' || r.casesOver == null ? '' : String(r.casesOver))
    ]);

    const toFlatPreviewRows = (rows) => rows.map(rowToCells);

    // Marcador que el shell (prbk_sl_reports_shell.js) reconoce para pintar una
    // fila de sección colapsable (colspan, toggle, conteo de items) en vez de
    // una fila de datos normal. Formato: SECTION_MARKER + label + COUNT_MARKER + n.
    // Ver buildTabbedPreviewFragment / SECTION_MARKER / COUNT_MARKER en el shell.
    const SECTION_MARKER = '§SECTION§';
    const COUNT_MARKER = '§N§';

    /** Convierte grupos a filas planas para el preview: 1 fila-título (marcador de sección + conteo) + sus filas. */
    const groupedToPreviewRows = (groups) => {
        const out = [];
        groups.forEach((g) => {
            out.push([SECTION_MARKER + g.label + COUNT_MARKER + g.rows.length].concat(new Array(HEADERS.length - 1).fill('')));
            g.rows.forEach((r) => out.push(rowToCells(r)));
        });
        return out;
    };

    // =========================================================================
    // 5. EXCEL
    // =========================================================================

    const crearExcel = (payload, fileName, prebookId, preebookData) => {
        try {
            const escapeXml = (v) => isEmptyValue(v) ? '' :
                String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const EMPTY = '<Cell/>';
            const strCell = (v) => `<Cell><Data ss:Type="String">${escapeXml(v)}</Data></Cell>`;
            const sectionCell = (v) => `<Cell ss:StyleID="sSection"><Data ss:Type="String">${escapeXml(v)}</Data></Cell>`;

            const hist = `History: ${escapeXml(preebookData.historicalStart)} - ${escapeXml(preebookData.historicalEnd)}`;
            const curr = `Current: ${escapeXml(preebookData.currentStart)} - ${escapeXml(preebookData.currentEnd)}`;
            const viewLabel = payload.view === VIEW_CATEGORY ? 'BY CATEGORY' : (payload.view === VIEW_VENDOR ? 'BY VENDOR' : 'MAIN');

            const totalDataRows = payload.view === VIEW_MAIN
                ? payload.flat.length
                : payload.groups.reduce((sum, g) => sum + g.rows.length + 1, 0);

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
                '<Style ss:ID="sSection">\n' +
                '<Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="11" ss:Bold="1" ss:Color="#000000"/>\n' +
                '<Interior ss:Color="#EEEEEE" ss:Pattern="Solid"/>\n' +
                '</Style>\n' +
                '</Styles>\n' +
                '<Worksheet ss:Name="Hoja1">\n' +
                '<Table ss:ExpandedColumnCount="' + (HEADERS.length + 2) + '" ss:ExpandedRowCount="' + (totalDataRows + 100) + '" x:FullColumns="1"\n' +
                'x:FullRows="1" ss:DefaultRowHeight="14.4">\n' +
                '<Column ss:Width="35"/>\n' +     // CAT
                '<Column ss:Width="60"/>\n' +     // PRODUCT CODE
                '<Column ss:Width="160"/>\n' +    // PRODUCT DESCRIPTION
                '<Column ss:Width="55"/>\n' +     // PACK PKxSTM
                '<Column ss:Width="60"/>\n' +     // UNITS NEEDED
                '<Column ss:Width="65"/>\n' +     // BUNCHES NEEDED
                '<Column ss:Width="60"/>\n' +     // CASES NEEDED
                '<Column ss:Width="65"/>\n' +     // QUANTITY ONHAND
                '<Column ss:Width="55"/>\n' +     // PO RECVD LOC1
                '<Column ss:Width="55"/>\n' +     // UNIT PREP COMP
                '<Column ss:Width="55"/>\n' +     // IN BOUND LOC1
                '<Column ss:Width="60"/>\n' +     // CASES SHORT LOC1
                '<Column ss:Width="60"/>\n' +     // CASES OVER LOC1
                '<Row>\n' +
                '<Cell ss:StyleID="sPlain"><Data ss:Type="String">WO720.RH   # ' + escapeXml(prebookId) + '   ALL RAW MATERIALS PROJECTION REPORT FOR ALL RECIPES</Data></Cell>\n' +
                '</Row>\n' +
                '<Row>\n' +
                '<Cell ss:StyleID="sPlain"><Data ss:Type="String">PREPARED FOR: ' + escapeXml(preebookData.name) + '</Data></Cell>\n' +
                '</Row>\n' +
                '<Row>\n' +
                '<Cell ss:StyleID="sPlain"><Data ss:Type="String">ALL SUB CATS   - ' + escapeXml(hist) + '   RELATING TO ' + escapeXml(curr) + '   VIEW: ' + escapeXml(viewLabel) + '</Data></Cell>\n' +
                '</Row>\n';

            xmlString += '<Row>\n';
            HEADERS.forEach(header => { xmlString += strCell(header); });
            xmlString += '</Row>\n';

            const writeRow = (r) => {
                xmlString += '<Row>';
                xmlString += strCell(r.cat);
                xmlString += strCell(r.productCode);
                xmlString += strCell(r.description);
                xmlString += strCell(r.pkstm);
                xmlString += strCell(r.unitsNeeded);
                xmlString += strCell(r.bunchesNeeded);
                xmlString += strCell(r.casesNeeded);
                xmlString += strCell(r.qtyOnHand);
                xmlString += strCell(r.poReceived);
                xmlString += strCell(r.unitprepcomp);
                xmlString += strCell(r.inBound);
                xmlString += strCell(r.casesShort);
                xmlString += strCell(r.casesOver);
                xmlString += '</Row>\n';
            };

            if (payload.view === VIEW_MAIN) {
                payload.flat.forEach(writeRow);
            } else {
                payload.groups.forEach((g) => {
                    // Sin espacio tras ':' y sin mostrar el label si es BLANK_LABEL ('/') —
                    // igual que el PDF de referencia ("Vendor:" solo, "Vendor:25112" con datos).
                    const prefix = payload.view === VIEW_CATEGORY ? 'Category:' : 'Vendor:';
                    const shownLabel = g.label === BLANK_LABEL ? '' : g.label;
                    const label = prefix + shownLabel +
                        ` (${g.rows.length} item${g.rows.length === 1 ? '' : 's'})`;
                    xmlString += '<Row>' + sectionCell(label) +
                        new Array(HEADERS.length - 1).fill('<Cell ss:StyleID="sSection"/>').join('') + '</Row>\n';
                    g.rows.forEach(writeRow);
                });
            }

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
            log.error('HG_RM.crearExcel', `Error al crear Excel: ${error.message}`);
            throw error;
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

    /** Genera el PDF desde la plantilla FTL. La FTL branchea por data.metadata.view (MAIN plana / CATEGORY,VENDOR agrupadas por data.groups). */
    const crearPDF = (payload, fileName, prebookId, preebookData) => {
        try {
            const templateFileId = findTemplateFileId(HG_TEMPLATE_FILENAME);
            if (!templateFileId) {
                throw new Error(`Template '${HG_TEMPLATE_FILENAME}' not found in the File Cabinet.`);
            }

            const templateFile = file.load({ id: templateFileId });

            const renderer = render.create();
            renderer.templateContent = templateFile.getContents();

            const preBookObj = record.load({
                type: 'customrecord_sgp_prebook',
                id: prebookId
            });
            renderer.addRecord({ templateName: 'record', record: preBookObj });

            const dataForPdf = {
                headers: HEADERS,
                metadata: {
                    prebookId: prebookId,
                    prebookName: preebookData.name,
                    historicalStart: preebookData.historicalStart,
                    historicalEnd: preebookData.historicalEnd,
                    currentStart: preebookData.currentStart,
                    currentEnd: preebookData.currentEnd,
                    loc1Label: LOC1_LABEL,
                    view: payload.view,
                    generatedAt: nowStamp(),
                    generatedAtDisplay: nowDisplayStamp(),
                    totalRows: payload.view === VIEW_MAIN
                        ? payload.flat.length
                        : payload.groups.reduce((sum, g) => sum + g.rows.length, 0)
                }
            };
            if (payload.view === VIEW_MAIN) {
                dataForPdf.report = payload.flat;
            } else {
                dataForPdf.groups = payload.groups;
            }

            renderer.addCustomDataSource({
                format: render.DataSource.JSON,
                alias: 'data',
                data: JSON.stringify(dataForPdf)
            });

            const pdfFile = renderer.renderAsPdf();
            pdfFile.name = fileName || 'export_netSuite.pdf';
            return pdfFile;
        } catch (error) {
            log.error('HG_RM.crearPDF', `Error al crear PDF: ${error.message}`);
            throw error;
        }
    };

    // =========================================================================
    // 7. DATA — loadHardgoodsRawMaterials
    // =========================================================================

    /**
     * Agrega los componentes HARDGOODS del Prebook en UNA fila por item (el
     * reporte es "para todas las recetas": se suman las apariciones del item en
     * todas las BOM Revisions vigentes), usando la MISMA lógica de explosión de
     * 2 niveles que R1/R2/pa_sl_bom_explosion_ui.js (ver fase 2), y las MISMAS
     * fórmulas que R2 (sin proyección de demanda, LOC1 únicamente).
     *
     * Mapeo de columnas → fuente:
     *   Filtro de ítems ← mismo criterio que R1: customrecord_cseg_sgp_prod_cat
     *     con name='hardgoods' (fase 1); CAT ← custitem_sgp_category.
     *     custrecord_sgp_printing_prefix (catprefix, LEFT JOIN, igual que R1).
     *   VENDOR ← item.vendorname (campo estándar "Vendor Name" del ítem).
     *   SUBCATEGORY ← item.custitem_sgp_subcategory.
     *   UNITS NEEDED  ← suma de bomquantity (2 niveles: comp × subcomp si
     *     WORK_ORDER/PHANTOM) entre todas las recetas vigentes donde el hardgood
     *     es material real, dedup a 1 revisión por BOM (mayor ID). SIN
     *     proyección de demanda (mismo criterio confirmado para R2 — a
     *     diferencia de TOTAL UNITS en R1).
     *   BUNCHES NEEDED ← UNITS NEEDED / stems-por-bunch (custitem_sgp_actualstems).
     *   CASES NEEDED   ← CEIL(BUNCHES NEEDED / packing), mostrado "NxPacking".
     *   QUANTITY ONHAND← inventario inicial del Prebook, snapshot sin ubicación.
     *   UNIT PREP COMP ← unidades de Assembly Build (type='Build') para este Prebook.
     *   PO RECVD/IN BOUND LOC1 ← de líneas de PO filtradas a LOC1_ID (fase 6).
     *   CASES SHORT/OVER LOC1  ← (onhand + recvd + inbound) vs CASES NEEDED,
     *     mismo formato "NxPacking".
     *   BOM/BomRevision (nivel 1) con '*' en el name, e ítems con '*' en el
     *     itemid, quedan excluidos (fases 1 y 2).
     *
     * Filtro de fechas: SQL-side, contra el rango CURRENT del Prebook (no
     * historical), solo nivel 1 — ver fase 2 y toIsoDateStr/parseAccountDate.
     *
     * NOTA (no confirmado con Omar): en el PDF de referencia, BUNCHES NEEDED
     * es numéricamente casi siempre igual a UNITS NEEDED, lo que sugeriría un
     * fallback de actualStems=1 (no 0) para hardgoods. Se deja igual que R2
     * (actualStems>0 ? ceil(...) : 0) hasta confirmarlo — revisar si los
     * primeros reportes reales no calzan.
     *
     * @param {string} prebookId
     * @param {string} currentStart - custrecord_sgp_pb_current_start_date
     * @param {string} currentEnd   - custrecord_sgp_pb_currency_end_date
     * @returns {Array<Object>}
     */
    const loadHardgoodsRawMaterials = (prebookId, currentStart, currentEnd) => {
        const rows = [];
        let phase = 'init';
        log.audit('HG_RM.loadHardgoodsRawMaterials',
            `INICIO prebookId=${prebookId} currentStart="${currentStart}" currentEnd="${currentEnd}"`);

        const sql_hardgoodsItems = `
            SELECT
                catprefix.custrecord_sgp_printing_prefix        AS category_code,
                cat.name                                         AS category_name,
                catprefix.custrecord_sgp_categoty_printing_seq  AS printing_seq,
                itm.itemid AS item_name,
                NVL(itm.purchasedescription, ' ') AS description,
                itm.id AS item,
                itm.custitem_sgp_packing AS packing,
                itm.custitem_sgp_actualstems AS actual_stems,
                itm.vendorname AS vendor_name,
                itm.custitem_sgp_subcategory AS subcategory
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
                AND (itm.itemid IS NULL OR itm.itemid NOT LIKE '%*%')
            ORDER BY
                itm.id ASC
            FETCH FIRST 8000 ROWS ONLY
        `;

        try {
            // ── 1. Ítems HARDGOODS ─────────────────────────────────────────
            phase = '1-hardgoods items';
            const results_hg = runSuiteQLAll(sql_hardgoodsItems);
            if (!results_hg.length) {
                log.audit('HG_RM.loadHardgoodsRawMaterials', 'Sin ítems HARDGOODS → reporte vacío.');
                return rows;
            }
            log.audit('HG_RM.loadHardgoodsRawMaterials', `Ítems HARDGOODS: ${results_hg.length}`);
            const hardgoodsItemIds = results_hg.map((r) => String(r.item));

            // ── 2. Explosión de 2 niveles (mismo patrón que R1/R2/pa_sl_bom_explosion_ui.js) ──
            phase = '2-explosion 2 niveles + fechas + inactivos';
            const revisionDataByItem = {};   // itemId → { revisionId: bomquantity (sumado) }
            const bomIdByRevision = {};      // revisionId → bomId (siempre nivel 1)
            const bomIdSet = {};             // bomId → true (solo diagnóstico)
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
            log.audit('HG_RM.loadHardgoodsRawMaterials',
                `Fechas CURRENT del Prebook: raw=[${currentStart} - ${currentEnd}] → ISO=[${currentStartIso} - ${currentEndIso}] → ` +
                (dateWhereSql ? 'filtro SQL aplicado' : 'SIN FILTRO DE FECHA (fechas vacías o no parseables) — trae TODAS las revisiones activas'));
            let totalComponentRows = 0;
            chunkIds(hardgoodsItemIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT DISTINCT
                        b.id   AS bom_id,
                        br.id  AS revision_id,
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
            log.audit('HG_RM.loadHardgoodsRawMaterials',
                `Fase 2: explosión filas=${totalComponentRows}, hardgoods con >=1 receta=${Object.keys(revisionDataByItem).length} de ${hardgoodsItemIds.length}, BOMs distintos=${Object.keys(bomIdSet).length}`);

            // ── 6. PO recibidas / pedidas (LOC1) por hardgood ─────────────────
            phase = '6-po qty y recibido (LOC1)';
            const poByItem = {};
            let totalPoRows = 0;
            chunkIds(hardgoodsItemIds, 1000).forEach((inList) => {
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
            log.audit('HG_RM.loadHardgoodsRawMaterials',
                `Fase 6: líneas de PO (type=PurchOrd, location=LOC1) filas=${totalPoRows}, hardgoods con PO=${Object.keys(poByItem).length} de ${hardgoodsItemIds.length}`);

            // ── 7. Inventario inicial del Prebook (snapshot, sin ubicación) ───
            phase = '7-inventario inicial';
            const invByItem = {};
            let totalInvRows = 0;
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
                    totalInvRows++;
                    invByItem[String(r.item_id)] = Number(r.quantity) || 0;
                });
            });
            log.audit('HG_RM.loadHardgoodsRawMaterials',
                `Fase 7: customrecord_bc_prebookbeginninginvline filas=${totalInvRows}, hardgoods con inventario inicial=${Object.keys(invByItem).length} de ${hardgoodsItemIds.length}`);

            // ── 8. UNIT PREP COMP: Assembly Build completados (sin ubicación) ─
            phase = '8-unit prep comp (assembly build)';
            const prepByItem = {};
            let totalPrepRows = 0;
            chunkIds(hardgoodsItemIds, 1000).forEach((inList) => {
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
                    log.error('HG_RM.loadHardgoodsRawMaterials',
                        `Query de Assembly Build falló (verificar código de tipo 'Build'): ${eBuild.message}`);
                }
            });
            log.audit('HG_RM.loadHardgoodsRawMaterials',
                `Fase 8: Assembly Build filas=${totalPrepRows}, hardgoods con producción=${Object.keys(prepByItem).length} de ${hardgoodsItemIds.length}`);

            // ── 9. Armado de filas ─────────────────────────────────────────────
            phase = '9-armado filas';
            let itemsNoRevData = 0, skipsNoBomId = 0;
            let itemsWithUnits = 0, itemsWithOnHand = 0, itemsWithPoReceived = 0, itemsWithPrep = 0;
            results_hg.forEach((r) => {
                const itemId = String(r.item);
                const packing = Number(r.packing) || 0;
                const actualStems = Number(r.actual_stems) || 0;

                const revData = revisionDataByItem[itemId] || {};
                if (!Object.keys(revData).length) itemsNoRevData++;

                const bestRevByBom = {};   // bomId → { revId, bomquantity }
                Object.keys(revData).forEach((revId) => {
                    const bomId = bomIdByRevision[revId];
                    if (!bomId) { skipsNoBomId++; return; }
                    const current = bestRevByBom[bomId];
                    if (!current || Number(revId) > Number(current.revId)) {
                        bestRevByBom[bomId] = { revId: revId, bomquantity: revData[revId] };
                    }
                });
                const unitsNeeded = Object.keys(bestRevByBom)
                    .reduce((sum, bomId) => sum + (bestRevByBom[bomId].bomquantity || 0), 0);

                const bunchesNeeded = actualStems > 0 ? Math.ceil(unitsNeeded / actualStems) : 0;
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

                // Separador 'x' (no '/'): confirmado por el header "PACK PKxSTM" del PDF de referencia.
                const pkstm = (packing || actualStems) ? `${packing}x${actualStems}` : '';

                if (unitsNeeded > 0) itemsWithUnits++;
                if (qtyOnHand > 0) itemsWithOnHand++;
                if (poReceived > 0) itemsWithPoReceived++;
                if (unitprepcomp > 0) itemsWithPrep++;

                rows.push({
                    cat: r.category_code || r.category_name || '',
                    printingSeq: isEmptyValue(r.printing_seq) ? null : Number(r.printing_seq),
                    productCode: r.item_name || '',
                    description: r.description || '',
                    pkstm: pkstm,
                    unitsNeeded: unitsNeeded,
                    bunchesNeeded: bunchesNeeded,
                    casesNeeded: casesNeeded,
                    qtyOnHand: qtyOnHand,
                    unitprepcomp: unitprepcomp,
                    poReceived: poReceived,
                    inBound: inBound,
                    casesShort: casesShort,
                    casesOver: casesOver,
                    vendor: safeStr(r.vendor_name),
                    subcategory: safeStr(r.subcategory),
                    componentItemId: itemId,
                    packing: packing,
                    actualStems: actualStems
                });
            });

            log.audit('HG_RM.loadHardgoodsRawMaterials',
                `Fase 9 resumen: ${results_hg.length} hardgoods · sin recetas vigentes=${itemsNoRevData} · ` +
                `saltos por bomId no resuelto=${skipsNoBomId}`);
            log.audit('HG_RM.loadHardgoodsRawMaterials',
                `Fase 9 columnas >0: UNITS NEEDED=${itemsWithUnits} · QUANTITY ONHAND=${itemsWithOnHand} · ` +
                `PO RECVD=${itemsWithPoReceived} · UNIT PREP COMP=${itemsWithPrep} (de ${results_hg.length} hardgoods)`);
            log.audit('HG_RM.loadHardgoodsRawMaterials', `Filas generadas: ${rows.length}`);
        } catch (e) {
            log.error('HG_RM.loadHardgoodsRawMaterials', `Fallo en fase [${phase}]: ${e.message} | ${e.stack}`);
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

    /** Timestamp legible para el header del PDF (ej. "30 Mar 2026  09:41"), igual formato que el reporte legacy de referencia. */
    const nowDisplayStamp = () => {
        const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    /** Detecta valores "vacíos", incluyendo ScriptNullObjectAdapter (ver R1/R2). */
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
            log.debug('HG_RM.runSuiteQLAll',
                `Sin paginación para esta consulta, uso runSuiteQL directo. Detalle: ${ePaged.message}`);
            const results = query.runSuiteQL({ query: sql, params: params }).asMappedResults();
            if (results.length === 5000) {
                log.error('HG_RM.runSuiteQLAll',
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

    // =========================================================================
    return {
        getMetadata,
        getFilterDefinitions,
        validateFilters,
        generate,
        getPreviewData
    };
});

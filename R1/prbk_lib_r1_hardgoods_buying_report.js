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

    /**
     * Nombre del archivo .ftl (plantilla FreeMarker) alojado en el File Cabinet,
     * usado para el formato PDF.
     */
    const HG_TEMPLATE_FILENAME = 'prbk_custtmpl_r1_hardgoods_buying_report.ftl';

    // =========================================================================
    // 1. METADATA
    // =========================================================================

    const getMetadata = () => ({
        id: 'HARDGOODS_BUYING',
        name: 'Hardgoods Buying Report',
        description: 'Reporte de compra de artículos físicos con contexto de receta, ' +
            'inventario por ubicación y órdenes de compra del Preebook.',
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
            helpText: 'Seleccione el Preebook. Por ahora solo se usa como referencia en el ' +
                'título/nombre del archivo; no filtra los datos del reporte (se irá integrando ' +
                'progresivamente: proyección, PO, inventario, etc.).'
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
            helpText: 'Seleccione el formato del documento a generar (Excel o PDF).'
        }
    ]);

    // =========================================================================
    // 3. VALIDACIÓN CROSS-FIELD
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
    // 4. GENERATE — Orquesta la recolección de datos
    // =========================================================================

    /**
     * @param  {Object} filterValues  - Valores de los filtros del shell.
     *                                  filterValues.prebook        = Internal ID del Prebook (referencia)
     *                                  filterValues.output_format  = 'PDF' | 'EXCEL'
     * @returns {Object} { fileObj, contentType, filename }
     */
    const generate = (filterValues) => {
        const prebookId = String(filterValues.prebook);
        const format = String(filterValues.output_format || 'EXCEL').toUpperCase();
        log.audit('HARDGOODS.generate', `prebook=${prebookId} (referencia)  format=${format}`);

        // ── 1. Ítems hardgoods + recetas (BOM) donde están relacionados ──────
        //    Por ahora NO incluye explosión de componentes, proyección, PO ni
        //    inventario: esas columnas quedan en 0/blanco y se van a ir
        //    completando progresivamente.
        const bomRows = loadHardgoodsBomList(prebookId);
        log.audit('HARDGOODS.bomRows', `count=${bomRows.length}`);

        // ── 2. Cabecera del Prebook (mismo formato original) ─────────────────
        //    NOTA: se sanitiza el resultado porque search.lookupFields puede devolver,
        //    para campos vacíos (típicamente fechas), un objeto Java interno
        //    (ScriptNullObjectAdapter) en vez de null/undefined. Si eso no se limpia
        //    aquí, "String(valor)" lo imprime literalmente en el Excel/PDF como
        //    "com.netsuite.suitescript.scriptobject.ScriptNullObjectAdapter@...".
        const preebookDataRaw = search.lookupFields({
            type: 'customrecord_sgp_prebook',
            id: prebookId,
            columns: [
                'name',
                'custrecord_sgp_pb_historical_start_date',
                'custrecord_sgp_pb_historical_end_date'
            ]
        });
        const preebookData = {};
        Object.keys(preebookDataRaw).forEach((k) => {
            preebookData[k] = safeStr(preebookDataRaw[k]);
        });

        // Encabezados ORIGINALES del reporte — no cambiar este set de columnas.
        // Las que todavía no tienen dato (TOTAL UNITS, +/-, LOC1/LOC2 OH UNITS,
        // PO QTY, PO RECEIVED, PREP PRODUCTION) se van completando poco a poco.
        const headers = ['CAT', 'PRODUCT', 'DESCRIPTION', 'TYPE', '# RECIPES', 'CODE DESCRIPTION', 'CUST', 'CUSTOMER NAME',
            'TOTAL UNITS', '+ -', 'FOB COST', 'LANDED COST', 'LOC1 OH UNITS', 'LOC2 OH UNITS',
            'PO QTY', 'PO RECEIVED', 'PREP PRODUCTION'];

        const baseName = `HG_BuyingReport_${String(preebookData.name || prebookId).replace(/\s+/g, '_')}_${nowStamp()}`;

        // ── 3. Generar el documento según el formato seleccionado en el filtro ──
        if (format === 'PDF') {
            const reportPdf = crearPDF(headers, bomRows, `${baseName}.pdf`, prebookId, preebookData);
            return { fileObj: reportPdf, contentType: 'PDF', filename: `${baseName}.pdf` };
        }

        const reportExcel = crearExcel(headers, bomRows, `${baseName}.xlsx`, prebookId, preebookData);
        return { fileObj: reportExcel, contentType: 'application/vnd.ms-excel', filename: `${baseName}.xls` };
    };

    // =========================================================================
    // EXCEL — mismo formato/estructura original (no modificar sin necesidad)
    // =========================================================================

    // Límite real de file.create en NetSuite es 10 MB; dejamos margen.
    const MAX_XLS_BYTES = 9.8 * 1024 * 1024;

    const crearExcel = (headers, rows, fileName, prebookId, preebookData) => {
        try {

            // Helpers de celda: escapan caracteres XML (&, <, >) para no corromper el archivo.
            // Usa isEmptyValue para blindarse también contra ScriptNullObjectAdapter.
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

            // 2. Agregar la fila de Encabezados (Headers)
            xmlString += '<Row>\n';
            headers.forEach(header => {
                xmlString += strCell(header);
            });
            xmlString += '</Row>\n';

            // 3. Agregar las filas de datos (Rows)
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
                    xmlString += EMPTY;                      // "+ -" (sin fuente de inventario aún)
                    xmlString += strCell(row.fob_cost);
                    xmlString += strCell(row.landed_cost);
                    xmlString += strCell(row.loc_1_oh);
                    xmlString += strCell(row.loc_2_oh);
                    xmlString += strCell(row.po_received);   // bajo "PO QTY" (réplica invertida del Excel)
                    xmlString += strCell(row.po_qty);        // bajo "PO RECEIVED" (réplica invertida del Excel)
                    xmlString += EMPTY;                      // PREP PRODUCTION
                    xmlString += '</Row>';
                    row.recipes.forEach((recipe, index) => {
                        if (index === 0) return; // la primera receta ya se imprimió en la fila principal
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

            // 4. Cerrar las etiquetas del XML
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

            // 5. Convertir el contenido XML a Base64 para asegurar que conserve el formato correcto
            let base64EncodedString = encode.convert({
                string: xmlString,
                inputEncoding: encode.Encoding.UTF_8,
                outputEncoding: encode.Encoding.BASE_64
            });

            // 5.1 Control de tamaño: el archivo real ≈ len(base64) * 3/4 (UTF-8 ya contabilizado).
            //     Si supera el margen, abortamos con un mensaje accionable en vez del error genérico.
            const approxFileBytes = Math.floor(base64EncodedString.length * 3 / 4);
            if (approxFileBytes > MAX_XLS_BYTES) {
                const mb = (approxFileBytes / (1024 * 1024)).toFixed(1);
                throw new Error(
                    `El Excel generado pesa ~${mb} MB y supera el límite de 10 MB de NetSuite. ` +
                    `Genere el reporte en formato PDF o reduzca el alcance del Prebook (menos items/recetas).`
                );
            }

            // 6. Crear el archivo en NetSuite usando el tipo EXCEL
            let excelFile = file.create({
                name: fileName || 'export_netSuite.xls',
                fileType: file.Type.EXCEL,
                contents: base64EncodedString
            });

            return excelFile;
        } catch (error) {
            log.error('HARDGOODS.crearExcel', `Error al crear Excel: ${error.message}`);
            // Re-lanzamos para que el shell muestre el mensaje y no falle de forma silenciosa.
            throw error;
        }
    };

    // =========================================================================
    // PDF
    // =========================================================================

    /**
     * Resuelve el Internal ID de un archivo del File Cabinet a partir de su nombre.
     *
     * @param  {string} fileName
     * @returns {number|null}  Internal ID del archivo, o null si no se encuentra.
     */
    const findTemplateFileId = (fileName) => {
        const sql = `SELECT id FROM file WHERE name = ? ORDER BY id`;
        const rs = query.runSuiteQL({ query: sql, params: [fileName] });
        const results = rs.asMappedResults();
        return results.length ? results[0].id : null;
    };

    /**
     * Genera el reporte en PDF a partir de una plantilla FTL (FreeMarker) del File Cabinet.
     *
     * @param  {Array<string>} headers      - Encabezados del reporte (mismo orden que el Excel).
     * @param  {Array<Object>} rows         - Filas (con su arreglo anidado `recipes`).
     * @param  {string}        fileName     - Nombre del archivo PDF de salida.
     * @param  {string}        prebookId    - Internal ID del Prebook.
     * @param  {Object}        preebookData - Resultado de lookupFields del Prebook.
     * @returns {File|null}  Objeto File del PDF renderizado, o null si falla.
     */
    const crearPDF = (headers, rows, fileName, prebookId, preebookData) => {
        try {
            // 1. Resolver dinámicamente el ID del .ftl en el File Cabinet
            const templateFileId = findTemplateFileId(HG_TEMPLATE_FILENAME);
            if (!templateFileId) {
                log.error('HARDGOODS.crearPDF',
                    `No se encontró la plantilla '${HG_TEMPLATE_FILENAME}' en el File Cabinet.`);
                return null;
            }

            // 2. Cargar el contenido de la plantilla FTL
            const templateFile = file.load({ id: templateFileId });

            // 3. Configurar el renderer con el contenido de la plantilla
            const renderer = render.create();
            renderer.templateContent = templateFile.getContents();

            // 4. Record del Prebook → accesible como ${record.<campo>} en la FTL
            const preBookObj = record.load({
                type: 'customrecord_sgp_prebook',
                id: prebookId
            });
            renderer.addRecord('record', preBookObj);

            // 5. Datos del reporte → accesibles como ${data.report[...]} / ${data.metadata.*}
            renderer.addCustomDataSource({
                format: render.DataSource.JSON,
                alias: 'data',
                data: JSON.stringify({
                    report: rows,
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

            // 6. Renderizar y nombrar el PDF
            const pdfFile = renderer.renderAsPdf();
            pdfFile.name = fileName || 'export_netSuite.pdf';

            return pdfFile;
        } catch (error) {
            log.error('HARDGOODS.crearPDF', `Error al crear PDF: ${error.message}`);
            return null;
        }
    };

    // =========================================================================
    // QUERIES (N/query — SuiteQL)
    // =========================================================================

    /**
     * Ejecuta una SuiteQL y devuelve TODOS los resultados mapeados, paginando de a
     * 1000 para no chocar contra el límite de 5000 filas de runSuiteQL.
     *
     * @param {string} sql
     * @param {Array}  [params]
     * @returns {Array<Object>}
     */
    const runSuiteQLAll = (sql, params) => {
        params = params || [];

        // 1) Intento con paginación (maneja > 5000 filas en tablas de registro normales).
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
            // 2) Algunas tablas-mapa del sistema (p. ej. bomassemblyitemmap) no soportan
            //    el wrapper de paginación y lanzan un error genérico en fetch().
            //    Fallback a runSuiteQL directo (tope 5000 filas, suficiente para los mapas).
            //    Es un comportamiento esperado, por eso va a debug y no a audit.
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
     * Construye las filas del reporte: todos los ítems Hardgoods de tipo Assembly
     * (itm.itemtype = 'Assembly'), y por cada uno, TODAS las Bill of Materials en
     * las que aparece como COMPONENTE (where-used), agrupadas en `row.recipes`.
     *
     * A diferencia de versiones anteriores, la relación item↔BOM ya NO se saca del
     * mapa nativo item→su-propio-BOM (bomassemblyitemmap), sino de
     * BomRevisionComponent: se busca en qué revisiones de BOM aparece cada ítem
     * hardgoods como componente (ITEM en la tabla "Components" del BOM Revision,
     * ver imagen de referencia), y de ahí se sube a la Bill of Materials padre
     * (bomRevision.billofmaterials) — es decir, un reporte "dónde se usa este
     * artículo" en vez de "cuál es el BOM propio de este artículo".
     *
     * Columnas ya calculadas: cat, product, description, type, fob_cost, landed_cost,
     *   recipes[].recipe_code / recipedescription / customer_code / customer_name,
     *   num_recipes, totalUnits, po_qty, po_received.
     *
     * TOTAL UNITS = (unidades proyectadas del Prebook para este ítem hardgoods,
     *   tomadas de customrecord_sgp_prebook_projection_rp) × (bomquantity del
     *   ítem sumado entre TODAS las recetas donde aparece como componente).
     *   Para cada receta, si el ítem aparece en varias revisiones del mismo BOM,
     *   se usa únicamente la revisión con el ID más alto (la más reciente).
     *
     * PO QTY / PO RECEIVED = quantity / quantityreceived sumados de las líneas
     *   de Purchase Order cuyo custbody_sgp_report_id = este Prebook y cuyo
     *   ítem = este hardgood.
     *
     * Columnas AÚN NO implementadas (quedan en 0/blanco por ahora):
     *   "+ -" y loc_1_oh / loc_2_oh (sin fuente de inventario definida todavía).
     *
     * Inactivos: NO se filtran. Se incluyen ítems, Bill of Materials, revisiones
     *   de BOM y clientes sin importar su estado (activo/inactivo).
     *
     * @param {string} prebookId - Internal ID del Prebook (para proyecciones y POs).
     * @returns {Array<Object>}
     */
    const loadHardgoodsBomList = (prebookId) => {
        const rows = [];
        let phase = 'init';

        try {
            // ── 1. Ítems hardgoods, con su info completa ────────────────────
            phase = '1-hardgoods items';
            const hardgoodsItems = runSuiteQLAll(`
                SELECT
                    itm.id                                     AS item_id,
                    itm.itemid                                 AS item_name,
                    itm.itemtype                                AS item_type,
                    itm.displayname                            AS description,
                    itm.custitem_sgp_last_purchase_price       AS fob_cost,
                    itm.custitem_bc_lastpurchasepricewithoutla AS landed_cost,
                    SUBSTR(cat.name, 1, 3)                     AS category_code,
                    cat.name                                   AS category_name
                FROM item itm
                INNER JOIN customrecord_cseg_sgp_prod_cat cat
                    ON cat.id = itm.custitem_cseg_sgp_prod_cat
                WHERE itm.custitem_cseg_sgp_prod_cat IS NOT NULL
                  AND LOWER(BUILTIN.DF(itm.custitem_cseg_sgp_prod_cat)) = 'hardgoods'
                  AND itm.itemtype = 'Assembly'
            `);

            if (!hardgoodsItems.length) {
                log.audit('HARDGOODS.loadHardgoodsBomList', 'Sin ítems hardgoods de tipo Assembly → reporte vacío.');
                return rows;
            }
            log.audit('HARDGOODS.loadHardgoodsBomList', `Ítems hardgoods (tipo Assembly): ${hardgoodsItems.length}`);

            const hardgoodsItemIds = hardgoodsItems.map((it) => String(it.item_id));

            // ── 2. Where-used: en qué BomRevisionComponent aparece cada ítem
            //      hardgoods como COMPONENTE (no su propio BOM, sino los BOM que
            //      lo consumen). Acotado por IN (), en bloques de 1000 ítems.
            //      Se guarda también bomquantity, necesario para TOTAL UNITS.
            phase = '2-where-used componentes';
            const revisionDataByItem = {};   // itemId → { revisionId: bomquantity, ... }
            const allRevisionIdSet = {};
            chunkIds(hardgoodsItemIds, 1000).forEach((inList) => {
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
            log.audit('HARDGOODS.loadHardgoodsBomList',
                `Revisiones de BOM donde algún ítem hardgoods aparece como componente: ${allRevisionIds.length}`);

            // ── 3. Revisión → Bill of Materials padre (bomRevision.billofmaterials) ─
            phase = '3-revision a bom';
            const bomIdByRevision = {};   // revisionId → bomId
            const bomIdSet = {};
            chunkIds(allRevisionIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        br.id              AS revision_id,
                        br.billofmaterials AS bom_id
                    FROM bomRevision br
                    WHERE br.id IN (${inList})
                `).forEach((r) => {
                    bomIdByRevision[String(r.revision_id)] = String(r.bom_id);
                    bomIdSet[String(r.bom_id)] = true;
                });
            });
            const bomIds = Object.keys(bomIdSet);

            // ── 4. Metadata de las Bill of Materials padre (nombre, memo, cliente) ─
            phase = '4-bom meta';
            const bomMeta = {};   // bomId → { recipe_code, recipe_description, customer_code, customer_name }
            chunkIds(bomIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        b.id                          AS bom_id,
                        b.name                        AS recipe_code,
                        b.memo                        AS recipe_description,
                        cust.entityid                 AS customer_code,
                        cust.altname                  AS customer_name
                    FROM Bom b
                    LEFT JOIN Customer cust ON cust.id = b.custrecord_sgp_bom_customer
                    WHERE b.id IN (${inList})
                `).forEach((r) => {
                    bomMeta[String(r.bom_id)] = {
                        recipe_code: r.recipe_code || '',
                        recipe_description: r.recipe_description || '',
                        customer_code: r.customer_code || '',
                        customer_name: r.customer_name || ''
                    };
                });
            });

            // ── 5. Proyecciones del Prebook por ítem hardgoods (para TOTAL UNITS) ─
            phase = '5-proyecciones prebook';
            const projectionQtyByItem = {};   // itemId → unidades proyectadas (suma)
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

            // ── 6. PO QTY / PO RECEIVED por ítem hardgoods, de las líneas de ────
            //      Purchase Order generadas para este Prebook.
            phase = '6-po qty y recibido';
            const poByItem = {};   // itemId → { po_qty, po_received }
            chunkIds(hardgoodsItemIds, 1000).forEach((inList) => {
                runSuiteQLAll(`
                    SELECT
                        tl.item                   AS item_id,
                        SUM(tl.quantity)          AS po_qty,
                        SUM(tl.quantityreceived)  AS po_received
                    FROM transaction t
                    INNER JOIN transactionline tl ON tl.transaction = t.id
                    WHERE t.type = 'PurchOrd'
                      AND t.custbody_sgp_report_id = ?
                      AND tl.mainline = 'F'
                      AND tl.item IN (${inList})
                    GROUP BY tl.item
                `, [prebookId]).forEach((r) => {
                    poByItem[String(r.item_id)] = {
                        po_qty: Number(r.po_qty) || 0,
                        po_received: Number(r.po_received) || 0
                    };
                });
            });

            // ── 7. Armado de filas: una por ítem hardgoods, con las BOM donde ────
            //      aparece como componente (deduplicadas por bomId, usando la
            //      revisión más reciente de cada una para el bomquantity).
            phase = '7-armado filas';
            hardgoodsItems.forEach((it) => {
                const itemId = String(it.item_id);
                const revData = revisionDataByItem[itemId] || {};
                const revIds = Object.keys(revData);

                // Por cada BOM (receta), me quedo solo con la revisión de mayor ID
                // (la más reciente) en la que el ítem aparece como componente.
                const bestRevByBom = {};   // bomId → { revId, bomquantity }
                revIds.forEach((revId) => {
                    const bomId = bomIdByRevision[revId];
                    if (!bomId) return;
                    const current = bestRevByBom[bomId];
                    if (!current || Number(revId) > Number(current.revId)) {
                        bestRevByBom[bomId] = { revId: revId, bomquantity: revData[revId] };
                    }
                });

                const recipes = Object.keys(bestRevByBom).map((bomId) => {
                    const meta = bomMeta[bomId] || {};
                    return {
                        recipeId: bomId,
                        recipe_code: meta.recipe_code || '',
                        recipedescription: meta.recipe_description || '',
                        customer_code: meta.customer_code || '',
                        customer_name: meta.customer_name || ''
                    };
                }).sort((a, b) => String(a.recipe_code).localeCompare(String(b.recipe_code)));

                // TOTAL UNITS = unidades proyectadas del ítem × bomquantity sumado
                // entre todas las recetas donde aparece como componente.
                const totalBomQty = Object.keys(bestRevByBom)
                    .reduce((sum, bomId) => sum + (bestRevByBom[bomId].bomquantity || 0), 0);
                const projectedQty = projectionQtyByItem[itemId] || 1;
                const totalUnits = projectedQty * totalBomQty;

                const po = poByItem[itemId] || { po_qty: 0, po_received: 0 };

                rows.push({
                    componentItemId: itemId,
                    cat: it.category_code || it.category_name || '',
                    product: it.item_name || '',
                    description: it.description || '',
                    type: mapItemType(it.item_type),
                    fob_cost: Number(it.fob_cost) || 0,
                    landed_cost: Number(it.landed_cost) || 0,
                    // TODO: aún no implementado — sin fuente de inventario definida.
                    loc_1_oh: 0,
                    loc_2_oh: 0,
                    po_qty: po.po_qty,
                    po_received: po.po_received,
                    totalUnits: totalUnits,
                    recipes: recipes,
                    num_recipes: recipes.length
                });
            });

            // ── 8. Orden: más recetas primero (mismo criterio que la versión previa) ─
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

    /**
     * Mapea el type interno de NetSuite al texto legible para el reporte.
     */
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

    /**
     * Detecta valores "vacíos", incluyendo el caso particular en que NetSuite
     * devuelve un ScriptNullObjectAdapter (objeto Java interno) en vez de
     * null/undefined para campos sin valor (frecuente en fechas obtenidas con
     * search.lookupFields / record.getValue). Sin este check, un simple
     * `v === null` no lo detecta y String(v) imprime el nombre de la clase Java.
     *
     * @param {*} v
     * @returns {boolean}
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
     * Timestamp compacto para el nombre del archivo.
     * Formato: YYYYMMDD_HHmm
     */
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
        generate
    };
});

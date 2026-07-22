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
     * Internal IDs de las ubicaciones para On Hand.
     * TODO: reemplazar con los valores reales de Setup > Company > Locations.
     */
    const LOC1_ID = 1;       // ← poner el Internal ID real de LOC1
    const LOC2_ID = 2;       // ← poner el Internal ID real de LOC2
    const LOC1_LABEL = 'LOC1';  // ← nombre visible de LOC1 en el header del reporte
    const LOC2_LABEL = 'LOC2';  // ← nombre visible de LOC2 en el header del reporte

    /**
     * ID del Advanced PDF Template del Hardgoods Buying Report.
     * Pasos para obtener el ID real:
     *   1. En NetSuite: Customization > Forms > Advanced PDF/HTML Templates
     *   2. Subir prbk_custtmpl_r1_hardgoods_buying_report.template.xml
     *   3. Copiar el Internal ID y reemplazar el valor de abajo.
     * TODO: reemplazar con el Internal ID real del template.
     */
    const HG_TEMPLATE_ID = 'CUSTTMPL_HG_BUYING';  // ← reemplazar con el ID real

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
            helpText: 'Seleccione el Preebook del cual se generará el reporte.'
        },
        {
            id: 'output_format',
            label: 'Tipo de documento',
            type: 'select',
            mandatory: true,
            // Lista sin source → opciones estáticas con llaves value/text
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
    // 4. GENERATE — Orquesta la recolección y consolidación de datos
    // =========================================================================

    /**
     * @param  {Object} filterValues  - Valores de los filtros del shell.
     *                                  filterValues.prebook        = Internal ID del Prebook
     *                                  filterValues.output_format  = 'PDF' | 'EXCEL' (filtro del shell)
     * @returns {Object} { rows: Array<Object>, metadata: Object }
     */
    const generate = (filterValues) => {
        const prebookId = String(filterValues.prebook);
        const format = String(filterValues.output_format || 'EXCEL').toUpperCase();
        log.audit('HARDGOODS.generate', `prebook=${prebookId}  format=${format}`);

        // ── 1. Finished items del Prebook ──────────────────────────────────
        // const projections     = loadProjections(prebookId);
        // const finishedItemIds = Array.from(new Set(projections.map((p) => p.itemId).filter(Boolean)));
        // log.audit('HARDGOODS.finishedItems', `count=${finishedItemIds.length}`);

        // if (!finishedItemIds.length) {
        //     log.audit('HARDGOODS', 'Sin finished items en el Prebook → reporte vacío.');
        //     return buildEmptyResponse(format, prebookId);
        // }

        // ── 2. Componentes BOM (hardgoods) con info de receta ──────────────
        const bomRows = loadBomComponents(prebookId);
        log.audit('HARDGOODS.bomRows', `count=${bomRows.length}`);


        let preebookData = search.lookupFields({
            type: 'customrecord_sgp_prebook',
            id: prebookId,
            columns: [
                'custrecord_sgp_pb_historical_start_date',
                'custrecord_sgp_pb_historical_end_date',
                'name',
                'custrecord_sgp_pb_current_start_date'
            ]
        });

        const headers = ['CAT', 'PRODUCT', 'DESCRIPTION', 'TYPE', '# RECIPES', 'CODE DESCRIPTION', 'CUST', 'CUSTOMER NAME',
            'TOTAL UNITS', '+ -', 'FOB COST', 'LANDED COST', 'LOC1 OH UNITS', 'LOC2 OH UNITS',
            'PO QTY', 'PO RECEIVED', 'PREP PRODUCTION'];
        const baseName = `HG_BuyingReport_${String(preebookData?.name).replace(/\s+/g, '_')}_${nowStamp()}`;

        // ── Generar el documento según el formato seleccionado en el filtro ──
        if (format === 'PDF') {
            const reportPdf = crearPDF(headers, bomRows, `${baseName}.pdf`, prebookId, preebookData);
            return { fileObj: reportPdf, contentType: 'PDF', filename: `${baseName}.pdf` };
        }

        const reportExcel = crearExcel(headers, bomRows, `${baseName}.xlsx`, prebookId, preebookData);
        return { fileObj: reportExcel, contentType: 'application/vnd.ms-excel', filename: `${baseName}.xls` };

        // return false
        // if (!bomRows.length) {
        //     log.audit('HARDGOODS', 'Sin componentes en los BOMs → reporte vacío.');
        //     return buildEmptyResponse(format, prebookId);
        // }

        // // ── 3. IDs únicos de componentes ───────────────────────────────────
        // const componentItemIds = Array.from(
        //     new Set(bomRows.map((r) => r.componentItemId).filter(Boolean))
        // );
        // log.audit('HARDGOODS.componentItems', `count=${JSON.stringify(componentItemIds)}`);

        // // ── 4. Consultas de enriquecimiento ────────────────────────────────
        // const itemMaster = loadItemMaster(componentItemIds);
        // log.debug("itemMaster", JSON.stringify(itemMaster));
        // const inventoryMap = loadInventoryByLocation(componentItemIds);
        // log.debug("inventoryMap", JSON.stringify(inventoryMap));
        // const poMap = loadPoData(componentItemIds, prebookId);
        // log.debug("poMap", JSON.stringify(poMap));
        // const recipeCountMap = buildRecipeCountMap(bomRows);
        // log.debug("recipeCountMap", JSON.stringify(recipeCountMap));

        // // ── 5. Consolidar filas ────────────────────────────────────────────
        // const rows = consolidateRows(bomRows, itemMaster, inventoryMap, poMap, recipeCountMap);
        // log.audit('HARDGOODS.rows', `count=${rows.length}`);
        // log.audit('HARDGOODS.rows', `count=${JSON.stringify(rows)}  ...`);

        // let reportExcel = crearExcel(
        //     ['CAT', 'PRODUCT', 'DESCRIPTION', 'TYPE', '# RECIPES', 'CODE DESCRIPTION', 'CUST', 'CUSTOMER NAME',
        //         'TOTAL UNITS', '+ -', 'FOB COST', 'LANDED COST', 'LOC1 OH UNITS', 'LOC2 OH UNITS',
        //         'PO QTY', 'PO RECEIVED', 'PREP PRODUCTION'],
        //     rows,
        //     `HG_BuyingReport_${prebookId}_${nowStamp()}.xlsx`
        // );
        // return { fileObj: reportExcel, contentType: 'application/vnd.ms-excel', filename: `HG_BuyingReport_${prebookId}_${nowStamp()}.xls` };

        // context.response.writeFile({
        //     file: reportExcel,
        //     isInline: false // false fuerza la descarga del archivo en lugar de abrirlo en el navegador
        // });

        // const metadata = {
        //     prebookId: prebookId,
        //     format: format,
        //     generatedAt: new Date().toISOString(),
        //     loc1Label: LOC1_LABEL,
        //     loc2Label: LOC2_LABEL,
        //     totalRows: rows.length
        // };

        // // ── 6. Renderizar según formato ────────────────────────────────────
        // return renderFinalPdf(prebookId, rows, metadata);
    };


    // Límite real de file.create en NetSuite es 10 MB; dejamos margen.
    const MAX_XLS_BYTES = 9.8 * 1024 * 1024;

    const crearExcel = (headers, rows, fileName, prebookId, preebookData) => {
        try {

            // Helpers de celda: escapan caracteres XML (&, <, >) para no corromper el archivo.
            // Las celdas NO llevan ss:StyleID: heredan el borde del estilo Default, lo que
            // reduce ~17 bytes por celda. Las vacías son <Cell/> (7 bytes).
            const escapeXml = (v) => (v === null || v === undefined) ? '' :
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
                '<Cell ss:Index="3" ss:StyleID="sPlain"><Data ss:Type="String">History: ' + escapeXml(preebookData?.custrecord_sgp_pb_historical_start_date) + ' - ' + escapeXml(preebookData?.custrecord_sgp_pb_historical_end_date) + '</Data></Cell>\n' +
                '</Row>\n' +
                '<Row>\n' +
                '<Cell ss:Index="3" ss:StyleID="sPlain"><Data ss:Type="String">Current: ' + escapeXml(preebookData?.custrecord_sgp_pb_current_start_date) + '</Data></Cell>\n' +
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
                    xmlString += strCell(row.totalUnits);   // "+ -" (réplica del Excel)
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

    /**
     * Nombre del archivo .ftl (plantilla FreeMarker) alojado en el File Cabinet.
     * Se resuelve su Internal ID en tiempo de ejecución (ver findTemplateFileId)
     * para que al migrar entre ambientes no haya que tocar el script.
     * TODO: ajustar al nombre real del archivo subido al File Cabinet.
     */
    const HG_TEMPLATE_FILENAME = 'prbk_custtmpl_r1_hardgoods_buying_report.ftl';

    /**
     * Resuelve el Internal ID de un archivo del File Cabinet a partir de su nombre.
     * Mantiene el dinamismo entre ambientes (sandbox → producción) sin hardcodear IDs.
     *
     * NOTA: el nombre de archivo no es único globalmente en el File Cabinet. Si existe
     *       riesgo de homónimos en otra carpeta, conviene acotar por folder.
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
     * Esta función SOLO resuelve la plantilla, inyecta los datos y renderiza el PDF;
     * toda la maquetación vive en el archivo .ftl (se construye por separado).
     *
     * Aliases expuestos a la plantilla FreeMarker:
     *   record → customrecord_sgp_prebook  (campos del header: fechas, nombre, etc.)
     *   data   → { report: rows[], headers: string[], metadata: {...} }
     *
     * @param  {Array<string>} headers      - Encabezados del reporte (mismo orden que el Excel).
     * @param  {Array<Object>} rows         - Filas (bomRows, con su arreglo anidado `recipes`).
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

            // 3. Configurar el renderer con el contenido de la plantilla (no setTemplateById,
            //    porque es un .ftl del File Cabinet, no un Advanced PDF Template estándar)
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
                        prebookName: preebookData?.name || '',
                        historicalStart: preebookData?.custrecord_sgp_pb_historical_start_date || '',
                        historicalEnd: preebookData?.custrecord_sgp_pb_historical_end_date || '',
                        currentStart: preebookData?.custrecord_sgp_pb_current_start_date || '',
                        loc1Label: LOC1_LABEL,
                        loc2Label: LOC2_LABEL,
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
     * Carga los projection records del Prebook para obtener los finished items.
     * Reutiliza el mismo record type que R1.
     *
     * @param  {string} prebookId
     * @returns {Array<{ itemId: string }>}
     */
    const loadProjections = (prebookId) => {
        const s = search.create({
            type: 'customrecord_sgp_prebook_projection_rp',
            filters: [
                ['custrecord_sgp_prebook_id_detail', 'anyof', prebookId]
            ],
            columns: [
                search.createColumn({ name: 'custrecord_sgp_product_code', label: 'ITEM' })
            ]
        });

        const out = [];
        const paged = s.runPaged({ pageSize: 1000 });
        paged.pageRanges.forEach((pr) => {
            paged.fetch({ index: pr.index }).data.forEach((r) => {
                const itemId = r.getValue({ name: 'custrecord_sgp_product_code' });
                if (itemId) out.push({ itemId: String(itemId) });
            });
        });
        return out;
    };

    /**
     * Trae los componentes de los BOMs de los finished items con su contexto de receta.
     */
    const loadBomComponents = (prebookId) => {

        const sql_generalComponents = `
            SELECT 
                SUBSTR(category.name, 1, 3) AS category_code,
                itm.itemid AS item_name,
                itm.custitem_sgp_last_purchase_price AS item_fob_cost,
                itm.custitem_bc_lastpurchasepricewithoutla AS item_landed_cost,
                brc.description AS description, 
                itm.itemtype AS item_type,
                COUNT(br.billofmaterials) AS billofmaterials_count,
                brc.quantity AS quantity,
                brc.item AS item,
                category.name AS category_name
            FROM 
                BomRevision br
            INNER JOIN 
                BomRevisionComponent brc ON br.id = brc.bomrevision
            INNER JOIN 
                Bom b ON br.billofmaterials = b.id
            INNER JOIN 
                item itm ON brc.item = itm.id
            INNER JOIN 
                customrecord_cseg_sgp_prod_cat category ON category.id = itm.custitem_cseg_sgp_prod_cat
            WHERE 
                b.custrecord_sgp_bom_customer IS NOT NULL 
                AND itm.custitem_cseg_sgp_prod_cat IS NOT NULL
                AND LOWER(BUILTIN.DF(itm.custitem_cseg_sgp_prod_cat)) = 'hardgoods'
            GROUP BY 
                category.name,
                itm.itemid,
                brc.description,
                itm.itemtype,
                itm.custitem_sgp_last_purchase_price,
                itm.custitem_bc_lastpurchasepricewithoutla,
                brc.item,
                brc.quantity
        `;

        const sql_recipes_comp = `
            SELECT 
                brc.item AS item_id,
                b.id AS bom_id,
                b.id AS recipe_id,
                b.name AS recipe_code,
                b.memo AS recipedescription,
                Customer.entityid AS customer_code,
                Customer.altname AS customer_name
            FROM 
                BomRevision br
            INNER JOIN 
                Bom b ON br.billofmaterials = b.id
            INNER JOIN 
                BomRevisionComponent brc ON br.id = brc.bomrevision
            INNER JOIN 
                Customer Customer ON b.custrecord_sgp_bom_customer = Customer.id
            WHERE 
                b.custrecord_sgp_bom_customer IS NOT NULL
            GROUP BY 
                b.id,
                brc.item,
                b.name,
                b.memo,
                Customer.entityid,
                Customer.altname
        `;
        const sql_purchase_orders = `
            SELECT
                SUM(tl.quantity) AS po_quantity,        
                SUM(tl.quantityshiprecv) AS po_received,
                tl.item AS item_id
            FROM 
                transaction t                            
            INNER JOIN 
                transactionline tl ON tl.transaction = t.id
            WHERE 
                t.type = 'PurchOrd'
                AND t.custbody_sgp_report_id = ${prebookId}
                AND tl.mainline = 'F'                    
            GROUP BY                               
                tl.item                                  
        `;
        const sql_beginning_inv = `
            SELECT
                ln.custrecord_bc_prebookbeginv_item AS item_id,
                ln.custrecord_bc_prebbokbegninvq AS quantity
            FROM 
                customrecord_bc_prebookbeginninginvline ln                            
            INNER JOIN 
                customrecord_bc_preebookbeginninginv bg ON bg.id = ln.custrecord_bc_prebookbinv2
            WHERE 
                ln.isinactive = 'F'
                AND bg.custrecordprebook = ${prebookId}                               
        `;

        const sql_prebook_projections = `
            SELECT 
                pj.custrecord_sgp_product_code AS item_id, -- Corregido: Se quita el .id
                pj.custrecord_sgp_prebook_qty AS quantity
            FROM 
                customrecord_sgp_prebook_projection_rp pj
            WHERE 
                pj.custrecord_sgp_prebook_id_detail = ? -- Optimizado: Usar parámetros en lugar de interpolación
                AND pj.isinactive = 'F'
        `;

        let rows = [];
        try {
            const rs_gnl_comp = query.runSuiteQL({ query: sql_generalComponents });
            const results_gnl_comp = rs_gnl_comp.asMappedResults();

            const rs_recipes_comp = query.runSuiteQL({ query: sql_recipes_comp });
            const results_recipes_comp = rs_recipes_comp.asMappedResults();

            const rs_purchase_orders = query.runSuiteQL({ query: sql_purchase_orders });
            const results_purchase_orders = rs_purchase_orders.asMappedResults();

            const rs_beginning_inv = query.runSuiteQL({ query: sql_beginning_inv });
            const results_beginning_inv = rs_beginning_inv.asMappedResults();

            const rs_prebook_projections = query.runSuiteQL({ query: sql_prebook_projections, params: [prebookId] });
            const results_prebook_projections = rs_prebook_projections.asMappedResults();

            // log.debug("HARDGOODS.loadBomComponents", `SQL results - general components: ${JSON.stringify(results_gnl_comp)}`);
            // log.debug("HARDGOODS.loadBomComponents", `SQL results - recipes components: ${JSON.stringify(results_recipes_comp)}`);
            // log.debug("HARDGOODS.loadBomComponents", `SQL results - purchase orders: ${JSON.stringify(results_purchase_orders)}`);
            // log.debug("HARDGOODS.loadBomComponents", `SQL results - beginning inventory: ${JSON.stringify(results_beginning_inv)}`);
            log.debug("HARDGOODS.loadBomComponents", `SQL results - prebook projections: ${JSON.stringify(results_prebook_projections)}`);

            results_gnl_comp.forEach((result) => {
                let recipes = results_recipes_comp.filter(r => String(r.item_id) === String(result.item)).map(r => ({
                    recipeId: r.recipe_id || '',
                    recipe_code: r.recipe_code || '',
                    recipedescription: r.recipedescription || '',
                    customer_code: r.customer_code || '',
                    customer_name: r.customer_name || ''
                })) || [];

                recipes = recipes.sort((a, b) => {
                    if (a.recipe_code < b.recipe_code) return -1;
                    if (a.recipe_code > b.recipe_code) return 1;
                    return 0;
                });

                let poData = results_purchase_orders.find(po => String(po.item_id) === String(result.item));

                let beginningInvData = results_beginning_inv.find(inv => String(inv.item_id) === String(result.item));
                let prebookProjectionData = results_prebook_projections.filter(pj => String(pj.item_id) === String(result.item));
                log.debug("SQL results - prebook projections data", `: ${JSON.stringify(prebookProjectionData)}`);

                rows.push({
                    po_received: poData?.po_received || 0,
                    po_qty: poData?.po_quantity || 0,
                    loc_1_oh: beginningInvData?.quantity || 0,
                    loc_2_oh: beginningInvData?.quantity || 0,
                    cat: result.category_code || result.category_name,
                    product: result.item_name || '',
                    description: result.description || '',
                    type: mapItemType(result.item_type),
                    num_recipes: Number(results_recipes_comp.filter(r => String(r.item_id) === String(result.item)).length) || 0,
                    fob_cost: (result.item_fob_cost) || 0,
                    landed_cost: (result.item_landed_cost) || 0,
                    componentItemId: String(result.item),
                    componentQty: Number(result.quantity) || 0,
                    prebookProjectionQty: Number(prebookProjectionData?.quantity) || 0,
                    totalUnits: (Number(result.quantity) || 0) * (Number(prebookProjectionData?.quantity) || 1),
                    recipes: recipes
                });
            });
            rows = rows.sort((a, b) => {
                if (a.num_recipes > b.num_recipes) return -1;
                if (a.num_recipes < b.num_recipes) return 1;
                return 0;
            });
            log.debug("HARDGOODS.loadBomComponents", `Loaded BOM components with recipe context: ${JSON.stringify(rows)}`);
        } catch (e) {
            log.error('HARDGOODS.loadBomComponents', `SQL error: ${e.message}`);
        }
        return rows;
    };

    /**
     * Item master para los componentes hardgoods.
     */
    const loadItemMaster = (itemIds) => {
        if (!itemIds.length) return {};

        const inClause = itemIds.map(Number).join(', ');

        const sql = `
            SELECT
                item.internalid,
                item.itemid                                   AS product,
                item.displayname                              AS description,
                item.itemtype                                     AS type,
                item.custitem_sgp_last_purchase_price         AS fob_cost,
                item.custitem_bc_lastpurchasepricewithoutla   AS landed_cost
            FROM item item
        `;

        let map = {};
        try {
            const rs = query.runSuiteQL({ query: sql });
            rs.results.forEach((r, index) => {
                const v = r.values;
                const id = v[0];
                log.debug(`HARDGOODS.loadItemMaster - processing item ${index + 1}/${itemIds.length}: ID ${id}`);
                map[id] = {
                    product: v[1] || '',
                    description: v[2] || '',
                    type: (v[3]),
                    cat: '',              // se rellena con enrichWithCatText
                    fobCost: Number(v[4]) || 0,
                    landedCost: Number(v[5]) || 0
                };
                return true;
            });
            log.debug("HARDGOODS.loadItemMaster", `Loaded item master for ${JSON.stringify(map)} items.`);
        } catch (e) {
            log.error('HARDGOODS.loadItemMaster', `SQL error: ${e.message}`);
        }

        // Segunda pasada: texto legible del custom segment CAT
        enrichWithCatText(itemIds, map);

        return map;
    };

    /**
     * Enriquece el mapa de items con el texto del custom segment CAT.
     */
    const enrichWithCatText = (itemIds, masterMap) => {
        try {
            const s = search.create({
                type: search.Type.ITEM,
                filters: [['internalid', 'anyof', itemIds]],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'custitem_cseg_sgp_prod_cat' })
                ]
            });

            s.run().each((r) => {
                const id = r.getValue({ name: 'internalid' });
                if (masterMap[id]) {
                    masterMap[id].cat =
                        r.getText({ name: 'custitem_cseg_sgp_prod_cat' }) ||
                        r.getValue({ name: 'custitem_cseg_sgp_prod_cat' }) || '';
                }
                return true;
            });
        } catch (e) {
            log.error('HARDGOODS.enrichWithCatText', e.message);
        }
    };

    /**
     * Inventario On Hand por ubicación (LOC1 y LOC2) para los componentes.
     */
    const loadInventoryByLocation = (itemIds) => {
        if (!itemIds.length) return {};

        const inClause = itemIds.map(Number).join(', ');

        const sql = `
            SELECT
                invbal.item,
                invbal.location,
                SUM(invbal.quantityonhand) AS oh_qty
            FROM InventoryBalance invbal
            WHERE invbal.item     IN (${inClause})
            GROUP BY invbal.item, invbal.location
        `;

        const map = {};
        try {
            const rs = query.runSuiteQL({ query: sql });
            rs.results.forEach((r) => {
                const v = r.values;
                const itemId = String(v[0]);
                const locId = Number(v[1]);
                const qty = Number(v[2]) || 0;

                if (!map[itemId]) map[itemId] = { loc1: 0, loc2: 0 };
                /**if (locId === LOC1_ID)**/ map[itemId].loc1 = qty;
                /**if (locId === LOC2_ID)**/ map[itemId].loc2 = qty;
            });
        } catch (e) {
            log.error('HARDGOODS.loadInventoryByLocation', `SQL error: ${e.message}`);
        }
        return map;
    };

    /**
     * PO QTY y PO RECEIVED filtrados por custbody_sgp_report_id = prebookId.
     */
    const loadPoData = (itemIds, prebookId) => {
        if (!itemIds.length || !prebookId) return {};

        const inClause = itemIds.map(Number).join(', ');

        const sql = `
            SELECT
                tl.item,
                SUM(tl.quantity)          AS po_qty,
                -- quantityshiprecv almacena lo recibido en transacciones de compra
                SUM(tl.quantityshiprecv)  AS po_received 
            FROM 
                transaction t
            INNER JOIN 
                transactionline tl ON tl.transaction = t.id
            WHERE t.type                 = 'PurchOrd'
            AND t.custbody_sgp_report_id = ${Number(prebookId)}
            AND tl.item                 IN (${inClause})
            AND tl.mainline              = 'F'
            GROUP BY tl.item
        `;

        const map = {};
        try {
            const rs = query.runSuiteQL({ query: sql });
            rs.results.forEach((r) => {
                const v = r.values;
                const itemId = String(v[0]);
                map[itemId] = {
                    poQty: Number(v[1]) || 0,
                    poReceived: Number(v[2]) || 0
                };
            });
        } catch (e) {
            log.error('HARDGOODS.loadPoData', `SQL error: ${e.message}`);
        }
        return map;
    };

    // =========================================================================
    // CONSOLIDACIÓN
    // =========================================================================

    /**
     * Cuenta cuántas recetas distintas (por nombre de BOM) usan cada componente,
     * dentro del contexto del Prebook (solo los BOMs de sus finished items).
     *
     * @param  {Array} bomRows
     * @returns {Object} { componentItemId: number }
     */
    const buildRecipeCountMap = (bomRows) => {
        const sets = {};
        bomRows.forEach((r) => {
            const key = r.componentItemId;
            if (!sets[key]) sets[key] = new Set();
            sets[key].add(r.recipeCode);
        });
        const out = {};
        Object.keys(sets).forEach((k) => { out[k] = sets[k].size; });
        return out;
    };

    /**
     * Construye el arreglo final de filas del reporte.
     * Una fila por cada par (componente × receta).
     *
     * Campos de cada fila:
     *   CAT, PRODUCT, DESCRIPTION, TYPE          — Item level
     *   NUM_RECIPES                               — Item level (count)
     *   CODE_DESCRIPTION, CUST, CUSTOMER_NAME     — Recipe level (BOM)
     *   TOTAL_UNITS                               — BOM component.quantity (sin multiplicar por demanda)
     *   PLUS_MINUS                                — (LOC1 + LOC2) - TOTAL_UNITS  (+surplus / -shortage)
     *   FOB_COST, LANDED_COST                     — Item costing
     *   LOC1_OH_UNITS, LOC2_OH_UNITS              — Inventory by location
     *   PO_QTY, PO_RECEIVED                       — Purchase Orders (filtradas por prebook)
     *   PREP_PRODUCTION                           — null (TBD)
     *   _sortCat, _sortProduct                    — Auxiliares de sort (eliminar antes de renderizar)
     *
     * @returns {Array<Object>}
     */
    const consolidateRows = (bomRows, itemMaster, inventoryMap, poMap, recipeCountMap) => {
        const rows = bomRows.map((bom) => {
            const id = bom.componentItemId;
            const item = itemMaster[id] || {};
            const inv = inventoryMap[id] || { loc1: 0, loc2: 0 };
            const po = poMap[id] || { poQty: 0, poReceived: 0 };

            const totalOnHand = inv.loc1 + inv.loc2;
            const plusMinus = totalOnHand - bom.componentQty;   // + surplus / - shortage

            return {
                // ── Item level ──────────────────────────────────────────────
                CAT: item.cat || '',
                PRODUCT: item.product || '',   // MPN (itemid)
                DESCRIPTION: item.description || '',
                TYPE: item.type || '',
                NUM_RECIPES: recipeCountMap[id] || 0,

                // ── Recipe level ────────────────────────────────────────────
                CODE_DESCRIPTION: bom.recipeCode || '',   // BillOfMaterials.name
                CUST: bom.custCode || '',
                CUSTOMER_NAME: bom.customerName || '',

                // ── Calculated ──────────────────────────────────────────────
                TOTAL_UNITS: bom.componentQty,         // qty en el BOM (sin multiplicar por demanda)
                PLUS_MINUS: plusMinus,                // positivo = surplus, negativo = shortage

                // ── Costing ─────────────────────────────────────────────────
                FOB_COST: item.fobCost || 0,    // custitem_sgp_last_purchase_price
                LANDED_COST: item.landedCost || 0,    // custitem_bc_lastpurchasepricewithoutla

                // ── Inventory by Location ───────────────────────────────────
                LOC1_OH_UNITS: inv.loc1,
                LOC2_OH_UNITS: inv.loc2,

                // ── Purchase Orders ─────────────────────────────────────────
                PO_RECEIVED: po.poReceived,
                PO_QTY: po.poQty,

                // ── TBD ─────────────────────────────────────────────────────
                PREP_PRODUCTION: null,

                // ── Sort helpers (el render puede ignorarlos o eliminarlos) ─
                // _sortCat: leadingNumber(item.cat),
                // _sortProduct: leadingNumber(item.product)
            };
        });

        // Ordenar: CAT (numérico) → PRODUCT (numérico) → PRODUCT (alfanumérico)
        rows.sort((a, b) => {
            if (a._sortCat !== b._sortCat) return a._sortCat - b._sortCat;
            if (a._sortProduct !== b._sortProduct) return a._sortProduct - b._sortProduct;
            return String(a.PRODUCT).localeCompare(String(b.PRODUCT));
        });

        return rows;
    };

    // =========================================================================
    // RENDER
    // =========================================================================

    /**
     * Renderiza el reporte como PDF usando el Advanced PDF Template.
     *
     * Aliases expuestos al template FreeMarker:
     *   record → customrecord_sgp_prebook  (header, fechas, nombre)
     *   data   → { report: rows[], metadata: { loc1Label, loc2Label, ... } }
     *
     * @param  {string}        prebookId
     * @param  {Array<Object>} rows       — Arreglo consolidado de filas
     * @param  {Object}        metadata
     * @returns {{ fileObj: File, contentType: 'PDF', filename: string }}
     */
    const renderFinalPdf = (prebookId, rows, metadata) => {
        const renderer = render.create();
        renderer.setTemplateById(HG_TEMPLATE_ID);

        // Cargar el record del Prebook para que el template acceda a sus campos
        const preBookObj = record.load({
            type: 'customrecord_sgp_prebook',
            id: prebookId
        });
        renderer.addRecord('record', preBookObj);

        // Inyectar las filas y metadata como fuente de datos JSON
        renderer.addCustomDataSource({
            format: render.DataSource.JSON,
            alias: 'data',
            data: JSON.stringify({ report: rows, metadata: metadata })
        });

        const pdfFile = renderer.renderAsPdf();
        const filename = `HG_BuyingReport_${prebookId}_${nowStamp()}.pdf`;
        pdfFile.name = filename;

        return { fileObj: pdfFile, contentType: 'PDF', filename: filename };
    };

    // =========================================================================
    // MISC HELPERS
    // =========================================================================

    /**
     * Mapea el type interno de NetSuite al texto legible para el reporte.
     * Agregar entradas según los tipos de item que maneje el proyecto.
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
     * Devuelve el primer número de un string (para sort numérico).
     * "GR 28" → 28 | "1.1" → 1.1 | sin número → MAX_SAFE_INTEGER
     */
    const leadingNumber = (s) => {
        if (!s) return Number.MAX_SAFE_INTEGER;
        const m = String(s).match(/(\d+(\.\d+)?)/);
        return m ? parseFloat(m[1]) : Number.MAX_SAFE_INTEGER;
    };

    /**
     * Timestamp compacto para el nombre del archivo.
     * Formato: YYYYMMDD_HHmm
     */
    const nowStamp = () => {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    };

    /**
     * Cuando no hay datos renderiza igualmente el PDF con el template
     * (que muestra el mensaje "No hardgoods data to display…").
     */
    const buildEmptyResponse = (format, prebookId) => {
        const metadata = {
            prebookId: prebookId,
            format: format,
            generatedAt: new Date().toISOString(),
            loc1Label: LOC1_LABEL,
            loc2Label: LOC2_LABEL,
            totalRows: 0
        };
        return renderFinalPdf(prebookId, [], metadata);
    };

    // =========================================================================
    return {
        getMetadata,
        getFilterDefinitions,
        validateFilters,
        generate
    };
});
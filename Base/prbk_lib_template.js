/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * LIBRERÍA PLANTILLA — Punto de partida para crear un reporte nuevo.
 *
 * Cómo usar:
 *   1. Copia este archivo y renómbralo `prbk_lib_rN_<descripcion>.js`
 *      (ej: prbk_lib_r2_orders_by_customer.js).
 *   2. Súbelo al File Cabinet en la misma carpeta que el shell
 *      (ej: /SuiteScripts/Sutton/Preebook/).
 *   3. Crea un renglón en `customrecord_sgp_rpt_registry`:
 *        - Name             = nombre user-friendly (ej. "Orders by Customer")
 *        - Code             = código corto (ej. "R2")
 *        - Library Path     = ruta SuiteScript SIN .js
 *                             (ej. "/SuiteScripts/Sutton/Preebook/prbk_lib_r2_orders_by_customer")
 *        - Active           = T
 *        - Order            = 20 (ordena la posición en el dropdown)
 *   4. Ajusta los métodos getMetadata, getFilterDefinitions y generate
 *      según el reporte que estás construyendo.
 *
 * Contrato que el shell exige:
 *   - getMetadata()           -> { id, name, description?, formats? }
 *   - getFilterDefinitions()  -> [ {id, label, type, ...} ]
 *   - generate(filterValues)  -> { fileObj, contentType, filename } | { html }
 *
 * Contrato OPCIONAL (previsualización — recomendado para reportes con Excel/PDF):
 *   - getPreviewData(filterValues) -> { title, prebookName?, metaLines?, headers, rows, rowCount? }
 *     Si esta función existe, el shell muestra primero una pantalla de preview
 *     (HTML moderno, misma estructura de columnas/filas que el Excel) ANTES de
 *     generar el archivo. Los botones Download Excel/PDF de esa pantalla
 *     re-postean al shell con action=generate, que sigue llamando a generate()
 *     normalmente — no hay que duplicar ninguna lógica de generación de archivo.
 *
 *     - headers: Array<string> — mismo orden/nombres que usa crearExcel/crearPDF.
 *     - rows:    Array<Array<string>> — una fila por renglón de tabla, MISMA
 *                estructura que las filas del Excel (incluye sub-filas si tu
 *                reporte las tiene, ej. varias recetas por item — ver R1).
 *     - metaLines (opcional): líneas de cabecera informativas (ej. rango de
 *                fechas, "WO720 Report #...", etc.), se muestran arriba de la tabla.
 *
 *     Convención para el botón de formato: marca el filtro de formato con
 *     `previewChoice: true` en getFilterDefinitions() (ver ejemplo abajo). El
 *     shell lo OCULTA del formulario de filtros cuando hay preview disponible,
 *     y genera un botón de descarga por cada opción de ese filtro (EXCEL/PDF),
 *     acotado a `getMetadata().formats`.
 *
 *     Si NO implementas getPreviewData(), el reporte sigue funcionando exactamente
 *     como antes: botón "Generate Report" → generate() directo, sin pantalla
 *     intermedia. Es 100% compatible hacia atrás.
 *
 * Tipos de filtro soportados por el shell:
 *   text, longtext, textarea, integer, float, currency, percent,
 *   date, datetime, checkbox, select, multiselect.
 *
 *   Para SELECT/MULTISELECT puedes usar:
 *     - source: 'customrecord_xxx' o 'employee' / 'customer' / 'item' / etc. (lista nativa o custom)
 *     - options: [{ value, text }, ...] para listas inline
 *
 *   Otras propiedades por filtro:
 *     - mandatory     : boolean (el shell valida antes de llamar generate)
 *     - defaultValue  : valor inicial
 *     - helpText      : tooltip de NetSuite
 *     - placeholder   : texto del option vacío en SELECT no-mandatory
 *     - readonly      : true => INLINE (no editable)
 *     - previewChoice : true => el shell lo oculta del form y lo convierte en
 *                       botones de descarga en la pantalla de preview (ver arriba).
 *                       Úsalo en el filtro tipo select de formato (EXCEL/PDF).
 */
define([
    'N/log',
    'N/search',
    'N/record',
    'N/file',
    './prbk_lib_reports_common'
], (log, search, record, file, common) => {

    // -----------------------------------------------------------------------
    // 1. METADATA — Quién es este reporte
    // -----------------------------------------------------------------------

    const getMetadata = () => ({
        id: 'TEMPLATE',
        name: 'Template Report',
        description: 'Base template. Replace this text with the report\'s real description.',
        formats: ['PDF']   // o ['EXCEL'], ['CSV'], ['HTML'], etc.
    });

    // -----------------------------------------------------------------------
    // 2. FILTROS — Qué pregunta el shell al usuario antes de generar
    // -----------------------------------------------------------------------

    const getFilterDefinitions = () => ([
        {
            id: 'prebook',
            label: 'Prebook',
            type: 'select',
            source: 'customrecord_sgp_prebook',
            mandatory: true,
            helpText: 'Seleccione el Preebook del cual se generará el reporte.'
        }
        // Ejemplo del filtro de formato con soporte de preview (ver R1/R2):
        // {
        //   id: 'output_format',
        //   label: 'Tipo de documento',
        //   type: 'select',
        //   mandatory: true,
        //   options: [
        //     { value: 'EXCEL', text: 'Excel' },
        //     { value: 'PDF', text: 'PDF' }
        //   ],
        //   helpText: 'Seleccione el formato del documento a generar (Excel o PDF).',
        //   previewChoice: true   // el shell lo oculta del form y lo vuelve botón de descarga
        // },
        //
        // Ejemplos adicionales para referencia (descomentar y adaptar):
        //
        // {
        //   id: 'date_from',
        //   label: 'Date From',
        //   type: 'date',
        //   mandatory: true,
        //   helpText: 'Fecha inicial del rango.'
        // },
        // {
        //   id: 'mode',
        //   label: 'Mode',
        //   type: 'select',
        //   mandatory: true,
        //   options: [
        //     { value: 'detail',  text: 'Detail by line' },
        //     { value: 'summary', text: 'Summary by item' }
        //   ],
        //   defaultValue: 'summary'
        // },
        // {
        //   id: 'customers',
        //   label: 'Customers',
        //   type: 'multiselect',
        //   source: 'customer',
        //   mandatory: false,
        //   helpText: 'Si se deja vacío, incluye todos los clientes.'
        // }
    ]);

    // -----------------------------------------------------------------------
    // 3. (Opcional) Validación cross-field — el shell ya valida mandatory.
    //    Devolver { valid: false, message: '...' } para abortar generate().
    // -----------------------------------------------------------------------
    //
    // const validateFilters = (values) => {
    //     if (values.date_from && values.date_to && values.date_from > values.date_to) {
    //         return { valid: false, message: 'Date From debe ser anterior a Date To.' };
    //     }
    //     return { valid: true };
    // };

    // -----------------------------------------------------------------------
    // 3b. (Opcional, recomendado) GET PREVIEW DATA — misma data que generate(),
    //     pero como JSON plano (headers + rows) en vez de archivo. Ver R1/R2
    //     para un ejemplo real con sub-filas. No genera ningún archivo.
    // -----------------------------------------------------------------------
    //
    // const getPreviewData = (filterValues) => {
    //     const headers = ['Column A', 'Column B'];
    //     const rows = [
    //         ['valor 1', 'valor 2'],
    //         ['valor 3', 'valor 4']
    //     ];
    //     return {
    //         title: 'Template Report',
    //         prebookName: filterValues.prebook,
    //         metaLines: [ `Prebook: ${filterValues.prebook}` ],
    //         headers: headers,
    //         rows: rows,
    //         rowCount: rows.length
    //     };
    // };

    // -----------------------------------------------------------------------
    // 4. GENERATE — Produce la salida del reporte
    //
    //    Recibe un objeto plano con los valores de los filtros (claves = filter.id).
    //    Debe devolver una de estas formas:
    //
    //    a) PDF / Excel / CSV (archivo binario):
    //       { fileObj: <File>, contentType: 'PDF'|'EXCEL'|'CSV', filename: 'algo.pdf' }
    //
    //    b) HTML inline (visualización en el navegador):
    //       { html: '<div>...</div>' }
    //          o bien
    //       { fileObj: file.create({type:HTMLDOC,...}), contentType: 'HTML', filename: '...' }
    // -----------------------------------------------------------------------

    const generate = (filterValues) => {
        log.audit('TEMPLATE.generate', `filters=${JSON.stringify(filterValues)}`);

        // Ejemplo trivial: devolver un HTML estático con los filtros recibidos
        const rows = Object.keys(filterValues).map((k) => `<tr><td>${k}</td><td>${filterValues[k]}</td></tr>`).join('');

        const html = `
            <!DOCTYPE html>
            <html><head><meta charset="utf-8"><title>Template Report</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 24px; }
                table { border-collapse: collapse; }
                td, th { border: 1px solid #aaa; padding: 6px 10px; }
                th { background: #eee; }
            </style></head><body>
            <h2>Template Report</h2>
            <p>This is the template's placeholder output. Replace the <code>generate()</code> implementation.</p>
            <table><tr><th>Filter</th><th>Value</th></tr>${rows}</table>
            </body></html>
        `;

        return { html: html };
    };

    return {
        getMetadata,
        getFilterDefinitions,
        // validateFilters,   // <- descomentar si lo implementan
        // getPreviewData,    // <- descomentar si implementan preview (recomendado)
        generate
    };
});

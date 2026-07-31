/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
// Librería plantilla — punto de partida para crear un reporte nuevo. Ver Desarrollo/BASE.md para la guía completa.
define([
    'N/log',
    'N/search',
    'N/record',
    'N/file',
    './prbk_lib_reports_common'
], (log, search, record, file, common) => {

    // 1. Metadata — quién es este reporte.
    const getMetadata = () => ({
        id: 'TEMPLATE',
        name: 'Template Report',
        description: 'Base template. Replace this text with the report\'s real description.',
        formats: ['PDF']   // o ['EXCEL'], ['CSV'], ['HTML'], etc.
    });

    // 2. Filtros — qué le pregunta el shell al usuario antes de generar.
    const getFilterDefinitions = () => ([
        {
            id: 'prebook',
            label: 'Prebook',
            type: 'select',
            source: 'customrecord_sgp_prebook',
            mandatory: true,
            helpText: 'Seleccione el Preebook del cual se generará el reporte.'
        }
        // Filtro de formato con preview (ver R1/R2):
        // {
        //   id: 'output_format',
        //   label: 'Tipo de documento',
        //   type: 'select',
        //   mandatory: true,
        //   options: [
        //     { value: 'EXCEL', text: 'Excel' },
        //     { value: 'PDF', text: 'PDF' }
        //   ],
        //   previewChoice: true
        // },
        //
        // Otros ejemplos de filtro:
        // {
        //   id: 'date_from',
        //   label: 'Date From',
        //   type: 'date',
        //   mandatory: true
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
        //   mandatory: false
        // }
    ]);

    // 3. (Opcional) Validación cross-field — devolver { valid: false, message } para abortar generate().
    //
    // const validateFilters = (values) => {
    //     if (values.date_from && values.date_to && values.date_from > values.date_to) {
    //         return { valid: false, message: 'Date From debe ser anterior a Date To.' };
    //     }
    //     return { valid: true };
    // };

    // 3b. (Opcional) Preview — misma data que generate() en JSON plano, sin generar archivo.
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

    // 4. Generate — produce la salida del reporte (archivo o HTML inline).
    const generate = (filterValues) => {
        log.audit('TEMPLATE.generate', `filters=${JSON.stringify(filterValues)}`);

        // Ejemplo trivial: devolver un HTML estático con los filtros recibidos.
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

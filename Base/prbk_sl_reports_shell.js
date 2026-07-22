/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * SUITELET SHELL — Cascarón dinámico para reportes del Preebook.
 *
 * Arquitectura plugin/registry:
 *   - Este Suitelet NO contiene lógica de reportes. Es 100% agnóstico.
 *   - El catálogo de reportes vive en el registro custom `customrecord_sgp_rpt_registry`.
 *     Cada renglón del registro apunta a una librería SuiteScript (campo libpath) que
 *     implementa el contrato { getMetadata, getFilterDefinitions, generate }.
 *   - El shell:
 *       1. Lee el catálogo de reportes activos del registro.
 *       2. Pinta un dropdown "Report" — y nada más, hasta que el usuario elija.
 *       3. Cuando el usuario elige reporte, refresca el form vía POST y pinta
 *          dinámicamente los filtros declarados por la librería.
 *       4. Cuando el usuario hace clic en "Generate Report", llama a lib.generate(filterValues)
 *          y entrega el resultado (PDF inline, Excel/CSV download, o HTML inline).
 *
 * Para agregar un nuevo reporte: crear su librería (ver prbk_lib_template.js) +
 * crear un registro nuevo en customrecord_sgp_rpt_registry apuntando a esa librería.
 * No requiere tocar este Suitelet.
 */
define([
    'N/log',
    'N/ui/serverWidget',
    'N/search',
    'N/runtime',
    'N/url'
], (log, serverWidget, search, runtime, url) => {

    // -----------------------------------------------------------------------
    // Constantes
    // -----------------------------------------------------------------------

    const REGISTRY_RECORD = 'customrecord_sgp_rpt_registry';
    const REGISTRY_FIELDS = {
        NAME:        'name',
        CODE:        'custrecord_sgp_rpt_code',
        LIBPATH:     'custrecord_sgp_rpt_libpath',
        ACTIVE:      'custrecord_sgp_rpt_active',
        ORDER:       'custrecord_sgp_rpt_order',
        DESCRIPTION: 'custrecord_sgp_rpt_description'
    };

    // IDs de campos internos del form
    const FLD_REPORT = 'custpage_report';
    const FLD_ACTION = 'custpage_action';        // 'load_filters' | 'generate'
    const FLD_FILTER_PREFIX = 'custpage_f_';     // prefijo para campos de filtros dinámicos

    const ACTION_LOAD_FILTERS = 'load_filters';
    const ACTION_GENERATE     = 'generate';

    // -----------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------

    const onRequest = (ctx) => {
        try {
            const reports = loadReportRegistry();
            log.audit('shell.onRequest', `method=${ctx.request.method} reports_active=${reports.length}`);

            if (!reports.length) {
                ctx.response.write(htmlError(
                    'No hay reportes configurados',
                    `Crea al menos un renglón en el registro <b>${REGISTRY_RECORD}</b> con un <b>${REGISTRY_FIELDS.LIBPATH}</b> válido.`
                ));
                return;
            }

            const params = ctx.request.parameters || {};
            const selectedReportCode = (params[FLD_REPORT] || '').trim();
            const action = (params[FLD_ACTION] || ACTION_LOAD_FILTERS).trim();

            // GET inicial o sin reporte seleccionado: pintar form básico
            if (!selectedReportCode) {
                renderForm(ctx, reports, null, null, params);
                return;
            }

            // Localizar la entrada del registro
            const entry = reports.find((r) => r.code === selectedReportCode);
            if (!entry) {
                ctx.response.write(htmlError(
                    `Reporte '${selectedReportCode}' no encontrado`,
                    'Es posible que se haya inactivado. Vuelve a la página principal del Suitelet.'
                ));
                return;
            }

            // Cargar la librería dinámicamente vía require asíncrono (patrón SS2.x)
            require([entry.libpath], (lib) => {
                try {
                    validateLibrary(lib, entry);

                    if (ctx.request.method === 'POST' && action === ACTION_GENERATE) {
                        handleGenerate(ctx, lib, entry, params);
                    } else {
                        // Default: mostrar form con filtros del reporte seleccionado
                        renderForm(ctx, reports, entry, lib, params);
                    }
                } catch (innerEx) {
                    log.error('shell.libraryRun', `${entry.code}: ${innerEx.name} ${innerEx.message}\n${innerEx.stack || ''}`);
                    ctx.response.write(htmlError(
                        `Error en librería ${entry.code}`,
                        `${innerEx.name}: ${escapeHtml(innerEx.message)}`
                    ));
                }
            }, (loadErr) => {
                log.error('shell.libraryLoad', `No se pudo cargar ${entry.libpath}: ${loadErr && loadErr.message}`);
                ctx.response.write(htmlError(
                    `No se pudo cargar la librería '${entry.libpath}'`,
                    'Verifica que la ruta sea correcta (sin extensión .js) y que el archivo exista en el File Cabinet.'
                ));
            });

        } catch (ex) {
            log.error('shell.onRequest', `${ex.name} ${ex.message}\n${ex.stack || ''}`);
            ctx.response.write(htmlError('Error inesperado en el shell', `${ex.name}: ${escapeHtml(ex.message)}`));
        }
    };

    // -----------------------------------------------------------------------
    // Carga del catálogo de reportes
    // -----------------------------------------------------------------------

    const loadReportRegistry = () => {
        const out = [];
        try {
            const s = search.create({
                type: REGISTRY_RECORD,
                filters: [
                    ['isinactive', 'is', 'F']
                ],
                columns: [
                    search.createColumn({ name: REGISTRY_FIELDS.NAME }),
                    search.createColumn({ name: REGISTRY_FIELDS.CODE }),
                    search.createColumn({ name: REGISTRY_FIELDS.LIBPATH }),
                    search.createColumn({ name: REGISTRY_FIELDS.ORDER, sort: search.Sort.ASC }),
                    search.createColumn({ name: REGISTRY_FIELDS.DESCRIPTION })
                ]
            });

            const paged = s.runPaged({ pageSize: 200 });
            paged.pageRanges.forEach((pr) => {
                paged.fetch({ index: pr.index }).data.forEach((r) => {
                    const code = String(r.getValue({ name: REGISTRY_FIELDS.CODE }) || '').trim();
                    const libpath = String(r.getValue({ name: REGISTRY_FIELDS.LIBPATH }) || '').trim();
                    if (!code || !libpath) return; // entradas mal configuradas se ignoran
                    out.push({
                        id: r.id,
                        code: code,
                        name: r.getValue({ name: REGISTRY_FIELDS.NAME }) || code,
                        libpath: libpath,
                        order: Number(r.getValue({ name: REGISTRY_FIELDS.ORDER })) || 0,
                        description: r.getValue({ name: REGISTRY_FIELDS.DESCRIPTION }) || ''
                    });
                });
            });
        } catch (ex) {
            log.error('shell.loadReportRegistry', `${ex.name} ${ex.message}`);
        }
        return out;
    };

    // -----------------------------------------------------------------------
    // Validación del contrato de la librería
    // -----------------------------------------------------------------------

    const validateLibrary = (lib, entry) => {
        if (!lib || typeof lib !== 'object') {
            throw new Error(`La librería ${entry.libpath} no exporta un objeto.`);
        }
        if (typeof lib.getMetadata !== 'function') {
            throw new Error(`La librería ${entry.code} no implementa getMetadata().`);
        }
        if (typeof lib.getFilterDefinitions !== 'function') {
            throw new Error(`La librería ${entry.code} no implementa getFilterDefinitions().`);
        }
        if (typeof lib.generate !== 'function') {
            throw new Error(`La librería ${entry.code} no implementa generate().`);
        }
    };

    // -----------------------------------------------------------------------
    // Render del form (modo "selección de reporte" + modo "filtros")
    // -----------------------------------------------------------------------

    const renderForm = (ctx, reports, entry, lib, params) => {
        const form = serverWidget.createForm({ title: 'Preebook Reports' });

        // Client script asociado: dispara refresh server-side cuando cambia
        // el dropdown de reporte (ver prbk_cs_reports_shell.js).
        form.clientScriptModulePath = './prbk_cs_reports_shell.js';

        // Dropdown principal de selección de reporte
        const reportField = form.addField({
            id: FLD_REPORT,
            type: serverWidget.FieldType.SELECT,
            label: 'Report'
        });
        reportField.isMandatory = true;
        reportField.addSelectOption({ value: '', text: '-- Select a report --' });
        reports
            .slice()
            .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name))
            .forEach((r) => {
                reportField.addSelectOption({ value: r.code, text: r.name });
            });
        if (entry) reportField.defaultValue = entry.code;

        // Campo oculto que indica la acción a ejecutar (load_filters | generate)
        const actionField = form.addField({
            id: FLD_ACTION,
            type: serverWidget.FieldType.TEXT,
            label: 'Action (internal)'
        });
        actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        actionField.defaultValue = entry ? ACTION_GENERATE : ACTION_LOAD_FILTERS;

        // Si ya hay reporte seleccionado, renderizar su sección de filtros
        if (entry && lib) {
            renderLibrarySection(form, entry, lib, params);
            form.addSubmitButton({ label: 'Generate Report' });
        } else {
            form.addSubmitButton({ label: 'Continue' });
        }

        // Nota: la lógica de "auto-refresh al cambiar el dropdown de reporte"
        // vive en el Client Script asociado (prbk_cs_reports_shell.js), enlazado
        // arriba vía form.clientScriptModulePath.

        ctx.response.writePage(form);
    };

    /**
     * Pinta la sección específica del reporte: cabecera con descripción + filtros declarados.
     */
    const renderLibrarySection = (form, entry, lib, params) => {
        const meta = safeCall(() => lib.getMetadata(), {});
        const filters = safeCall(() => lib.getFilterDefinitions(), []) || [];

        // Cabecera con descripción / metadata
        const headerHtml = buildHeaderHtml(entry, meta);
        const headerFld = form.addField({
            id: 'custpage_header',
            type: serverWidget.FieldType.INLINEHTML,
            label: ' '
        });
        headerFld.defaultValue = headerHtml;

        // Group "Filters" para los filtros dinámicos
        if (filters.length) {
            form.addFieldGroup({ id: 'custpage_fg_filters', label: 'Filters' });
            filters.forEach((def) => {
                const fld = addDynamicField(form, def);
                if (!fld) return;
                // Si vino del POST anterior, conservar el valor
                const submittedKey = FLD_FILTER_PREFIX + def.id;
                const submittedVal = params[submittedKey];
                if (submittedVal !== undefined && submittedVal !== '') {
                    try { fld.defaultValue = submittedVal; } catch (e) { /* ignore */ }
                } else if (def.defaultValue !== undefined && def.defaultValue !== null) {
                    try { fld.defaultValue = def.defaultValue; } catch (e) { /* ignore */ }
                }
            });
        } else {
            const noFiltersFld = form.addField({
                id: 'custpage_nofilters',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });
            noFiltersFld.defaultValue = '<p style="color:#666;margin:8px 0;">This report has no filters.</p>';
        }
    };

    /**
     * Convierte una definición de filtro de la librería en un campo de form de NetSuite.
     */
    const addDynamicField = (form, def) => {
        if (!def || !def.id) return null;

        const fieldId = FLD_FILTER_PREFIX + def.id;
        const label = def.label || def.id;
        const type = String(def.type || 'text').toLowerCase();

        let fnsType;
        switch (type) {
            case 'text':        fnsType = serverWidget.FieldType.TEXT; break;
            case 'longtext':    fnsType = serverWidget.FieldType.LONGTEXT; break;
            case 'textarea':    fnsType = serverWidget.FieldType.TEXTAREA; break;
            case 'integer':     fnsType = serverWidget.FieldType.INTEGER; break;
            case 'float':       fnsType = serverWidget.FieldType.FLOAT; break;
            case 'currency':    fnsType = serverWidget.FieldType.CURRENCY; break;
            case 'percent':     fnsType = serverWidget.FieldType.PERCENT; break;
            case 'date':        fnsType = serverWidget.FieldType.DATE; break;
            case 'datetime':    fnsType = serverWidget.FieldType.DATETIMETZ; break;
            case 'checkbox':    fnsType = serverWidget.FieldType.CHECKBOX; break;
            case 'select':      fnsType = serverWidget.FieldType.SELECT; break;
            case 'multiselect': fnsType = serverWidget.FieldType.MULTISELECT; break;
            default:
                log.error('shell.addDynamicField', `Tipo de filtro no soportado: ${type} (filter ${def.id})`);
                return null;
        }

        const fieldOpts = {
            id: fieldId,
            type: fnsType,
            label: label,
            container: 'custpage_fg_filters'
        };
        // Para SELECT/MULTISELECT con source de registro o lista nativa
        if ((type === 'select' || type === 'multiselect') && def.source) {
            fieldOpts.source = def.source;
        }

        const fld = form.addField(fieldOpts);

        // Opciones inline (no source) para SELECT/MULTISELECT
        if ((type === 'select' || type === 'multiselect') && Array.isArray(def.options)) {
            // Para SELECT siempre agregar opción vacía al inicio si no es mandatory
            if (type === 'select' && !def.mandatory) {
                fld.addSelectOption({ value: '', text: def.placeholder || '-- Select --' });
            }
            def.options.forEach((opt) => {
                fld.addSelectOption({
                    value: String(opt.value != null ? opt.value : ''),
                    text:  String(opt.text  != null ? opt.text  : opt.value)
                });
            });
        }

        if (def.mandatory) fld.isMandatory = true;
        if (def.helpText) {
            try {
                fld.setHelpText({ help: String(def.helpText), showInlineForAssistant: false });
            } catch (e) { /* ignore */ }
        }
        if (def.readonly) {
            fld.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
        }

        return fld;
    };

    // -----------------------------------------------------------------------
    // Generate handler
    // -----------------------------------------------------------------------

    const handleGenerate = (ctx, lib, entry, params) => {
        const filters = safeCall(() => lib.getFilterDefinitions(), []) || [];

        // Construir mapa de valores de filtros (id -> value)
        const filterValues = {};
        filters.forEach((def) => {
            const submitted = params[FLD_FILTER_PREFIX + def.id];
            filterValues[def.id] = submitted == null ? '' : submitted;
        });

        // Validar obligatorios
        const missing = filters
            .filter((def) => def.mandatory && (filterValues[def.id] === '' || filterValues[def.id] == null))
            .map((def) => def.label || def.id);
        if (missing.length) {
            ctx.response.write(htmlError(
                `Faltan filtros obligatorios`,
                `Por favor proporciona: ${missing.map(escapeHtml).join(', ')}`
            ));
            return;
        }

        // Validación opcional por la librería
        if (typeof lib.validateFilters === 'function') {
            const result = safeCall(() => lib.validateFilters(filterValues), null);
            if (result && result.valid === false) {
                ctx.response.write(htmlError('Filtros inválidos', escapeHtml(result.message || '')));
                return;
            }
        }

        log.audit('shell.generate', `${entry.code} filters=${JSON.stringify(filterValues)}`);

        const output = lib.generate(filterValues);
        if (!output) {
            ctx.response.write(htmlError(`El reporte ${entry.code} no retornó nada`, ''));
            return;
        }

        // Entrega según contentType
        const contentType = String(output.contentType || '').toUpperCase();

        if (output.fileObj) {
            if (output.filename) output.fileObj.name = output.filename;
            const inline = (contentType === 'PDF' || contentType === 'HTML' || contentType === '');
            ctx.response.writeFile({ file: output.fileObj, isInline: inline });
            log.audit('shell.delivered', `${entry.code} -> ${output.filename || output.fileObj.name}`);
            return;
        }

        if (output.html) {
            ctx.response.write(output.html);
            return;
        }

        ctx.response.write(htmlError(
            `El reporte ${entry.code} retornó una salida no reconocida`,
            'Esperaba { fileObj } o { html }.'
        ));
    };

    // -----------------------------------------------------------------------
    // Utilidades varias
    // -----------------------------------------------------------------------

    const buildHeaderHtml = (entry, meta) => {
        const desc = meta.description || entry.description || '';
        const formats = Array.isArray(meta.formats) ? meta.formats.join(' / ') : '';
        return `
            <div style="border:1px solid #d6d6d6;background:#fafafa;padding:10px 14px;margin:6px 0;border-radius:4px;">
                <div style="font-size:13px;color:#333;"><b>${escapeHtml(entry.name)}</b>${
                    formats ? ` <span style="color:#888;">(${escapeHtml(formats)})</span>` : ''
                }</div>
                ${desc ? `<div style="font-size:12px;color:#555;margin-top:4px;">${escapeHtml(desc)}</div>` : ''}
            </div>
        `;
    };

    const htmlError = (title, body) => `
        <div style="font-family:Arial,sans-serif;max-width:780px;margin:40px auto;padding:18px 22px;
                    border:1px solid #d44;border-radius:6px;background:#fff7f7;">
            <h2 style="margin:0 0 8px;color:#a00;">${escapeHtml(title)}</h2>
            <div style="color:#444;line-height:1.4;">${body || ''}</div>
        </div>
    `;

    const escapeHtml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const safeCall = (fn, fallback) => {
        try { return fn(); } catch (e) {
            log.error('shell.safeCall', `${e.name} ${e.message}`);
            return fallback;
        }
    };

    return { onRequest };
});

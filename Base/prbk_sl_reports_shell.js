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
    const ACTION_PREVIEW      = 'preview';   // pantalla de previsualización (nueva)

    // Convención: cualquier filtro marcado `previewChoice: true` en
    // getFilterDefinitions() (típicamente el select de formato Excel/PDF) NO se
    // pinta en el form de filtros cuando la librería soporta preview — se elige
    // desde los botones Download Excel/PDF de la pantalla de previsualización.
    // Ver renderLibrarySection / buildPreviewFragment.

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
                    } else if (ctx.request.method === 'POST' && action === ACTION_PREVIEW) {
                        handlePreview(ctx, reports, lib, entry, params);
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

    const renderForm = (ctx, reports, entry, lib, params, extra) => {
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

        // Si la librería implementa getPreviewData(), el flujo pasa primero por
        // la pantalla de previsualización (nueva); si no, se mantiene el flujo
        // directo a generate() de siempre (compatibilidad hacia atrás).
        const previewSupported = !!(lib && typeof lib.getPreviewData === 'function');

        // Campo oculto que indica la acción a ejecutar (load_filters | preview | generate)
        const actionField = form.addField({
            id: FLD_ACTION,
            type: serverWidget.FieldType.TEXT,
            label: 'Action (internal)'
        });
        actionField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        actionField.defaultValue = entry
            ? (previewSupported ? ACTION_PREVIEW : ACTION_GENERATE)
            : ACTION_LOAD_FILTERS;

        const showingPreview = !!(extra && extra.previewHtml);

        // Si ya hay reporte seleccionado, renderizar su sección de filtros
        if (entry && lib) {
            renderLibrarySection(form, entry, lib, params, previewSupported);
            form.addSubmitButton({
                label: previewSupported ? (showingPreview ? 'Refresh Preview' : 'Preview Report') : 'Generate Report'
            });
        } else {
            form.addSubmitButton({ label: 'Continue' });
        }

        // Nota: la lógica de "auto-refresh al cambiar el dropdown de reporte"
        // vive en el Client Script asociado (prbk_cs_reports_shell.js), enlazado
        // arriba vía form.clientScriptModulePath.

        // Preview embebido: campo INLINEHTML con la tabla del reporte (misma
        // estructura que el Excel), pintado dentro de la MISMA página de NetSuite
        // — no navega a una página aparte. Los botones Download Excel/PDF dentro
        // de este fragmento reusan el form nativo (custpage_action=generate +
        // custpage_f_<formatFilterId>=EXCEL|PDF) vía JS, sin crear un <form> anidado.
        if (showingPreview) {
            const previewFld = form.addField({
                id: 'custpage_preview_html',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });
            previewFld.defaultValue = extra.previewHtml;
        }

        ctx.response.writePage(form);
    };

    /**
     * Pinta la sección específica del reporte: cabecera con descripción + filtros declarados.
     */
    const renderLibrarySection = (form, entry, lib, params, previewSupported) => {
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

        // Filtros visibles en el form: si la librería soporta preview, los marcados
        // `previewChoice` (ej. el formato Excel/PDF) se ocultan aquí — se eligen
        // desde los botones de descarga de la pantalla de previsualización.
        const visibleFilters = previewSupported
            ? filters.filter((def) => !def.previewChoice)
            : filters;

        // Group "Filters" para los filtros dinámicos
        if (visibleFilters.length) {
            form.addFieldGroup({ id: 'custpage_fg_filters', label: 'Filters' });
            visibleFilters.forEach((def) => {
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

        // Campos ocultos (no INLINE, sino HIDDEN de verdad) para los filtros
        // previewChoice (ej. output_format). Quedan fuera de la vista pero SÍ
        // forman parte de `document.forms['main_form']`, para que los botones
        // Download Excel/PDF del preview embebido puedan setear su valor por JS
        // justo antes de enviar el form (ver buildPreviewFragment).
        if (previewSupported) {
            filters.filter((def) => def.previewChoice).forEach((def) => {
                const fieldId = FLD_FILTER_PREFIX + def.id;
                const submittedVal = params[fieldId];
                const hiddenFld = form.addField({
                    id: fieldId,
                    type: serverWidget.FieldType.TEXT,
                    label: def.label || def.id
                });
                hiddenFld.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
                hiddenFld.defaultValue = (submittedVal !== undefined && submittedVal !== '')
                    ? submittedVal
                    : (def.defaultValue || '');
                // Nota: nunca isMandatory=true acá — se llena por JS al hacer clic
                // en Download Excel/PDF, no por entrada directa del usuario. La
                // validación real sigue ocurriendo server-side en handleGenerate().
            });
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
    // Preview handler — arma la data de previsualización y delega en renderForm()
    // para que se pinte EMBEBIDA dentro de la misma página de NetSuite (no navega
    // a una página aparte). Solo se invoca si la librería implementa
    // getPreviewData(). No genera ningún archivo: eso lo sigue haciendo
    // handleGenerate(), sin cambios, cuando el usuario hace clic en Download
    // Excel/PDF dentro del preview embebido.
    // -----------------------------------------------------------------------

    const handlePreview = (ctx, reports, lib, entry, params) => {
        const filters = safeCall(() => lib.getFilterDefinitions(), []) || [];

        // Construir mapa de valores de filtros (id -> value). Los campos marcados
        // previewChoice (típicamente el formato Excel/PDF) no se piden acá: se
        // eligen en los botones de descarga del preview embebido.
        const filterValues = {};
        filters.forEach((def) => {
            const submitted = params[FLD_FILTER_PREFIX + def.id];
            filterValues[def.id] = submitted == null ? '' : submitted;
        });

        // Validar obligatorios, excluyendo los previewChoice (todavía no aplican).
        const missing = filters
            .filter((def) => def.mandatory && !def.previewChoice &&
                (filterValues[def.id] === '' || filterValues[def.id] == null))
            .map((def) => def.label || def.id);
        if (missing.length) {
            ctx.response.write(htmlError(
                `Faltan filtros obligatorios`,
                `Por favor proporciona: ${missing.map(escapeHtml).join(', ')}`
            ));
            return;
        }

        log.audit('shell.preview', `${entry.code} filters=${JSON.stringify(filterValues)}`);

        const previewData = safeCall(() => lib.getPreviewData(filterValues), null);
        if (!previewData || !Array.isArray(previewData.headers)) {
            ctx.response.write(htmlError(
                `This report ${entry.code} do not return any preview data`,
                'Please check script logs. getPreviewData() it must return at least { headers: [...], rows: [...] }.'
            ));
            return;
        }
        if (!Array.isArray(previewData.rows)) previewData.rows = [];

        const meta = safeCall(() => lib.getMetadata(), {});
        const previewHtml = buildPreviewFragment(entry, meta, filters, filterValues, previewData);

        // Repinta el MISMO form (dropdown + filtros) y le agrega el fragmento de
        // preview como campo INLINEHTML — todo dentro de la página de NetSuite.
        renderForm(ctx, reports, entry, lib, params, { previewHtml });
    };

    // Cuántas filas "padre" se muestran por página (las sub-filas de receta que
    // cuelgan de un padre viajan con él y NO cuentan para este límite).
    const PREVIEW_PAGE_SIZE = 10;

    // A partir de cuántas recetas se colapsan las sub-filas adicionales detrás
    // de un toggle "Ver todas las recetas" (ver buildPreviewFragment).
    const PREVIEW_COLLAPSE_THRESHOLD = 5;

    /**
     * Normaliza una entrada de previewData.rows a { cells, subRows, recipeCount }.
     * Soporta tanto el formato plano Array<string> (reportes sin sub-filas, ej. R2)
     * como el formato jerárquico { cells, subRows, recipeCount } (reportes con
     * sub-filas por receta, ej. R1 — ver buildHardgoodsPreviewRows en su librería).
     */
    const normalizePreviewRow = (row) => {
        if (Array.isArray(row)) return { cells: row, subRows: [], recipeCount: null };
        const subRows = Array.isArray(row.subRows)
            ? row.subRows.map((sr) => (Array.isArray(sr) ? { cells: sr } : { cells: sr.cells || [] }))
            : [];
        return {
            cells: row.cells || [],
            subRows: subRows,
            recipeCount: row.recipeCount != null ? row.recipeCount : null
        };
    };

    /**
     * Construye el fragmento HTML embebido (campo INLINEHTML) con la previsualización:
     * misma estructura de columnas/filas que el Excel (ver getPreviewData() de cada
     * librería), con:
     *   - Paginación de a PREVIEW_PAGE_SIZE filas "padre" (data-page en cada <tr>).
     *   - Collapse de sub-filas de receta cuando recipeCount > PREVIEW_COLLAPSE_THRESHOLD,
     *     detrás de un toggle "Ver todas las recetas".
     *   - Botones Download Excel/PDF que reusan el form NATIVO de NetSuite
     *     (custpage_action=generate + custpage_f_<id>=EXCEL|PDF vía JS + submit),
     *     sin crear un <form> anidado — ver window.pbDownload en el <script>.
     * Todo el CSS/IDs están namespaced bajo #pb-preview-root para no chocar con
     * el resto de la página de NetSuite.
     */
    const buildPreviewFragment = (entry, meta, filters, filterValues, previewData) => {
        const formatDef = filters.find((def) => def.previewChoice) || null;
        const formatFieldId = formatDef ? (FLD_FILTER_PREFIX + formatDef.id) : '';

        // Un botón de descarga por cada opción del filtro previewChoice (EXCEL/PDF),
        // acotado a los formatos que la librería declara soportar (getMetadata().formats).
        const supportedFormats = (Array.isArray(meta.formats) ? meta.formats : [])
            .map((f) => String(f).toUpperCase());
        const formatOptions = (formatDef && Array.isArray(formatDef.options)) ? formatDef.options : [];
        const downloadButtons = formatDef ? formatOptions
            .filter((opt) => !supportedFormats.length || supportedFormats.indexOf(String(opt.value).toUpperCase()) !== -1)
            .map((opt) => {
                const isExcel = /excel/i.test(String(opt.value)) || /excel/i.test(String(opt.text));
                const cls = isExcel ? 'pb-btn pb-btn-excel' : 'pb-btn pb-btn-pdf';
                const icon = isExcel ? '&#8681; XLS' : '&#8681; PDF';
                return `<button type="button" class="${cls}" onclick="pbDownload('${escapeHtml(opt.value)}')">${icon}&nbsp;&nbsp;Download ${escapeHtml(opt.text)}</button>`;
            }).join('\n') : '';

        const rows = (previewData.rows || []).map(normalizePreviewRow);
        const totalPages = Math.max(1, Math.ceil(rows.length / PREVIEW_PAGE_SIZE));
        const colCount = previewData.headers.length;

        // Filas de la tabla: cada "padre" lleva data-page; si sus recetas superan
        // el umbral, sus sub-filas nacen ocultas (display:none) detrás de un toggle.
        let bodyRowsHtml = '';
        rows.forEach((row, idx) => {
            const page = Math.floor(idx / PREVIEW_PAGE_SIZE) + 1;
            const groupId = 'g' + idx;
            const hasCollapse = row.recipeCount != null &&
                row.recipeCount > PREVIEW_COLLAPSE_THRESHOLD && row.subRows.length > 0;

            bodyRowsHtml += `<tr class="pb-row" data-page="${page}">${row.cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>\n`;

            if (hasCollapse) {
                bodyRowsHtml += `<tr class="pb-toggle-row" data-page="${page}" data-group="${groupId}" data-expanded="0">` +
                    `<td colspan="${colCount}" class="pb-toggle-cell">` +
                    `<button type="button" class="pb-toggle-btn" data-group="${groupId}" data-count="${row.recipeCount}">` +
                    `&#9656; View all recipes (${row.recipeCount})</button>` +
                    `</td></tr>\n`;
                row.subRows.forEach((sr) => {
                    bodyRowsHtml += `<tr class="pb-row pb-subrow" data-page="${page}" data-group="${groupId}" style="display:none">${sr.cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>\n`;
                });
            } else {
                row.subRows.forEach((sr) => {
                    bodyRowsHtml += `<tr class="pb-row pb-subrow" data-page="${page}">${sr.cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>\n`;
                });
            }
        });

        const tableHeaders = previewData.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
        const metaLinesHtml = (previewData.metaLines || [])
            .map((l) => `<div class="pb-meta-line">${escapeHtml(l)}</div>`).join('');
        const rowCount = previewData.rowCount != null ? previewData.rowCount : rows.length;

        return `
<div id="pb-preview-root">
<style>${PREVIEW_CSS}</style>
    <div class="pb-topbar">
        <div>
            <div class="pb-report-title">${escapeHtml(previewData.title || entry.name)}</div>
            <div class="pb-report-sub">${escapeHtml(previewData.prebookName || '')}</div>
        </div>
        <span class="pb-chip">${escapeHtml(rowCount)} rows</span>
    </div>

    ${metaLinesHtml ? `<div class="pb-meta-block">${metaLinesHtml}</div>` : ''}

    <div class="pb-download-bar">
        <span class="pb-download-label">Download this report:</span>
        ${downloadButtons || '<span class="pb-muted">No downloadable formats configured for this report.</span>'}
    </div>

    <div class="pb-toolbar">
        <input id="pbSearchBox" class="pb-search-box" type="text" placeholder="Search in table…" autocomplete="off">
    </div>

    <div class="pb-table-wrap">
        <table class="pb-table" id="pbPreviewTable">
            <thead><tr>${tableHeaders}</tr></thead>
            <tbody>
                ${bodyRowsHtml || `<tr><td colspan="${colCount}" class="pb-empty-msg">No data to display for this selection.</td></tr>`}
            </tbody>
        </table>
    </div>

    <div class="pb-pagination" id="pbPagination">
        <button type="button" class="pb-page-btn" id="pbPrevBtn">&#8249; Prev</button>
        <span id="pbPageInfo">Page 1 of ${totalPages}</span>
        <button type="button" class="pb-page-btn" id="pbNextBtn">Next &#8250;</button>
    </div>

    <div class="pb-footer-note">Preebook Reports &middot; previsualizaci&oacute;n embebida</div>
</div>
<script>
(function () {
    var root = document.getElementById('pb-preview-root');
    if (!root) return;
    var totalPages = ${totalPages};
    var currentPage = 1;
    var searching = false;

    function isExpanded(group) {
        var t = root.querySelector('.pb-toggle-row[data-group="' + group + '"]');
        return !!(t && t.getAttribute('data-expanded') === '1');
    }

    function applyPage(page) {
        currentPage = page;
        var rows = root.querySelectorAll('#pbPreviewTable tbody tr[data-page]');
        rows.forEach(function (tr) {
            if (tr.getAttribute('data-page') !== String(page)) { tr.style.display = 'none'; return; }
            if (tr.classList.contains('pb-subrow')) {
                var group = tr.getAttribute('data-group');
                tr.style.display = (group && !isExpanded(group)) ? 'none' : '';
            } else {
                tr.style.display = '';
            }
        });
        var info = document.getElementById('pbPageInfo');
        if (info) info.textContent = 'Page ' + page + ' of ' + totalPages;
        var prev = document.getElementById('pbPrevBtn');
        var next = document.getElementById('pbNextBtn');
        if (prev) prev.disabled = (page <= 1);
        if (next) next.disabled = (page >= totalPages);
    }

    root.querySelectorAll('.pb-toggle-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var group = btn.getAttribute('data-group');
            var count = btn.getAttribute('data-count');
            var toggleRow = root.querySelector('.pb-toggle-row[data-group="' + group + '"]');
            if (!toggleRow) return;
            var expanded = toggleRow.getAttribute('data-expanded') === '1';
            toggleRow.setAttribute('data-expanded', expanded ? '0' : '1');
            btn.innerHTML = (expanded ? '&#9656; Ver todas las recetas (' : '&#9662; Ocultar recetas adicionales (') + count + ')';
            if (!searching) applyPage(currentPage);
        });
    });

    var prevBtn = document.getElementById('pbPrevBtn');
    var nextBtn = document.getElementById('pbNextBtn');
    if (prevBtn) prevBtn.addEventListener('click', function () { if (currentPage > 1) applyPage(currentPage - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { if (currentPage < totalPages) applyPage(currentPage + 1); });

    var searchInput = document.getElementById('pbSearchBox');
    var pagination = document.getElementById('pbPagination');
    if (searchInput) {
        searchInput.addEventListener('input', function () {
            var q = searchInput.value.trim().toLowerCase();
            var rows = root.querySelectorAll('#pbPreviewTable tbody tr[data-page]');
            if (!q) {
                searching = false;
                if (pagination) pagination.style.display = '';
                applyPage(currentPage || 1);
                return;
            }
            searching = true;
            if (pagination) pagination.style.display = 'none';
            rows.forEach(function (tr) {
                tr.style.display = (tr.textContent.toLowerCase().indexOf(q) !== -1) ? '' : 'none';
            });
        });
    }

    // Reusa el form NATIVO de NetSuite (main_form) para descargar: setea el
    // campo oculto de acción a "generate" y el campo oculto del formato elegido,
    // y envía el form tal cual — handleGenerate() del server no cambia en nada.
    window.pbDownload = function (formatValue) {
        var actionEl = document.getElementById('${FLD_ACTION}');
        var formatEl = document.getElementById('${formatFieldId}');
        if (actionEl) actionEl.value = '${ACTION_GENERATE}';
        if (formatEl) formatEl.value = formatValue;
        var f = (typeof document !== 'undefined') ? document.forms['main_form'] : null;
        if (f && typeof f.submit === 'function') f.submit();
    };

    applyPage(1);
})();
</script>`;
    };

    // CSS del preview embebido: namespaced bajo #pb-preview-root para no afectar
    // el resto de la página de NetSuite. Paleta neutra + acento índigo, tipografía
    // del sistema (sin CDN externo), tabla con header sticky y scroll horizontal
    // para reportes anchos (ej. R1 tiene 17 columnas). Sin dependencias JS externas.
    const PREVIEW_CSS = `
        #pb-preview-root {
            --pb-bg: #f4f6f9;
            --pb-card: #ffffff;
            --pb-border: #e2e5eb;
            --pb-text: #1f2430;
            --pb-muted: #6b7280;
            --pb-accent: #4f46e5;
            --pb-accent-dark: #3730a3;
            --pb-excel: #1d7a46;
            --pb-excel-dark: #145c34;
            --pb-pdf: #b91c1c;
            --pb-pdf-dark: #8f1414;
            display: block;
            margin: 14px 0 22px;
            padding: 16px;
            background: var(--pb-bg);
            border: 1px solid var(--pb-border);
            border-radius: 12px;
            color: var(--pb-text);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            font-size: 13px;
        }
        #pb-preview-root * { box-sizing: border-box; }
        #pb-preview-root .pb-topbar {
            display: flex; align-items: center; justify-content: space-between;
            flex-wrap: wrap; gap: 12px; margin-bottom: 12px;
        }
        #pb-preview-root .pb-report-title { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
        #pb-preview-root .pb-report-sub { font-size: 12.5px; color: var(--pb-muted); margin-top: 2px; }
        #pb-preview-root .pb-chip {
            background: #eef2ff; color: var(--pb-accent-dark);
            border: 1px solid #c7d2fe; border-radius: 999px;
            padding: 4px 12px; font-weight: 600; font-size: 12px; white-space: nowrap;
        }
        #pb-preview-root .pb-meta-block {
            background: var(--pb-card); border: 1px solid var(--pb-border);
            border-radius: 10px; padding: 10px 16px; margin-bottom: 12px;
        }
        #pb-preview-root .pb-meta-line { font-size: 12px; color: var(--pb-muted); line-height: 1.6; }
        #pb-preview-root .pb-download-bar {
            display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
            background: var(--pb-card); border: 1px solid var(--pb-border);
            border-radius: 10px; padding: 10px 14px; margin-bottom: 10px;
        }
        #pb-preview-root .pb-download-label { font-weight: 600; margin-right: 4px; }
        #pb-preview-root .pb-muted { color: var(--pb-muted); font-size: 12px; }
        #pb-preview-root .pb-toolbar { margin-bottom: 8px; }
        #pb-preview-root .pb-search-box {
            width: 100%; max-width: 320px; padding: 8px 12px; border-radius: 8px;
            border: 1px solid var(--pb-border); font: inherit; font-size: 12.5px;
            background: var(--pb-card);
        }
        #pb-preview-root .pb-search-box:focus {
            outline: none; border-color: var(--pb-accent); box-shadow: 0 0 0 3px rgba(79,70,229,0.12);
        }
        #pb-preview-root .pb-btn {
            display: inline-flex; align-items: center; justify-content: center;
            border: none; border-radius: 8px; padding: 8px 14px;
            font: inherit; font-size: 12.5px; font-weight: 600;
            cursor: pointer; color: #fff; transition: filter 0.15s ease;
        }
        #pb-preview-root .pb-btn:hover { filter: brightness(1.06); }
        #pb-preview-root .pb-btn-excel { background: linear-gradient(180deg, var(--pb-excel), var(--pb-excel-dark)); }
        #pb-preview-root .pb-btn-pdf   { background: linear-gradient(180deg, var(--pb-pdf), var(--pb-pdf-dark)); }
        #pb-preview-root .pb-table-wrap {
            background: var(--pb-card); border: 1px solid var(--pb-border);
            border-radius: 10px; overflow: auto; max-height: 60vh;
        }
        #pb-preview-root table.pb-table { border-collapse: collapse; width: 100%; min-width: 600px; }
        #pb-preview-root table.pb-table thead th {
            position: sticky; top: 0; z-index: 1; background: #f8f9fc; color: #374151;
            border-bottom: 1px solid var(--pb-border); text-align: left; padding: 8px 9px;
            font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; white-space: nowrap;
        }
        #pb-preview-root table.pb-table td {
            padding: 6px 9px; border-bottom: 1px solid #eef0f4; font-size: 12px; white-space: nowrap;
        }
        #pb-preview-root table.pb-table tbody tr:nth-child(even) { background: #fafbfd; }
        #pb-preview-root table.pb-table tbody tr.pb-row:hover { background: #eef2ff; }
        #pb-preview-root table.pb-table tbody tr.pb-subrow td { color: #4b5563; font-style: italic; }
        #pb-preview-root .pb-toggle-cell { background: #fbfbfe !important; padding: 4px 9px !important; }
        #pb-preview-root .pb-toggle-btn {
            border: none; background: transparent; color: var(--pb-accent);
            font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; padding: 2px 0;
        }
        #pb-preview-root .pb-toggle-btn:hover { text-decoration: underline; }
        #pb-preview-root .pb-empty-msg { color: var(--pb-muted); text-align: center; padding: 20px; font-style: italic; white-space: normal; }
        #pb-preview-root .pb-pagination {
            display: flex; align-items: center; justify-content: center; gap: 12px;
            margin-top: 10px; font-size: 12.5px;
        }
        #pb-preview-root .pb-page-btn {
            border: 1px solid var(--pb-border); background: var(--pb-card); border-radius: 6px;
            padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer;
        }
        #pb-preview-root .pb-page-btn:hover:not(:disabled) { background: #eef0f4; }
        #pb-preview-root .pb-page-btn:disabled { opacity: 0.4; cursor: default; }
        #pb-preview-root .pb-footer-note { margin-top: 12px; font-size: 11px; color: var(--pb-muted); text-align: center; }
    `;

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

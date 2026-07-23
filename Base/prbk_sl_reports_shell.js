/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * SUITELET SHELL — Cascarón dinámico para reportes del Preebook.
 *
 * Arquitectura plugin/registry: este Suitelet NO contiene lógica de reportes.
 * El catálogo vive en `customrecord_sgp_rpt_registry`; cada renglón apunta a
 * una librería (campo libpath) que implementa { getMetadata,
 * getFilterDefinitions, generate, getPreviewData? }. El shell lee el
 * catálogo, pinta el dropdown "Report", pinta los filtros de la librería
 * elegida, y al enviar llama a lib.generate(filterValues).
 *
 * Nuevo reporte: crear su librería (ver prbk_lib_template.js) + un registro
 * en customrecord_sgp_rpt_registry. No requiere tocar este Suitelet.
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
    const FLD_ACTION = 'custpage_action';        // 'load_filters' | 'preview' | 'generate'
    const FLD_FILTER_PREFIX = 'custpage_f_';     // prefijo para campos de filtros dinámicos

    const ACTION_LOAD_FILTERS = 'load_filters';
    const ACTION_GENERATE     = 'generate';
    const ACTION_PREVIEW      = 'preview';

    // Convención: filtros con `previewChoice: true` (ej. formato Excel/PDF) NO
    // se pintan en el form cuando la librería soporta preview — se eligen desde
    // los botones Download Excel/PDF del preview. Ver renderLibrarySection/buildPreviewFragment.

    // -----------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------

    const onRequest = (ctx) => {
        try {
            const reports = loadReportRegistry();
            log.audit('shell.onRequest', `method=${ctx.request.method} reports_active=${reports.length}`);

            if (!reports.length) {
                ctx.response.write(htmlError(
                    'No reports configured',
                    `Create at least one row in the <b>${REGISTRY_RECORD}</b> registry with a valid <b>${REGISTRY_FIELDS.LIBPATH}</b>.`
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

            const entry = reports.find((r) => r.code === selectedReportCode);
            if (!entry) {
                ctx.response.write(htmlError(
                    `Report '${selectedReportCode}' not found`,
                    'It may have been deactivated. Go back to the Suitelet main page.'
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
                        renderForm(ctx, reports, entry, lib, params);
                    }
                } catch (innerEx) {
                    log.error('shell.libraryRun', `${entry.code}: ${innerEx.name} ${innerEx.message}\n${innerEx.stack || ''}`);
                    ctx.response.write(htmlError(
                        `Error in library ${entry.code}`,
                        `${innerEx.name}: ${escapeHtml(innerEx.message)}`
                    ));
                }
            }, (loadErr) => {
                log.error('shell.libraryLoad', `No se pudo cargar ${entry.libpath}: ${loadErr && loadErr.message}`);
                ctx.response.write(htmlError(
                    `Could not load library '${entry.libpath}'`,
                    'Check that the path is correct (no .js extension) and that the file exists in the File Cabinet.'
                ));
            });

        } catch (ex) {
            log.error('shell.onRequest', `${ex.name} ${ex.message}\n${ex.stack || ''}`);
            ctx.response.write(htmlError('Unexpected error in the shell', `${ex.name}: ${escapeHtml(ex.message)}`));
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

        // Client script: refresh server-side al cambiar el dropdown de reporte.
        form.clientScriptModulePath = './prbk_cs_reports_shell.js';

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

        // Si la librería implementa getPreviewData(), el flujo pasa por la
        // pantalla de preview; si no, va directo a generate() (compatibilidad).
        const previewSupported = !!(lib && typeof lib.getPreviewData === 'function');

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

        if (entry && lib) {
            renderLibrarySection(form, entry, lib, params, previewSupported);
            form.addSubmitButton({
                label: previewSupported ? (showingPreview ? 'Refresh Preview' : 'Preview Report') : 'Generate Report'
            });
        } else {
            form.addSubmitButton({ label: 'Continue' });
        }

        // Preview embebido: INLINEHTML con la tabla del reporte, pintado dentro
        // de la MISMA página de NetSuite. Los botones Download reusan el form
        // nativo (custpage_action=generate + custpage_f_<id>=EXCEL|PDF) vía JS,
        // sin <form> anidado.
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

    /** Pinta la sección del reporte: cabecera con descripción + filtros declarados. */
    const renderLibrarySection = (form, entry, lib, params, previewSupported) => {
        const meta = safeCall(() => lib.getMetadata(), {});
        const filters = safeCall(() => lib.getFilterDefinitions(), []) || [];

        const headerHtml = buildHeaderHtml(entry, meta);
        const headerFld = form.addField({
            id: 'custpage_header',
            type: serverWidget.FieldType.INLINEHTML,
            label: ' '
        });
        headerFld.defaultValue = headerHtml;

        // Si soporta preview, los filtros `previewChoice` (ej. formato) se
        // ocultan aquí — se eligen desde los botones de descarga del preview.
        const visibleFilters = previewSupported
            ? filters.filter((def) => !def.previewChoice)
            : filters;

        if (visibleFilters.length) {
            form.addFieldGroup({ id: 'custpage_fg_filters', label: 'Filters' });
            visibleFilters.forEach((def) => {
                const fld = addDynamicField(form, def);
                if (!fld) return;
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

        // Campos HIDDEN reales (no INLINE) para los filtros previewChoice (ej.
        // output_format): fuera de la vista pero parte de main_form, para que
        // los botones Download del preview los seteen por JS antes de enviar.
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
                // Nunca isMandatory=true acá: se llena por JS al hacer clic en
                // Download. Validación real sigue en handleGenerate().
            });
        }
    };

    /** Convierte una definición de filtro de la librería en un campo de form de NetSuite. */
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
        if ((type === 'select' || type === 'multiselect') && def.source) {
            fieldOpts.source = def.source;
        }

        const fld = form.addField(fieldOpts);

        if ((type === 'select' || type === 'multiselect') && Array.isArray(def.options)) {
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

        const filterValues = {};
        filters.forEach((def) => {
            const submitted = params[FLD_FILTER_PREFIX + def.id];
            filterValues[def.id] = submitted == null ? '' : submitted;
        });

        const missing = filters
            .filter((def) => def.mandatory && (filterValues[def.id] === '' || filterValues[def.id] == null))
            .map((def) => def.label || def.id);
        if (missing.length) {
            ctx.response.write(htmlError(
                `Missing required filters`,
                `Please provide: ${missing.map(escapeHtml).join(', ')}`
            ));
            return;
        }

        if (typeof lib.validateFilters === 'function') {
            const result = safeCall(() => lib.validateFilters(filterValues), null);
            if (result && result.valid === false) {
                ctx.response.write(htmlError('Invalid filters', escapeHtml(result.message || '')));
                return;
            }
        }

        log.audit('shell.generate', `${entry.code} filters=${JSON.stringify(filterValues)}`);

        const output = lib.generate(filterValues);
        if (!output) {
            ctx.response.write(htmlError(`Report ${entry.code} returned nothing`, ''));
            return;
        }

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
            `Report ${entry.code} returned an unrecognized output`,
            'Expected { fileObj } or { html }.'
        ));
    };

    // -----------------------------------------------------------------------
    // Preview handler — arma la data y delega en renderForm() para que se
    // pinte EMBEBIDA en la misma página. Solo si la librería implementa
    // getPreviewData(); no genera archivo (eso sigue en handleGenerate()).
    // -----------------------------------------------------------------------

    const handlePreview = (ctx, reports, lib, entry, params) => {
        const filters = safeCall(() => lib.getFilterDefinitions(), []) || [];

        // Los filtros previewChoice (ej. formato) no se piden acá: se eligen
        // en los botones de descarga del preview embebido.
        const filterValues = {};
        filters.forEach((def) => {
            const submitted = params[FLD_FILTER_PREFIX + def.id];
            filterValues[def.id] = submitted == null ? '' : submitted;
        });

        const missing = filters
            .filter((def) => def.mandatory && !def.previewChoice &&
                (filterValues[def.id] === '' || filterValues[def.id] == null))
            .map((def) => def.label || def.id);
        if (missing.length) {
            ctx.response.write(htmlError(
                `Missing required filters`,
                `Please provide: ${missing.map(escapeHtml).join(', ')}`
            ));
            return;
        }

        log.audit('shell.preview', `${entry.code} filters=${JSON.stringify(filterValues)}`);

        const previewData = safeCall(() => lib.getPreviewData(filterValues), null);
        if (!previewData || !Array.isArray(previewData.headers)) {
            ctx.response.write(htmlError(
                `Report ${entry.code} did not return preview data`,
                'Check the script log. getPreviewData() must return at least { headers: [...], rows: [...] }.'
            ));
            return;
        }
        if (!Array.isArray(previewData.rows)) previewData.rows = [];

        const meta = safeCall(() => lib.getMetadata(), {});
        const previewHtml = buildPreviewFragment(entry, meta, filters, filterValues, previewData);

        // Repinta el MISMO form y agrega el fragmento de preview como INLINEHTML.
        renderForm(ctx, reports, entry, lib, params, { previewHtml });
    };

    // Filas "padre" por página (sub-filas de receta viajan con su padre, no cuentan).
    const PREVIEW_PAGE_SIZE = 10;

    // A partir de cuántas recetas se colapsan las sub-filas detrás de un toggle.
    const PREVIEW_COLLAPSE_THRESHOLD = 5;

    /**
     * Normaliza una entrada de previewData.rows a { cells, subRows, recipeCount }.
     * Soporta el formato plano Array<string> (sin sub-filas, ej. R2) y el
     * jerárquico { cells, subRows, recipeCount } (con sub-filas, ej. R1).
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
     * Construye el fragmento HTML embebido (INLINEHTML) del preview: misma
     * estructura de columnas que el Excel, con paginación (PREVIEW_PAGE_SIZE),
     * collapse de sub-filas (PREVIEW_COLLAPSE_THRESHOLD), y botones Download
     * que reusan el form nativo de NetSuite (ver window.pbDownload). Todo el
     * CSS/IDs va namespaced bajo #pb-preview-root.
     */
    const buildPreviewFragment = (entry, meta, filters, filterValues, previewData) => {
        const formatDef = filters.find((def) => def.previewChoice) || null;
        const formatFieldId = formatDef ? (FLD_FILTER_PREFIX + formatDef.id) : '';

        // Un botón por opción del filtro previewChoice, acotado a los formatos
        // que la librería declara soportar (getMetadata().formats).
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

        // Cada fila "padre" lleva data-page + data-group; TODAS sus sub-filas
        // comparten el mismo data-group (con o sin collapse) para que el
        // Search pueda mostrar padre + sub-filas como unidad (ver <script>).
        let bodyRowsHtml = '';
        rows.forEach((row, idx) => {
            const page = Math.floor(idx / PREVIEW_PAGE_SIZE) + 1;
            const groupId = 'g' + idx;
            const hasCollapse = row.recipeCount != null &&
                row.recipeCount > PREVIEW_COLLAPSE_THRESHOLD && row.subRows.length > 0;

            bodyRowsHtml += `<tr class="pb-row" data-page="${page}" data-group="${groupId}">${row.cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>\n`;

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
                    bodyRowsHtml += `<tr class="pb-row pb-subrow" data-page="${page}" data-group="${groupId}">${sr.cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>\n`;
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
        <input id="pbSearchBox" class="pb-search-box" type="text" placeholder="Search by product (column 2)…" autocomplete="off">
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

    <div class="pb-footer-note">Preebook Reports &middot; embedded preview</div>
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
        // Sin toggle-row para este grupo => no es colapsable (recipeCount bajo
        // el umbral); sus sub-filas se consideran "siempre expandidas".
        if (!t) return true;
        return t.getAttribute('data-expanded') === '1';
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
            btn.innerHTML = (expanded ? '&#9656; View all recipes (' : '&#9662; Hide additional recipes (') + count + ')';
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
            var allRows = root.querySelectorAll('#pbPreviewTable tbody tr[data-page]');
            if (!q) {
                searching = false;
                if (pagination) pagination.style.display = '';
                applyPage(currentPage || 1);
                return;
            }
            searching = true;
            if (pagination) pagination.style.display = 'none';

            // Match SOLO contra la 2da columna (índice 1, ej. product code) de
            // filas padre — nunca de sub-filas. Muestra la fila padre COMPLETA
            // junto con todas sus sub-filas (mismo data-group) como unidad.
            var matchedGroups = {};
            allRows.forEach(function (tr) {
                if (!tr.classList.contains('pb-row') || tr.classList.contains('pb-subrow')) return;
                var secondCell = tr.children[1];
                var text = secondCell ? secondCell.textContent.toLowerCase() : '';
                if (text.indexOf(q) !== -1) matchedGroups[tr.getAttribute('data-group')] = true;
            });

            allRows.forEach(function (tr) {
                if (tr.classList.contains('pb-toggle-row')) { tr.style.display = 'none'; return; }
                var group = tr.getAttribute('data-group');
                tr.style.display = (group && matchedGroups[group]) ? '' : 'none';
            });
        });
    }

    // Reusa el form nativo de NetSuite (main_form): setea acción=generate +
    // formato elegido, y envía — handleGenerate() del server no cambia.
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

    // CSS del preview embebido, namespaced bajo #pb-preview-root. Paleta neutra
    // + acento índigo, tipografía del sistema (sin CDN externo), header sticky.
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

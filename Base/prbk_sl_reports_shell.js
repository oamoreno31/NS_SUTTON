/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
    'N/log',
    'N/ui/serverWidget',
    'N/search',
    'N/runtime',
    'N/url'
], (log, serverWidget, search, runtime, url) => {

    const REGISTRY_RECORD = 'customrecord_sgp_rpt_registry';
    const REGISTRY_FIELDS = {
        NAME:        'name',
        CODE:        'custrecord_sgp_rpt_code',
        LIBPATH:     'custrecord_sgp_rpt_libpath',
        ACTIVE:      'custrecord_sgp_rpt_active',
        ORDER:       'custrecord_sgp_rpt_order',
        DESCRIPTION: 'custrecord_sgp_rpt_description'
    };

    const FLD_REPORT = 'custpage_report';
    const FLD_ACTION = 'custpage_action';
    const FLD_FILTER_PREFIX = 'custpage_f_';

    const ACTION_LOAD_FILTERS = 'load_filters';
    const ACTION_GENERATE     = 'generate';
    const ACTION_PREVIEW      = 'preview';

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
                    if (!code || !libpath) return;
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

    const renderForm = (ctx, reports, entry, lib, params, extra) => {
        const form = serverWidget.createForm({ title: 'Preebook Reports' });

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
                    try { fld.defaultValue = submittedVal; } catch (e) {}
                } else if (def.defaultValue !== undefined && def.defaultValue !== null) {
                    try { fld.defaultValue = def.defaultValue; } catch (e) {}
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
            });
        }
    };

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
            } catch (e) {}
        }
        if (def.readonly) {
            fld.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
        }

        return fld;
    };

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

    const handlePreview = (ctx, reports, lib, entry, params) => {
        const filters = safeCall(() => lib.getFilterDefinitions(), []) || [];

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
        const isTabbed = !!(previewData && Array.isArray(previewData.views));
        if (!previewData || (!isTabbed && !Array.isArray(previewData.headers))) {
            ctx.response.write(htmlError(
                `Report ${entry.code} did not return preview data`,
                'Check the script log. getPreviewData() must return at least { headers: [...], rows: [...] } ' +
                'or, for multi-view reports, { views: [{ id, label, headers, rows }, ...] }.'
            ));
            return;
        }
        if (!isTabbed && !Array.isArray(previewData.rows)) previewData.rows = [];

        const meta = safeCall(() => lib.getMetadata(), {});
        const previewHtml = isTabbed
            ? buildTabbedPreviewFragment(entry, meta, filters, filterValues, previewData)
            : buildPreviewFragment(entry, meta, filters, filterValues, previewData);

        renderForm(ctx, reports, entry, lib, params, { previewHtml });
    };

    const PREVIEW_PAGE_SIZE = 10;

    const PREVIEW_COLLAPSE_THRESHOLD = 5;

    const normalizePreviewRow = (row) => {
        if (Array.isArray(row)) {
            return { cells: row, subRows: [], visibleSubRows: [], recipeCount: null, subTotalUnits: undefined };
        }
        const mapSr = (sr) => (Array.isArray(sr)
            ? { cells: sr, subTotalUnits: undefined }
            : { cells: sr.cells || [], subTotalUnits: sr.subTotalUnits });
        return {
            cells: row.cells || [],
            subRows: Array.isArray(row.subRows) ? row.subRows.map(mapSr) : [],
            visibleSubRows: Array.isArray(row.visibleSubRows) ? row.visibleSubRows.map(mapSr) : [],
            recipeCount: row.recipeCount != null ? row.recipeCount : null,
            subTotalUnits: row.subTotalUnits
        };
    };

    const buildPreviewFragment = (entry, meta, filters, filterValues, previewData) => {
        const formatDef = filters.find((def) => def.previewChoice) || null;
        const formatFieldId = formatDef ? (FLD_FILTER_PREFIX + formatDef.id) : '';

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

        const hasSubTotalUnits = 0;
        const effectiveColCount = colCount + (hasSubTotalUnits ? 1 : 0);
        const subTotalCell = (v) => `<td class="pb-subtotal-col">${escapeHtml(v != null ? v : '')}</td>`;

        let bodyRowsHtml = '';
        rows.forEach((row, idx) => {
            const page = Math.floor(idx / PREVIEW_PAGE_SIZE) + 1;
            const groupId = 'g' + idx;
            const hasCollapse = row.recipeCount != null &&
                row.recipeCount > PREVIEW_COLLAPSE_THRESHOLD && row.subRows.length > 0;
            const rowSubTotalHtml = hasSubTotalUnits ? subTotalCell(row.subTotalUnits) : '';

            bodyRowsHtml += `<tr class="pb-row" data-page="${page}" data-group="${groupId}">${row.cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}${rowSubTotalHtml}</tr>\n`;

            row.visibleSubRows.forEach((sr) => {
                const srSubTotalHtml = hasSubTotalUnits ? subTotalCell(sr.subTotalUnits) : '';
                bodyRowsHtml += `<tr class="pb-row pb-subrow" data-page="${page}" data-group="${groupId}">${sr.cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}${srSubTotalHtml}</tr>\n`;
            });

            if (hasCollapse) {
                const moreCount = row.subRows.length;
                bodyRowsHtml += `<tr class="pb-toggle-row" data-page="${page}" data-group="${groupId}" data-expanded="0">` +
                    `<td colspan="${effectiveColCount}" class="pb-toggle-cell">` +
                    `<button type="button" class="pb-toggle-btn" data-group="${groupId}" data-count="${moreCount}">` +
                    `&#9656; View ${moreCount} more recipe${moreCount === 1 ? '' : 's'}</button>` +
                    `</td></tr>\n`;
                row.subRows.forEach((sr) => {
                    const srSubTotalHtml = hasSubTotalUnits ? subTotalCell(sr.subTotalUnits) : '';
                    bodyRowsHtml += `<tr class="pb-row pb-subrow pb-collapsible" data-page="${page}" data-group="${groupId}" style="display:none">${sr.cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}${srSubTotalHtml}</tr>\n`;
                });
            } else if (row.subRows.length > 0) {
                row.subRows.forEach((sr) => {
                    const srSubTotalHtml = hasSubTotalUnits ? subTotalCell(sr.subTotalUnits) : '';
                    bodyRowsHtml += `<tr class="pb-row pb-subrow" data-page="${page}" data-group="${groupId}">${sr.cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}${srSubTotalHtml}</tr>\n`;
                });
            }
        });

        const tableHeaders = previewData.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('') +
            (hasSubTotalUnits ? '<th class="pb-subtotal-col">SUB TOTAL UNITS</th>' : '');
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
        ${hasSubTotalUnits ? '<label class="pb-subtotal-toggle"><input type="checkbox" id="pbSubTotalToggle"> See all sub total units</label>' : ''}
    </div>

    <div class="pb-table-wrap">
        <table class="pb-table" id="pbPreviewTable">
            <thead><tr>${tableHeaders}</tr></thead>
            <tbody>
                ${bodyRowsHtml || `<tr><td colspan="${effectiveColCount}" class="pb-empty-msg">No data to display for this selection.</td></tr>`}
            </tbody>
        </table>
    </div>

    <div class="pb-pagination" id="pbPagination">
        <button type="button" class="pb-page-btn" id="pbPrevBtn">&#8249; Prev</button>
        <span id="pbPageInfo">Page 1 of ${totalPages}</span>
        <button type="button" class="pb-page-btn" id="pbNextBtn">Next &#8250;</button>
    </div>

    <div class="pb-footer-note">Preebook Reports</div>
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
        if (!t) return true;
        return t.getAttribute('data-expanded') === '1';
    }

    function applyPage(page) {
        currentPage = page;
        var rows = root.querySelectorAll('#pbPreviewTable tbody tr[data-page]');
        rows.forEach(function (tr) {
            if (tr.getAttribute('data-page') !== String(page)) { tr.style.display = 'none'; return; }
            if (tr.classList.contains('pb-collapsible')) {
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
            var wasExpanded = toggleRow.getAttribute('data-expanded') === '1';
            var nowExpanded = !wasExpanded;
            toggleRow.setAttribute('data-expanded', nowExpanded ? '1' : '0');
            var plural = (count === '1') ? '' : 's';
            btn.innerHTML = (wasExpanded ? '&#9656; View ' : '&#9662; Hide ') + count + ' more recipe' + plural;
            if (searching) {
                root.querySelectorAll('.pb-collapsible[data-group="' + group + '"]').forEach(function (sr) {
                    sr.style.display = nowExpanded ? '' : 'none';
                });
            } else {
                applyPage(currentPage);
            }
        });
    });

    var subtotalToggle = document.getElementById('pbSubTotalToggle');
    if (subtotalToggle) {
        subtotalToggle.addEventListener('change', function () {
            root.classList.toggle('pb-show-subtotal', subtotalToggle.checked);
        });
    }

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

            var matchedGroups = {};
            allRows.forEach(function (tr) {
                if (!tr.classList.contains('pb-row') || tr.classList.contains('pb-subrow')) return;
                var secondCell = tr.children[1];
                var text = secondCell ? secondCell.textContent.toLowerCase() : '';
                if (text.indexOf(q) !== -1) matchedGroups[tr.getAttribute('data-group')] = true;
            });

            allRows.forEach(function (tr) {
                var group = tr.getAttribute('data-group');
                var groupMatched = !!(group && matchedGroups[group]);
                if (tr.classList.contains('pb-collapsible')) {
                    tr.style.display = (groupMatched && isExpanded(group)) ? '' : 'none';
                } else {
                    tr.style.display = groupMatched ? '' : 'none';
                }
            });
        });
    }

    window.pbDownload = function (formatValue) {
        var actionEl = document.getElementById('${FLD_ACTION}');
        var formatEl = document.getElementById('${formatFieldId}');
        var f = (typeof document !== 'undefined') ? document.forms['main_form'] : null;
        if (actionEl) actionEl.value = '${ACTION_GENERATE}';
        if (formatEl) formatEl.value = formatValue;
        if (f) {
            var prevTarget = f.target;
            f.target = '_blank';
            if (typeof f.submit === 'function') f.submit();
            f.target = prevTarget || '';
        }
        if (actionEl) actionEl.value = '${ACTION_PREVIEW}';
    };

    applyPage(1);
})();
</script>`;
    };

    const SECTION_MARKER = '§SECTION§';
    const COUNT_MARKER = '§N§';

    const buildTabbedPreviewFragment = (entry, meta, filters, filterValues, previewData) => {
        const formatDef = filters.find((def) => def.id === 'output_format' && def.previewChoice) || null;
        const formatFieldId = formatDef ? (FLD_FILTER_PREFIX + formatDef.id) : '';
        const viewDef = filters.find((def) => def.id === 'view' && def.previewChoice) || null;
        const viewFieldId = viewDef ? (FLD_FILTER_PREFIX + viewDef.id) : '';

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

        const views = (previewData.views || []).filter((v) => v && Array.isArray(v.headers));
        const tabButtonsHtml = views.map((v, idx) =>
            `<button type="button" class="pb-tab-btn${idx === 0 ? ' pb-tab-active' : ''}" data-view="${escapeHtml(v.id)}" onclick="pbSwitchView('${escapeHtml(v.id)}')">${escapeHtml(v.label || v.id)}</button>`
        ).join('\n');

        const PREVIEW_PAGE_SIZE_TAB = 15;

        const panelsHtml = views.map((v, idx) => {
            const rows = Array.isArray(v.rows) ? v.rows : [];
            const colCount = v.headers.length;
            const isMain = idx === 0;
            const totalPages = isMain ? Math.max(1, Math.ceil(rows.length / PREVIEW_PAGE_SIZE_TAB)) : 1;

            let groupIdx = -1;
            let currentGroupId = null;
            let groupCount = 0;
            const rowsHtml = rows.map((cells, rIdx) => {
                const page = isMain ? (Math.floor(rIdx / PREVIEW_PAGE_SIZE_TAB) + 1) : 1;
                const first = Array.isArray(cells) && typeof cells[0] === 'string' ? cells[0] : '';
                const isSection = first.indexOf(SECTION_MARKER) === 0;
                if (isSection) {
                    groupIdx++;
                    groupCount++;
                    currentGroupId = 'grp-' + escapeHtml(v.id) + '-' + groupIdx;
                    const rest = first.slice(SECTION_MARKER.length);
                    const countIdx = rest.indexOf(COUNT_MARKER);
                    const label = countIdx === -1 ? rest : rest.slice(0, countIdx);
                    const count = countIdx === -1 ? '' : rest.slice(countIdx + COUNT_MARKER.length);
                    const countTxt = count !== '' ? ` (${count} item${count === '1' ? '' : 's'})` : '';
                    return `<tr class="pb-row pb-section-row" data-page="${page}" data-group="${currentGroupId}" data-expanded="0">` +
                        `<td colspan="${colCount}"><button type="button" class="pb-section-toggle" data-view="${escapeHtml(v.id)}" data-group="${currentGroupId}">` +
                        `<span class="pb-section-arrow">&#9656;</span> ${escapeHtml(label)}${countTxt}</button></td></tr>`;
                }
                const groupAttr = currentGroupId ? ` data-group="${currentGroupId}" class="pb-row pb-groupdata" style="display:none"` : ' class="pb-row"';
                return `<tr${groupAttr} data-page="${page}">${(cells || []).map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
            }).join('\n');

            const headHtml = v.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
            const hasGroups = groupCount > 0;

            return `
    <div class="pb-view-panel" data-view="${escapeHtml(v.id)}" style="${idx === 0 ? '' : 'display:none'}">
        <div class="pb-toolbar">
            <input class="pb-search-box pb-view-search" data-view="${escapeHtml(v.id)}" type="text" placeholder="Search by product code…" autocomplete="off">
            <span class="pb-chip">${escapeHtml(v.rowCount != null ? v.rowCount : rows.length)} rows${hasGroups ? ` &middot; ${groupCount} groups` : ''}</span>
            ${hasGroups ? `
            <button type="button" class="pb-page-btn pb-group-expand-all" data-view="${escapeHtml(v.id)}">Expand all</button>
            <button type="button" class="pb-page-btn pb-group-collapse-all" data-view="${escapeHtml(v.id)}">Collapse all</button>` : ''}
        </div>
        <div class="pb-table-wrap">
            <table class="pb-table pb-view-table" data-view="${escapeHtml(v.id)}">
                <thead><tr>${headHtml}</tr></thead>
                <tbody>
                    ${rowsHtml || `<tr><td colspan="${colCount}" class="pb-empty-msg">No data to display for this selection.</td></tr>`}
                </tbody>
            </table>
        </div>
        ${isMain ? `
        <div class="pb-pagination pb-view-pagination" data-view="${escapeHtml(v.id)}">
            <button type="button" class="pb-page-btn pb-view-prev" data-view="${escapeHtml(v.id)}">&#8249; Prev</button>
            <span class="pb-view-pageinfo" data-view="${escapeHtml(v.id)}">Page 1 of ${totalPages}</span>
            <button type="button" class="pb-page-btn pb-view-next" data-view="${escapeHtml(v.id)}">Next &#8250;</button>
        </div>` : ''}
    </div>`;
        }).join('\n');

        const metaLinesHtml = (previewData.metaLines || [])
            .map((l) => `<div class="pb-meta-line">${escapeHtml(l)}</div>`).join('');

        return `
<div id="pb-preview-root">
<style>${PREVIEW_CSS}${TAB_CSS}</style>
    <div class="pb-topbar">
        <div>
            <div class="pb-report-title">${escapeHtml(previewData.title || entry.name)}</div>
            <div class="pb-report-sub">${escapeHtml(previewData.prebookName || '')}</div>
        </div>
    </div>

    ${metaLinesHtml ? `<div class="pb-meta-block">${metaLinesHtml}</div>` : ''}

    <div class="pb-download-bar">
        <span class="pb-download-label">Download this view:</span>
        ${downloadButtons || '<span class="pb-muted">No downloadable formats configured for this report.</span>'}
    </div>

    <div class="pb-tabbar">${tabButtonsHtml}</div>

    ${panelsHtml}

    <div class="pb-footer-note">Preebook Reports &middot; embedded preview</div>
</div>
<script>
(function () {
    var root = document.getElementById('pb-preview-root');
    if (!root) return;
    var pageState = {};

    function getRows(viewId) {
        return root.querySelectorAll('.pb-view-table[data-view="' + viewId + '"] tbody tr[data-page]');
    }

    function applyPage(viewId, page) {
        var table = root.querySelector('.pb-view-table[data-view="' + viewId + '"]');
        if (!table) return;
        var totalPages = Number(table.getAttribute('data-total-pages')) ||
            (function () {
                var maxPage = 1;
                getRows(viewId).forEach(function (tr) {
                    var p = Number(tr.getAttribute('data-page')) || 1;
                    if (p > maxPage) maxPage = p;
                });
                return maxPage;
            })();
        pageState[viewId] = pageState[viewId] || {};
        pageState[viewId].page = page;
        getRows(viewId).forEach(function (tr) {
            tr.style.display = (tr.getAttribute('data-page') === String(page)) ? '' : 'none';
        });
        var info = root.querySelector('.pb-view-pageinfo[data-view="' + viewId + '"]');
        if (info) info.textContent = 'Page ' + page + ' of ' + totalPages;
        var prev = root.querySelector('.pb-view-prev[data-view="' + viewId + '"]');
        var next = root.querySelector('.pb-view-next[data-view="' + viewId + '"]');
        if (prev) prev.disabled = (page <= 1);
        if (next) next.disabled = (page >= totalPages);
    }

    root.querySelectorAll('.pb-view-pagination').forEach(function (pag) {
        var viewId = pag.getAttribute('data-view');
        applyPage(viewId, 1);
    });

    root.querySelectorAll('.pb-view-prev').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var viewId = btn.getAttribute('data-view');
            var cur = (pageState[viewId] && pageState[viewId].page) || 1;
            if (cur > 1) applyPage(viewId, cur - 1);
        });
    });
    root.querySelectorAll('.pb-view-next').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var viewId = btn.getAttribute('data-view');
            var cur = (pageState[viewId] && pageState[viewId].page) || 1;
            var info = root.querySelector('.pb-view-pageinfo[data-view="' + viewId + '"]');
            var totalPages = info ? Number(info.textContent.replace(/^.*of\\s*/, '')) : 1;
            if (cur < totalPages) applyPage(viewId, cur + 1);
        });
    });

    function setGroupExpanded(viewId, groupId, expanded) {
        var sectionRow = root.querySelector('.pb-section-row[data-group="' + groupId + '"]');
        if (!sectionRow) return;
        sectionRow.setAttribute('data-expanded', expanded ? '1' : '0');
        var arrow = sectionRow.querySelector('.pb-section-arrow');
        if (arrow) arrow.innerHTML = expanded ? '&#9662;' : '&#9656;';
        root.querySelectorAll('.pb-groupdata[data-group="' + groupId + '"]').forEach(function (tr) {
            tr.style.display = expanded ? '' : 'none';
        });
    }

    function restoreGroupState(viewId) {
        root.querySelectorAll('.pb-view-table[data-view="' + viewId + '"] .pb-section-row').forEach(function (sec) {
            sec.style.display = '';
            var groupId = sec.getAttribute('data-group');
            var expanded = sec.getAttribute('data-expanded') === '1';
            root.querySelectorAll('.pb-groupdata[data-group="' + groupId + '"]').forEach(function (tr) {
                tr.style.display = expanded ? '' : 'none';
            });
        });
    }

    root.querySelectorAll('.pb-section-toggle').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var viewId = btn.getAttribute('data-view');
            var groupId = btn.getAttribute('data-group');
            var sectionRow = root.querySelector('.pb-section-row[data-group="' + groupId + '"]');
            var expanded = sectionRow && sectionRow.getAttribute('data-expanded') === '1';
            setGroupExpanded(viewId, groupId, !expanded);
        });
    });

    root.querySelectorAll('.pb-group-expand-all').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var viewId = btn.getAttribute('data-view');
            root.querySelectorAll('.pb-view-table[data-view="' + viewId + '"] .pb-section-row').forEach(function (sec) {
                setGroupExpanded(viewId, sec.getAttribute('data-group'), true);
            });
        });
    });
    root.querySelectorAll('.pb-group-collapse-all').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var viewId = btn.getAttribute('data-view');
            root.querySelectorAll('.pb-view-table[data-view="' + viewId + '"] .pb-section-row').forEach(function (sec) {
                setGroupExpanded(viewId, sec.getAttribute('data-group'), false);
            });
        });
    });

    root.querySelectorAll('.pb-view-search').forEach(function (input) {
        var viewId = input.getAttribute('data-view');
        var isGrouped = !!root.querySelector('.pb-view-table[data-view="' + viewId + '"] .pb-section-row');
        input.addEventListener('input', function () {
            var q = input.value.trim().toLowerCase();
            var pagination = root.querySelector('.pb-view-pagination[data-view="' + viewId + '"]');
            if (!q) {
                if (pagination) pagination.style.display = '';
                if (isGrouped) {
                    restoreGroupState(viewId);
                } else {
                    var cur = (pageState[viewId] && pageState[viewId].page) || 1;
                    applyPage(viewId, cur);
                }
                return;
            }
            if (pagination) pagination.style.display = 'none';
            getRows(viewId).forEach(function (tr) {
                if (tr.classList.contains('pb-section-row')) { tr.style.display = ''; return; }
                var secondCell = tr.children[1];
                var text = secondCell ? secondCell.textContent.toLowerCase() : '';
                tr.style.display = (text.indexOf(q) !== -1) ? '' : 'none';
            });
        });
    });

    window.pbSwitchView = function (viewId) {
        root.querySelectorAll('.pb-view-panel').forEach(function (p) {
            p.style.display = (p.getAttribute('data-view') === viewId) ? '' : 'none';
        });
        root.querySelectorAll('.pb-tab-btn').forEach(function (b) {
            b.classList.toggle('pb-tab-active', b.getAttribute('data-view') === viewId);
        });
        window.__pbActiveView = viewId;
    };
    window.__pbActiveView = ${views.length ? `'${views[0].id}'` : 'null'};

    window.pbDownload = function (formatValue) {
        var actionEl = document.getElementById('${FLD_ACTION}');
        var formatEl = document.getElementById('${formatFieldId}');
        var viewEl = ${viewFieldId ? `document.getElementById('${viewFieldId}')` : 'null'};
        var f = (typeof document !== 'undefined') ? document.forms['main_form'] : null;
        if (actionEl) actionEl.value = '${ACTION_GENERATE}';
        if (formatEl) formatEl.value = formatValue;
        if (viewEl && window.__pbActiveView) viewEl.value = window.__pbActiveView;
        if (f) {
            var prevTarget = f.target;
            f.target = '_blank';
            if (typeof f.submit === 'function') f.submit();
            f.target = prevTarget || '';
        }
        if (actionEl) actionEl.value = '${ACTION_PREVIEW}';
    };
})();
</script>`;
    };

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
        #pb-preview-root .pb-toolbar {
            display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 8px;
        }
        #pb-preview-root .pb-search-box {
            width: 100%; max-width: 320px; padding: 8px 12px; border-radius: 8px;
            border: 1px solid var(--pb-border); font: inherit; font-size: 12.5px;
            background: var(--pb-card);
        }
        #pb-preview-root .pb-search-box:focus {
            outline: none; border-color: var(--pb-accent); box-shadow: 0 0 0 3px rgba(79,70,229,0.12);
        }
        #pb-preview-root .pb-subtotal-toggle {
            display: inline-flex; align-items: center; gap: 6px;
            font-size: 12.5px; color: var(--pb-text); cursor: pointer; user-select: none;
        }
        #pb-preview-root .pb-subtotal-toggle input { cursor: pointer; }
        #pb-preview-root .pb-subtotal-col { display: none; }
        #pb-preview-root.pb-show-subtotal .pb-subtotal-col { display: table-cell; }
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

    const TAB_CSS = `
        #pb-preview-root .pb-tabbar {
            display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px;
        }
        #pb-preview-root .pb-tab-btn {
            border: 1px solid var(--pb-border); background: var(--pb-card); color: var(--pb-text);
            border-radius: 8px 8px 0 0; padding: 8px 16px; font: inherit; font-size: 12.5px;
            font-weight: 600; cursor: pointer;
        }
        #pb-preview-root .pb-tab-btn:hover { background: #eef0f4; }
        #pb-preview-root .pb-tab-btn.pb-tab-active {
            background: var(--pb-accent); color: #fff; border-color: var(--pb-accent);
        }
        #pb-preview-root .pb-view-panel { margin-top: 4px; }
        #pb-preview-root tr.pb-section-row td {
            background: #eef0f4; padding: 0; white-space: normal;
        }
        #pb-preview-root .pb-section-toggle {
            display: block; width: 100%; text-align: left; border: none; background: transparent;
            cursor: pointer; font: inherit; font-size: 12px; font-weight: 700; color: var(--pb-text);
            padding: 7px 9px;
        }
        #pb-preview-root .pb-section-toggle:hover { background: #e4e7ee; }
        #pb-preview-root .pb-section-arrow {
            display: inline-block; width: 12px; color: var(--pb-accent); font-size: 10px;
        }
        #pb-preview-root .pb-group-expand-all,
        #pb-preview-root .pb-group-collapse-all { font-size: 11.5px; padding: 6px 10px; }
    `;

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

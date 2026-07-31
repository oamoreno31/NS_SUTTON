/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
// Helpers compartidos (BOM, inventario, POs, UOM, render PDF) para las libs de reporte R1-R4.
define([
    'N/search',
    'N/record',
    'N/render',
    'N/log',
    'N/format'
], (search, record, render, log, format) => {

    // BOM — componentes del BOM default de un assembly.

    // Devuelve, por assembly item, sus componentes del BOM marcado default.
    const loadAssemblyBoms = (assemblyItemIds) => {
        const ids = Array.from(new Set((assemblyItemIds || []).filter(Boolean).map(String)));
        if (!ids.length) return {};

        const assemblyCol = search.createColumn({ name: 'assembly', join: 'billofmaterials', label: 'ASSEMBLY' });
        const rawCol = search.createColumn({ name: 'item', join: 'component', label: 'RAW_ITEM' });
        const qtyCol = search.createColumn({ name: 'bomquantity', join: 'component', label: 'QTY' });
        const uomCol = search.createColumn({ name: 'units', join: 'component', label: 'UOM' });
        const effCol = search.createColumn({ name: 'effectivestartdate', sort: search.Sort.DESC, label: 'EFF' });

        const compSearch = search.create({
            type: 'bomrevision',
            filters: [
                ['billofmaterials.assembly', 'anyof', ids], 'AND',
                ['billofmaterials.isdefault', 'is', 'T'], 'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: [assemblyCol, rawCol, qtyCol, uomCol, effCol]
        });

        // Ordenado DESC por fecha: la primera ocurrencia (assembly, raw) es la revisión más reciente.
        const result = {};
        const seen = {};   // `${assemblyId}|${rawId}` -> true
        const paged = compSearch.runPaged({ pageSize: 1000 });
        paged.pageRanges.forEach((pr) => {
            paged.fetch({ index: pr.index }).data.forEach((r) => {
                const assemblyId = r.getValue(assemblyCol);
                const rawId = r.getValue(rawCol);
                const qty = Number(r.getValue(qtyCol)) || 0;
                const uom = r.getValue(uomCol);

                if (!assemblyId || !rawId || !qty) return;
                const k = `${assemblyId}|${rawId}`;
                if (seen[k]) return;
                seen[k] = true;

                if (!result[assemblyId]) result[assemblyId] = [];
                result[assemblyId].push({ rawId: String(rawId), qty: qty, unitsType: uom });
            });
        });

        return result;
    };

    // Inventario on hand (todas las locations).

    // Suma el on-hand de cada item entre todas las locations.
    const getOnHandAllLocations = (itemIds) => {
        const ids = Array.from(new Set((itemIds || []).filter(Boolean).map(String)));
        if (!ids.length) return {};

        const s = search.create({
            type: search.Type.ITEM,
            filters: [['internalid', 'anyof', ids]],
            columns: [
                search.createColumn({
                    name: 'internalid',
                    summary: search.Summary.GROUP
                }),
                search.createColumn({
                    name: 'locationquantityonhand',
                    summary: search.Summary.SUM,
                    label: 'OH_ALL_LOC'
                })
            ]
        });

        const map = {};
        const paged = s.runPaged({ pageSize: 1000 });
        paged.pageRanges.forEach((pr) => {
            paged.fetch({ index: pr.index }).data.forEach((r) => {
                const id = r.getValue({ name: 'internalid', summary: search.Summary.GROUP });
                const oh = Number(r.getValue({ name: 'locationquantityonhand', summary: search.Summary.SUM })) || 0;
                if (id) map[id] = oh;
            });
        });
        return map;
    };

    // Purchase Orders — recibido / en tránsito, filtrado por custbody_sgp_report_id.

    // Suma cantidad recibida o en tránsito de PO lines de este Prebook.
    const getPoQty = (rawItemIds, prebookId, mode) => {
        const ids = Array.from(new Set((rawItemIds || []).filter(Boolean).map(String)));
        if (!ids.length || !prebookId) return {};

        const isReceived = (mode === 'received');

        const itemCol = search.createColumn({
            name: 'item',
            summary: search.Summary.GROUP,
            label: 'ITEM'
        });

        const qtyCol = isReceived
            ? search.createColumn({
                name: 'quantityreceived',
                summary: search.Summary.SUM,
                label: 'QTY'
            })
            : search.createColumn({
                name: 'formulanumeric',
                formula: 'NVL({quantity},0) - NVL({quantityreceived},0)',
                summary: search.Summary.SUM,
                label: 'QTY'
            });

        const s = search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['type', 'anyof', 'PurchOrd'], 'AND',
                ['mainline', 'is', 'F'], 'AND',
                ['custbody_sgp_report_id', 'anyof', String(prebookId)], 'AND',
                ['item', 'anyof', ids]
            ],
            columns: [itemCol, qtyCol]
        });

        const map = {};
        const paged = s.runPaged({ pageSize: 1000 });
        paged.pageRanges.forEach((pr) => {
            paged.fetch({ index: pr.index }).data.forEach((r) => {
                const id = r.getValue(itemCol);
                const q = Number(r.getValue(qtyCol)) || 0;
                if (id) map[id] = (map[id] || 0) + q;
            });
        });
        return map;
    };

    // UOM conversions — heurística Stem / Bunch / Case.

    // Detecta stemsPerBunch y bunchesPerCase de cada item vía su unitstype.
    const getUomConversions = (rawItemIds) => {
        const ids = Array.from(new Set((rawItemIds || []).filter(Boolean).map(String)));
        if (!ids.length) return {};

        // 1. Para cada item, obtener su unitstype e info adicional.
        const itemUomSearch = search.create({
            type: search.Type.ITEM,
            filters: [['internalid', 'anyof', ids]],
            columns: [
                search.createColumn({ name: 'internalid', label: 'ITEM' }),
                search.createColumn({ name: 'unitstype', label: 'UOM_TYPE' }),
                search.createColumn({ name: 'baseunit', label: 'BASE_UNIT' }),
                search.createColumn({ name: 'custitem_sgp_packing', label: 'PACK' })
            ]
        });

        const itemMeta = {};   // itemId -> { uomTypeId, baseUnitId, packing }
        const uomTypeIds = new Set();

        itemUomSearch.run().each((r) => {
            const itemId = r.getValue({ name: 'internalid' });
            const uomTypeId = r.getValue({ name: 'unitstype' });
            const baseUnitId = r.getValue({ name: 'baseunit' });
            const packing = r.getValue({ name: 'custitem_sgp_packing' });
            itemMeta[itemId] = { uomTypeId, baseUnitId, packing };
            if (uomTypeId) uomTypeIds.add(uomTypeId);
            return true;
        });

        // 2. Cargar cada unitstype involucrado con sus filas de uom (unitname/conversionrate/baseunit).
        const uomTypeMap = {};   // uomTypeId -> { rows: [{unitId, name, conversionrate, isBase}] }
        Array.from(uomTypeIds).forEach((utid) => {
            try {
                const rec = record.load({ type: 'unitstype', id: utid });
                const lineCount = rec.getLineCount({ sublistId: 'uom' });
                const rows = [];
                for (let i = 0; i < lineCount; i++) {
                    rows.push({
                        unitId: rec.getSublistValue({ sublistId: 'uom', fieldId: 'internalid', line: i }),
                        name: String(rec.getSublistValue({ sublistId: 'uom', fieldId: 'unitname', line: i }) || '').trim(),
                        plural: String(rec.getSublistValue({ sublistId: 'uom', fieldId: 'pluralname', line: i }) || '').trim(),
                        abbr: String(rec.getSublistValue({ sublistId: 'uom', fieldId: 'abbreviation', line: i }) || '').trim(),
                        conversionrate: Number(rec.getSublistValue({ sublistId: 'uom', fieldId: 'conversionrate', line: i })) || 0,
                        isBase: !!rec.getSublistValue({ sublistId: 'uom', fieldId: 'baseunit', line: i })
                    });
                }
                uomTypeMap[utid] = { rows };
            } catch (e) {
                log.error('getUomConversions.loadUomType', `Falló load unitstype ${utid}: ${e.message}`);
            }
        });

        // 3. Heurística para identificar stem / bunch / case por nombre.
        const matchUnit = (rows, patterns) => {
            const lowerPats = patterns.map((p) => p.toLowerCase());
            return rows.find((row) => {
                const blob = `${row.name} ${row.plural} ${row.abbr}`.toLowerCase();
                return lowerPats.some((p) => blob.includes(p));
            });
        };

        const STEM_PATTERNS = ['stem', 'stm'];
        const BUNCH_PATTERNS = ['bunch', 'bnch', 'bch'];
        const CASE_PATTERNS = ['case', 'carton', 'ctn', 'box', 'pack'];

        // 4. Por cada item, resolver stemsPerBunch y bunchesPerCase.
        const out = {};
        Object.keys(itemMeta).forEach((itemId) => {
            const meta = itemMeta[itemId];
            const uomEntry = uomTypeMap[meta.uomTypeId];
            const result = {
                stemsPerBunch: 1,
                bunchesPerCase: Number(meta.packing) || 1,
                source: 'fallback'
            };

            if (uomEntry && uomEntry.rows.length) {
                const stem = matchUnit(uomEntry.rows, STEM_PATTERNS);
                const bunch = matchUnit(uomEntry.rows, BUNCH_PATTERNS);
                const cs = matchUnit(uomEntry.rows, CASE_PATTERNS);

                // conversionrate relativo: stemsPerBunch = bunch.cr / stem.cr; bunchesPerCase = case.cr / bunch.cr.
                if (stem && bunch && stem.conversionrate > 0) {
                    result.stemsPerBunch = bunch.conversionrate / stem.conversionrate;
                }
                if (bunch && cs && bunch.conversionrate > 0) {
                    result.bunchesPerCase = cs.conversionrate / bunch.conversionrate;
                }
                result.source = 'uomTable';
                result.detected = {
                    stem: stem ? stem.name : null,
                    bunch: bunch ? bunch.name : null,
                    case: cs ? cs.name : null
                };
            }

            // Saneo: nunca dividir por 0.
            if (!result.stemsPerBunch || result.stemsPerBunch <= 0) result.stemsPerBunch = 1;
            if (!result.bunchesPerCase || result.bunchesPerCase <= 0) result.bunchesPerCase = Number(meta.packing) || 1;

            out[itemId] = result;
        });

        return out;
    };

    // Render PDF — wrapper de N/render consistente con el patrón del Suitelet 3856.

    // Renderiza un Advanced PDF Template con el record del Prebook + datos JSON.
    const renderPdf = (opts) => {
        const renderer = render.create();
        renderer.setTemplateById(opts.templateId);

        const preBookObj = record.load({
            type: 'customrecord_sgp_prebook',
            id: opts.prebookId
        });
        renderer.addRecord('record', preBookObj);

        renderer.addCustomDataSource({
            format: render.DataSource.JSON,
            alias: 'data',
            data: JSON.stringify(opts.data)
        });

        const pdfFile = renderer.renderAsPdf();
        if (opts.filename) pdfFile.name = opts.filename;
        return pdfFile;
    };

    // Helpers varios.

    const escapeXml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const ceilSafe = (n) => {
        const v = Number(n);
        if (!isFinite(v) || v <= 0) return 0;
        return Math.ceil(v);
    };

    return {
        loadAssemblyBoms,
        getOnHandAllLocations,
        getPoQty,
        getUomConversions,
        renderPdf,
        escapeXml,
        ceilSafe
    };
});
